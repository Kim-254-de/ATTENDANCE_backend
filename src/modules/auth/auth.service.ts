import { isUniqueViolation } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { hashPassword, verifyPassword } from '../../common/utils/password.js';
import { hashToken } from '../../common/utils/tokens.js';
import { erpClient } from '../../integrations/erp/index.js';
import type { ErpProvider } from '../../integrations/erp/index.js';
import { smartttClient } from '../../integrations/smarttt/index.js';
import { auditService } from '../audit/index.js';
import { notificationService } from '../notification/index.js';
import { lookupStudent, type DirectoryLookup } from '../student/student.directory.js';
import { linkAllocationsToStudent } from '../unit/index.js';
import * as authRepository from './auth.repository.js';
import { revokeOtherSessions, toLecturerPublic, type LecturerPublic } from './auth.session.repository.js';
import type {
  AvatarInput,
  ChangePasswordInput,
  LecturerRegistrationInput,
  StudentRegistrationInput,
  UpdateProfileInput,
} from './auth.schema.js';

/**
 * Lecturer registration.
 *
 * The rule that drives this file: a staff number absent from the staff
 * records means the registration is REVOKED — no account is created, nothing
 * is left behind except an audit entry explaining the rejection. A staff
 * number the records verify gets an ACTIVE account at once: no email
 * confirmation, no admin approval — the lecturer signs in straight after
 * registering.
 *
 * The staff records are SMARTTT's approved staff list (the admin's staff-ID
 * uploads) when SMARTTT is configured, with the ERP as the fallback — when
 * SMARTTT is off, can't be reached, or doesn't list the number. See
 * lookupStaff.
 *
 * The gate fails CLOSED. If the records cannot be reached we refuse the
 * registration (503) rather than admitting an unverified lecturer, because a
 * directory outage must not become a way in.
 */

export interface RegistrationContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface LecturerRegistrationResult {
  userId: string;
  email: string;
  fullName: string;
  staffNumber: string;
  status: AccountStatus;
  /** The account is active at once: the lecturer signs in next. */
  nextStep: 'SIGN_IN';
  createdAt: Date;
}

/** Injectable so tests can drive the gate without a live ERP. */
let erpProvider: ErpProvider = erpClient;

export function setErpProvider(provider: ErpProvider): void {
  erpProvider = provider;
}

/** A staff record from whichever directory verified the number. */
interface StaffRecord {
  source: 'SMARTTT' | 'ERP';
  /** The ERP's own key for the person; null when SMARTTT verified them. */
  erpStaffId: string | null;
  title: string | null;
  department: string | null;
  faculty: string | null;
  raw: unknown;
}

type StaffLookup =
  | { status: 'VERIFIED'; record: StaffRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'INACTIVE'; record: StaffRecord }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * SMARTTT's approved staff list first, then the ERP. Same fallback rules as
 * student registration (student.directory.ts): a lecturer SMARTTT reports as
 * no longer serving is refused without asking the ERP, and "not found" is only
 * definitive when both directories could answer.
 */
async function lookupStaff(staffNumber: string): Promise<StaffLookup> {
  if (!smartttClient.enabled) return lookupStaffInErp(staffNumber);

  const smarttt = await smartttClient.lookupStaff(staffNumber);
  if (smarttt.status === 'FOUND') {
    const r = smarttt.record;
    const record: StaffRecord = {
      source: 'SMARTTT',
      erpStaffId: null,
      title: r.title,
      department: r.department,
      faculty: r.faculty,
      raw: r.raw,
    };
    return r.isActive ? { status: 'VERIFIED', record } : { status: 'INACTIVE', record };
  }

  const erp = await lookupStaffInErp(staffNumber);
  if (erp.status === 'NOT_FOUND' && smarttt.status === 'UNAVAILABLE') return smarttt;
  return erp;
}

async function lookupStaffInErp(staffNumber: string): Promise<StaffLookup> {
  const result = await erpProvider.verifyStaffNumber(staffNumber);
  if (result.status === 'NOT_FOUND' || result.status === 'UNAVAILABLE') return result;
  const r = result.record;
  const record: StaffRecord = {
    source: 'ERP',
    erpStaffId: r.erpStaffId,
    title: r.title,
    department: r.department,
    faculty: r.faculty,
    raw: r.raw,
  };
  return result.status === 'VERIFIED' ? { status: 'VERIFIED', record } : { status: 'INACTIVE', record };
}

export async function registerLecturer(
  input: LecturerRegistrationInput,
  context: RegistrationContext,
): Promise<LecturerRegistrationResult> {
  const { fullName, email, staffNumber, password } = input;

  const auditBase = {
    subjectEmail: email,
    subjectStaffNumber: staffNumber,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };

  await auditService.record({
    ...auditBase,
    action: 'LECTURER_REGISTRATION_SUBMITTED',
    outcome: 'SUCCESS',
  });

  // ---------------------------------------------------------------------
  // 1. Reject duplicates before spending an ERP call on them.
  // ---------------------------------------------------------------------
  const conflict = await authRepository.findConflictingAccounts(email, staffNumber);
  if (conflict.emailTaken || conflict.staffNumberTaken) {
    await auditService.record({
      ...auditBase,
      action: 'LECTURER_REGISTRATION_REVOKED',
      outcome: 'FAILURE',
      reason: conflict.emailTaken ? 'email already registered' : 'staff number already registered',
    });

    // One message for both cases. Naming which field collided would turn this
    // endpoint into an oracle for enumerating staff numbers and addresses.
    throw AppError.conflict(
      'An account already exists for these details. Try signing in, or reset your password.',
      ErrorCode.ACCOUNT_ALREADY_EXISTS,
    );
  }

  // ---------------------------------------------------------------------
  // 2. The staff-records gate.
  // ---------------------------------------------------------------------
  const lookup = await lookupStaff(staffNumber);

  if (lookup.status !== 'VERIFIED') {
    await revokeRegistration(lookup, auditBase);
  }

  // Narrowed by revokeRegistration, which always throws.
  const record = (lookup as Extract<StaffLookup, { status: 'VERIFIED' }>).record;

  // ---------------------------------------------------------------------
  // 3. Create the account.
  // ---------------------------------------------------------------------
  const passwordHash = await hashPassword(password);

  // Active at once: the staff-records check above is what proves a lecturer is staff.
  // There is no email confirmation and no administrator approval step, so the
  // lecturer can sign in as soon as the account exists.
  const status: AccountStatus = 'ACTIVE';

  let created: authRepository.CreatedLecturer;
  try {
    created = await authRepository.createLecturerAccount(
      {
        email,
        fullName,
        passwordHash,
        status,
        staffNumber,
        erpStaffId: record.erpStaffId,
        erpSnapshot: record.raw,
        title: record.title,
        department: record.department,
        faculty: record.faculty,
      },
      // Committed with the account, so a successful registration can never
      // exist without its audit entry.
      async (tx, userId) => {
        await auditService.recordInTransaction(tx, {
          ...auditBase,
          userId,
          action: 'LECTURER_REGISTRATION_COMPLETED',
          outcome: 'SUCCESS',
          erpOutcome: 'VERIFIED',
          metadata: { directory: record.source, erpStaffId: record.erpStaffId, department: record.department },
        });
      },
    );
  } catch (error) {
    // Two requests raced past the step-1 check. The unique index caught it.
    if (isUniqueViolation(error)) {
      await auditService.record({
        ...auditBase,
        action: 'LECTURER_REGISTRATION_REVOKED',
        outcome: 'FAILURE',
        reason: 'unique constraint violation on concurrent registration',
      });
      throw AppError.conflict(
        'An account already exists for these details. Try signing in, or reset your password.',
        ErrorCode.ACCOUNT_ALREADY_EXISTS,
      );
    }
    throw error;
  }

  logger.info(
    { userId: created.userId, staffNumber, requestId: context.requestId },
    'lecturer registered',
  );

  return {
    userId: created.userId,
    email: created.email,
    fullName: created.fullName,
    staffNumber: created.staffNumber,
    status: created.status,
    nextStep: 'SIGN_IN',
    createdAt: created.createdAt,
  };
}

/**
 * Updates the editable half of a lecturer's profile. Name and email are
 * deliberately untouched here — see updateProfileSchema.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
  context: RegistrationContext,
): Promise<LecturerPublic> {
  const updated = await authRepository.updateLecturerProfile(userId, {
    title: input.title?.trim() || null,
    department: input.department,
  });
  if (!updated) throw AppError.notFound('Lecturer profile not found.');

  await auditService.record({
    action: 'LECTURER_PROFILE_UPDATED',
    outcome: 'SUCCESS',
    userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { title: updated.title, department: updated.department },
  });

  return toLecturerPublic(updated);
}

/**
 * Changes a password from inside the app. Signs out every other device —
 * proof of the current password stands in for the reset flow's emailed
 * token, so unlike that flow (which trusts nothing and revokes everything)
 * this one keeps the session making the change alive.
 */
export async function changePassword(
  userId: string,
  sessionId: string,
  input: ChangePasswordInput,
  context: RegistrationContext,
): Promise<{ message: string }> {
  const holder = await authRepository.findPasswordHolder(userId);
  if (!holder) throw AppError.notFound('Account not found.');

  const audit = {
    userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  };

  if (!(await verifyPassword(input.currentPassword, holder.passwordHash))) {
    await auditService.record({
      ...audit,
      action: 'PASSWORD_CHANGED',
      outcome: 'FAILURE',
      reason: 'current password did not match',
    });
    throw AppError.badRequest('Your current password is incorrect.');
  }

  if (await verifyPassword(input.newPassword, holder.passwordHash)) {
    throw AppError.badRequest('Your new password must be different from your current password.');
  }

  const newHash = await hashPassword(input.newPassword);
  await authRepository.updatePassword(userId, newHash);
  await revokeOtherSessions(userId, sessionId, 'password_changed');

  await auditService.record({
    ...audit,
    action: 'PASSWORD_CHANGED',
    outcome: 'SUCCESS',
    reason: 'other sessions revoked',
  });
  logger.info({ userId }, 'password changed; other sessions revoked');

  void notificationService
    .sendPasswordChanged({ to: holder.email, fullName: holder.fullName })
    .catch((error: unknown) => {
      logger.error({ err: error, userId }, 'password change notice failed to send');
    });

  return { message: 'Your password has been changed. You have been signed out on every other device.' };
}

/** Sets or replaces the profile photo. Kept out of LecturerPublic — see app.ts's route-specific body limit. */
export async function setAvatar(
  userId: string,
  input: AvatarInput,
  context: RegistrationContext,
): Promise<{ avatarUrl: string | null }> {
  await authRepository.setAvatarUrl(userId, input.avatarDataUrl);
  await auditService.record({
    action: 'AVATAR_UPDATED',
    outcome: 'SUCCESS',
    userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { removed: false },
  });
  return { avatarUrl: input.avatarDataUrl };
}

export async function removeAvatar(
  userId: string,
  context: RegistrationContext,
): Promise<{ avatarUrl: string | null }> {
  await authRepository.setAvatarUrl(userId, null);
  await auditService.record({
    action: 'AVATAR_UPDATED',
    outcome: 'SUCCESS',
    userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { removed: true },
  });
  return { avatarUrl: null };
}

/**
 * Turns a failed ERP lookup into an audit entry and a client error.
 * Always throws — the return type tells TypeScript that too.
 */
async function revokeRegistration(
  lookup: StaffLookup,
  auditBase: {
    subjectEmail: string;
    subjectStaffNumber: string;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string;
  },
): Promise<never> {
  const revocation = describeRevocation(lookup);

  await auditService.record({
    ...auditBase,
    action: 'LECTURER_REGISTRATION_REVOKED',
    outcome: 'FAILURE',
    erpOutcome: lookup.status,
    reason: revocation.auditReason,
  });

  logger.warn(
    {
      staffNumber: auditBase.subjectStaffNumber,
      erpOutcome: lookup.status,
      requestId: auditBase.requestId,
    },
    'lecturer registration revoked',
  );

  throw new AppError(revocation.statusCode, revocation.code, revocation.message, {
    ...(revocation.details ? { details: revocation.details } : {}),
    ...(revocation.retryAfterSeconds ? { retryAfterSeconds: revocation.retryAfterSeconds } : {}),
  });
}

interface Revocation {
  statusCode: number;
  code: (typeof ErrorCode)[keyof typeof ErrorCode];
  message: string;
  auditReason: string;
  details?: unknown;
  retryAfterSeconds?: number;
}

function describeRevocation(lookup: StaffLookup): Revocation {
  switch (lookup.status) {
    case 'NOT_FOUND':
      return {
        statusCode: 403,
        code: ErrorCode.ERP_STAFF_NOT_FOUND,
        message:
          'Registration was not completed. This staff number is not listed in the institutional staff records. Please contact the HR or ICT office.',
        auditReason: 'staff number not in the staff records (SMARTTT or ERP)',
      };

    case 'INACTIVE':
      return {
        statusCode: 403,
        code: ErrorCode.ERP_STAFF_INACTIVE,
        message:
          'Registration was not completed. This staff number is not currently active in the institutional staff records. Please contact the HR office.',
        auditReason: 'staff record is not active',
      };

    case 'UNAVAILABLE':
      return {
        statusCode: 503,
        code: ErrorCode.ERP_UNAVAILABLE,
        message:
          'Registration could not be verified right now because the staff records system is unreachable. Please try again shortly.',
        auditReason: `ERP unavailable: ${lookup.reason}`,
        retryAfterSeconds: 60,
      };

    case 'VERIFIED':
      // Unreachable: the caller only enters here on a non-VERIFIED status.
      throw AppError.internal('revokeRegistration called for a verified lookup');
  }
}

/**
 * Confirms an email address using the token sent at registration.
 * Returns the status the account landed in.
 */
export async function verifyEmail(
  token: string,
  context: RegistrationContext,
): Promise<{ status: AccountStatus; nextStep: 'SIGN_IN' }> {
  const stored = await authRepository.findEmailVerificationToken(hashToken(token));

  // One message for every failure mode, so the endpoint cannot be used to
  // probe which tokens exist.
  const invalid = AppError.badRequest(
    'This verification link is invalid or has expired. Please request a new one.',
  );

  if (!stored || stored.consumedAt !== null || stored.expiresAt <= new Date()) {
    throw invalid;
  }

  // Confirming an email activates the account; there is no approval step.
  // Nobody is sent a verification link any more (everyone is active on
  // registration), but a link issued before that change still works.
  const isStudent = stored.userRole === 'STUDENT';
  const nextStatus: AccountStatus = 'ACTIVE';

  const consumed = await authRepository.consumeEmailVerificationToken(
    stored.id,
    stored.userId,
    nextStatus,
  );

  if (!consumed) throw invalid;

  await auditService.record({
    userId: stored.userId,
    action: 'EMAIL_VERIFICATION_CONFIRMED',
    outcome: 'SUCCESS',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  });

  if (isStudent) await linkStudentToRosters(stored.userId, context);

  return { status: nextStatus, nextStep: 'SIGN_IN' };
}

/**
 * Puts a newly active student on every roster that already lists their
 * registration number (synced from SMARTTT or the ERP before they had an
 * account), so they can check in straight away. Rosters synced later link
 * them the same way (unit.repository.ts syncRosterAllocations keys on the
 * registration number, and linkAllocationsToStudent runs here once).
 *
 * Best-effort: the account is already verified; a failure here is logged and
 * the next sign-in's roster views still show the student by number.
 */
async function linkStudentToRosters(userId: string, context: RegistrationContext): Promise<void> {
  try {
    const registrationNumber = await authRepository.findStudentRegistrationNumber(userId);
    if (!registrationNumber) return;
    const linked = await linkAllocationsToStudent(userId, registrationNumber);
    await auditService.record({
      userId,
      action: 'STUDENT_ROSTERS_LINKED',
      outcome: 'SUCCESS',
      subjectRegistrationNumber: registrationNumber,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { rostersLinked: linked },
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'could not link verified student to rosters');
  }
}

// ---------------------------------------------------------------------------
// Student registration
// ---------------------------------------------------------------------------

export interface StudentRegistrationResult {
  userId: string;
  email: string;
  fullName: string;
  registrationNumber: string;
  status: AccountStatus;
  /** The account is active at once: the student signs in next. */
  nextStep: 'SIGN_IN';
  createdAt: Date;
}

/**
 * Student registration. Same shape as the lecturer flow: the registration
 * number must belong to a current student in the directory (SMARTTT, or the
 * ERP when SMARTTT is off). Only the number is checked — the name and email
 * typed are not compared with the directory record. The gate fails CLOSED:
 * if the directory can't be reached nothing is created (503).
 *
 * A student the directory verifies gets an ACTIVE account at once: no email
 * confirmation, no admin approval — the student signs in straight after
 * registering, just like a lecturer.
 */
export async function registerStudent(
  input: StudentRegistrationInput,
  context: RegistrationContext,
): Promise<StudentRegistrationResult> {
  const { fullName, email, registrationNumber, password } = input;
  const auditBase = {
    subjectEmail: email,
    subjectRegistrationNumber: registrationNumber,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };

  await auditService.record({ ...auditBase, action: 'STUDENT_REGISTRATION_SUBMITTED', outcome: 'SUCCESS' });

  const alreadyExists = () =>
    AppError.conflict(
      'An account already exists for these details. Try signing in, or reset your password.',
      ErrorCode.ACCOUNT_ALREADY_EXISTS,
    );

  // 1. Duplicates, before spending a directory call. One message for both,
  //    so the endpoint can't be used to test which numbers are registered.
  const conflict = await authRepository.findConflictingStudentAccounts(email, registrationNumber);
  if (conflict.emailTaken || conflict.registrationNumberTaken) {
    await auditService.record({
      ...auditBase,
      action: 'STUDENT_REGISTRATION_REVOKED',
      outcome: 'FAILURE',
      reason: conflict.emailTaken ? 'email already registered' : 'registration number already registered',
    });
    throw alreadyExists();
  }

  // 2. The directory gate.
  const lookup = await lookupStudent(registrationNumber);
  if (lookup.status !== 'FOUND') await revokeStudentRegistration(lookup, auditBase);
  const record = (lookup as Extract<DirectoryLookup, { status: 'FOUND' }>).record;

  // 3. Create the account.
  const passwordHash = await hashPassword(password);
  let created: authRepository.CreatedStudent;
  try {
    created = await authRepository.createStudentAccount(
      {
        email,
        fullName,
        passwordHash,
        // Active at once: the directory check above is what proves a student is enrolled.
        status: 'ACTIVE',
        registrationNumber,
        programme: record.programme,
        yearOfStudy: record.yearOfStudy,
        directorySource: record.source,
        directorySnapshot: record.raw,
      },
      async (tx, userId) => {
        await auditService.recordInTransaction(tx, {
          ...auditBase,
          userId,
          action: 'STUDENT_REGISTRATION_COMPLETED',
          outcome: 'SUCCESS',
          erpOutcome: 'VERIFIED',
          metadata: { directory: record.source, programme: record.programme },
        });
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      await auditService.record({
        ...auditBase,
        action: 'STUDENT_REGISTRATION_REVOKED',
        outcome: 'FAILURE',
        reason: 'unique constraint violation on concurrent registration',
      });
      throw alreadyExists();
    }
    throw error;
  }

  // 4. Put them on every roster that already lists their number, so they can
  //    check in as soon as they sign in.
  await linkStudentToRosters(created.userId, context);

  logger.info({ userId: created.userId, registrationNumber, requestId: context.requestId }, 'student registered');

  return {
    userId: created.userId,
    email: created.email,
    fullName: created.fullName,
    registrationNumber: created.registrationNumber,
    status: created.status,
    nextStep: 'SIGN_IN',
    createdAt: created.createdAt,
  };
}

/** A failed directory lookup, as an audit entry and a client error. Always throws. */
async function revokeStudentRegistration(
  lookup: Exclude<DirectoryLookup, { status: 'FOUND' }>,
  auditBase: {
    subjectEmail: string;
    subjectRegistrationNumber: string;
    ipAddress: string | null;
    userAgent: string | null;
    requestId: string;
  },
): Promise<never> {
  const byStatus = {
    NOT_FOUND: {
      statusCode: 403,
      code: ErrorCode.STUDENT_RECORD_NOT_FOUND,
      message:
        'Registration was not completed. This registration number is not in the student records. Check it, or contact the registrar.',
      auditReason: 'registration number not in student directory',
    },
    INACTIVE: {
      statusCode: 403,
      code: ErrorCode.STUDENT_RECORD_INACTIVE,
      message:
        'Registration was not completed. This registration number is not a current student in the student records. Please contact the registrar.',
      auditReason: 'student record not active',
    },
    UNAVAILABLE: {
      statusCode: 503,
      code: ErrorCode.STUDENT_DIRECTORY_UNAVAILABLE,
      message:
        'Registration could not be verified right now because the student records system is unreachable. Please try again shortly.',
      auditReason: `student directory unavailable${lookup.status === 'UNAVAILABLE' ? `: ${lookup.reason}` : ''}`,
    },
  }[lookup.status];

  await auditService.record({
    ...auditBase,
    action: 'STUDENT_REGISTRATION_REVOKED',
    outcome: 'FAILURE',
    erpOutcome: lookup.status,
    reason: byStatus.auditReason,
  });
  logger.warn(
    { registrationNumber: auditBase.subjectRegistrationNumber, directoryOutcome: lookup.status, requestId: auditBase.requestId },
    'student registration revoked',
  );
  throw new AppError(byStatus.statusCode, byStatus.code, byStatus.message, {
    ...(lookup.status === 'UNAVAILABLE' ? { retryAfterSeconds: 60 } : {}),
  });
}

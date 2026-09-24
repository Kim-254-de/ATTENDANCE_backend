import { isUniqueViolation } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { hashPassword, verifyPassword } from '../../common/utils/password.js';
import { expiresInHours, generateToken, hashToken } from '../../common/utils/tokens.js';
import { erpClient } from '../../integrations/erp/index.js';
import type { ErpLookupResult, ErpProvider } from '../../integrations/erp/index.js';
import { auditService } from '../audit/index.js';
import { notificationService } from '../notification/index.js';
import * as authRepository from './auth.repository.js';
import { revokeOtherSessions, toLecturerPublic, type LecturerPublic } from './auth.session.repository.js';
import type { AvatarInput, ChangePasswordInput, LecturerRegistrationInput, UpdateProfileInput } from './auth.schema.js';

/**
 * Lecturer registration.
 *
 * The rule that drives this file: a staff number absent from the ERP means the
 * registration is REVOKED — no account is created, nothing is left behind
 * except an audit entry explaining the rejection.
 *
 * The ERP gate fails CLOSED. If the ERP cannot be reached we refuse the
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
  /** What the client should tell the lecturer to do next. */
  nextStep: 'VERIFY_EMAIL' | 'AWAIT_APPROVAL';
  createdAt: Date;
}

/** Injectable so tests can drive the gate without a live ERP. */
let erpProvider: ErpProvider = erpClient;

export function setErpProvider(provider: ErpProvider): void {
  erpProvider = provider;
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
  // 2. The ERP gate.
  // ---------------------------------------------------------------------
  const lookup = await erpProvider.verifyStaffNumber(staffNumber, { fullName, email });

  if (lookup.status !== 'VERIFIED') {
    await revokeRegistration(lookup, auditBase);
  }

  // Narrowed by revokeRegistration, which always throws.
  const record = (lookup as Extract<ErpLookupResult, { status: 'VERIFIED' }>).record;

  // ---------------------------------------------------------------------
  // 3. Create the account.
  // ---------------------------------------------------------------------
  const passwordHash = await hashPassword(password);
  const verification = generateToken();

  // Lecturers confirm their email first; admin approval (README section 3.1)
  // then gates activation when the institution requires it.
  const status: AccountStatus = 'PENDING_VERIFICATION';

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
        emailVerificationTokenHash: verification.tokenHash,
        emailVerificationExpiresAt: expiresInHours(env.EMAIL_VERIFICATION_TTL_HOURS),
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
          metadata: { erpStaffId: record.erpStaffId, department: record.department },
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

  // ---------------------------------------------------------------------
  // 4. Send the verification email.
  // ---------------------------------------------------------------------
  // Delivery failure must not roll back a valid registration — the lecturer
  // can request a fresh link — so this is reported, not thrown.
  await notificationService
    .sendEmailVerification({
      to: created.email,
      fullName: created.fullName,
      token: verification.token,
    })
    .then(() =>
      auditService.record({
        ...auditBase,
        userId: created.userId,
        action: 'EMAIL_VERIFICATION_SENT',
        outcome: 'SUCCESS',
      }),
    )
    .catch(async (error: unknown) => {
      logger.error({ err: error, userId: created.userId }, 'verification email failed to send');
      await auditService.record({
        ...auditBase,
        userId: created.userId,
        action: 'EMAIL_VERIFICATION_SENT',
        outcome: 'FAILURE',
        reason: 'delivery failed',
      });
    });

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
    nextStep: 'VERIFY_EMAIL',
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
  lookup: ErpLookupResult,
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

function describeRevocation(lookup: ErpLookupResult): Revocation {
  switch (lookup.status) {
    case 'NOT_FOUND':
      return {
        statusCode: 403,
        code: ErrorCode.ERP_STAFF_NOT_FOUND,
        message:
          'Registration was not completed. This staff number is not listed in the institutional staff records. Please contact the HR or ICT office.',
        auditReason: 'staff number not present in ERP',
      };

    case 'INACTIVE':
      return {
        statusCode: 403,
        code: ErrorCode.ERP_STAFF_INACTIVE,
        message:
          'Registration was not completed. This staff number is not currently active in the institutional staff records. Please contact the HR office.',
        auditReason: 'ERP record is not active',
      };

    case 'IDENTITY_MISMATCH':
      return {
        statusCode: 403,
        code: ErrorCode.ERP_IDENTITY_MISMATCH,
        message:
          'Registration was not completed. The details entered do not match the staff records held for this staff number. Please check your name and email address, or contact the HR office.',
        auditReason: `identity mismatch on: ${lookup.mismatchedFields.join(', ')}`,
        // The fields that disagreed, but never the ERP's stored values —
        // that would leak a colleague's details to whoever typed the number.
        details: { mismatchedFields: lookup.mismatchedFields },
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
): Promise<{ status: AccountStatus; nextStep: 'AWAIT_APPROVAL' | 'SIGN_IN' }> {
  const stored = await authRepository.findEmailVerificationToken(hashToken(token));

  // One message for every failure mode, so the endpoint cannot be used to
  // probe which tokens exist.
  const invalid = AppError.badRequest(
    'This verification link is invalid or has expired. Please request a new one.',
  );

  if (!stored || stored.consumedAt !== null || stored.expiresAt <= new Date()) {
    throw invalid;
  }

  const nextStatus: AccountStatus = env.LECTURER_REQUIRES_ADMIN_APPROVAL
    ? 'PENDING_APPROVAL'
    : 'ACTIVE';

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

  return {
    status: nextStatus,
    nextStep: nextStatus === 'PENDING_APPROVAL' ? 'AWAIT_APPROVAL' : 'SIGN_IN',
  };
}

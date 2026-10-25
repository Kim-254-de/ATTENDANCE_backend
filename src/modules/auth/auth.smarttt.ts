import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ErrorCode, type ErrorCodeValue } from '../../common/errors/index.js';
import { hashPassword } from '../../common/utils/password.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { isUniqueViolation, transaction } from '../../db/database.js';
import { smartttClient, type SmartttAccount } from '../../integrations/smarttt/index.js';
import { auditService } from '../audit/index.js';
import { linkAllocationsToStudent } from '../unit/index.js';
import * as authRepository from './auth.repository.js';
import * as smartttRepository from './auth.smarttt.repository.js';
import type { LinkedRole } from './auth.smarttt.repository.js';
import type { RegistrationContext } from './auth.service.js';

/**
 * Students and lecturers sign in with their SMARTTT account
 * (docs/smarttt-accounts.md). SMARTTT checks the password
 * (apps/integrations attendance/authenticate/, behind the shared API key);
 * attendance keeps its own row for each person, because attendance records,
 * sessions and passkeys hang off it, and creates or links it here on their
 * first sign-in.
 *
 * Linking order: the account already carrying this SMARTTT id, else the
 * student or lecturer with the same registration or staff number (someone who
 * registered here before sign-in moved to SMARTTT keeps their history), else
 * a new account. From then on SMARTTT's id finds it, and SMARTTT's name,
 * email and number are copied onto it at every sign-in.
 *
 * Administrators are SMARTTT's administrators too (signInAdministrator): the
 * platform has one admin console, attendance's admin portal, and one admin
 * account per person, their SMARTTT account.
 *
 * Department officers and management are not in SMARTTT and keep attendance's
 * own passwords (auth.login.service.ts).
 */

/** Whether students and lecturers sign in with SMARTTT (and cannot register or keep a password here). */
export const smartttAccountsEnabled = (): boolean => env.SMARTTT_ACCOUNTS && smartttClient.enabled;

const ROLES: Record<string, LinkedRole> = { student: 'STUDENT', lecturer: 'LECTURER' };

export type SmartttSignIn =
  | { status: 'SIGNED_IN'; userId: string }
  | { status: 'INVALID_CREDENTIALS' };

/**
 * Checks the password with SMARTTT and returns the attendance account to sign
 * in, created or linked as needed. Throws for anything that is about the
 * account rather than the password, with a message saying what to fix in SMARTTT.
 */
export async function signInWithSmarttt(identifier: string, password: string, context: RegistrationContext): Promise<SmartttSignIn> {
  const answer = await smartttClient.authenticate(identifier, password);
  if (answer.status === 'INVALID_CREDENTIALS') return { status: 'INVALID_CREDENTIALS' };
  if (answer.status !== 'AUTHENTICATED') {
    throw new AppError(
      503,
      ErrorCode.SMARTTT_UNAVAILABLE,
      'Sign-in is unavailable right now: SMARTTT could not be reached. Try again in a minute.',
    );
  }

  const account = answer.account;
  const refuse = async (reason: string, message: string, code: ErrorCodeValue = ErrorCode.SMARTTT_ACCOUNT_INCOMPLETE, status = 403): Promise<never> => {
    await auditService.record({
      action: 'SMARTTT_ACCOUNT_REFUSED',
      outcome: 'FAILURE',
      reason,
      subjectEmail: account.email,
      subjectStaffNumber: account.universityId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      requestId: context.requestId,
      metadata: { smartttUserId: account.smartttUserId, smartttRole: account.role },
    });
    throw new AppError(status, code, message);
  };

  // SMARTTT's administrators run the platform's one admin console here.
  if (account.isAdmin) return { status: 'SIGNED_IN', userId: await signInAdministrator(account, refuse, context) };

  const role = ROLES[account.role];
  if (!role) {
    return refuse('not a student or lecturer', 'Only students, lecturers and SMARTTT administrators can use the attendance system. Sign in with a student or lecturer SMARTTT account.');
  }
  const number = account.universityId;
  if (!number) {
    return refuse(
      'no admission or staff number',
      role === 'STUDENT'
        ? 'Your SMARTTT account has no admission number yet. Add it in your SMARTTT profile, then sign in here.'
        : 'Your SMARTTT account has no staff ID. Contact ICT.',
    );
  }
  if (role === 'STUDENT' && account.student && !account.student.isActive) {
    return refuse('student not current', 'SMARTTT lists you as no longer a current student, so you cannot use the attendance system. Contact the registrar if this is wrong.');
  }
  if (role === 'LECTURER' && !account.staff) {
    return refuse('not on the staff list', 'Your staff ID is not on the approved staff list in SMARTTT. Contact ICT.');
  }

  const existing = await smartttRepository.findLinkCandidate(account.smartttUserId, role, number);
  const userId = existing
    ? await linkExisting(existing, account, role, number, refuse, context)
    : await createFor(account, role, number, refuse, context);
  return { status: 'SIGNED_IN', userId };
}

type Refuse = (reason: string, message: string, code?: ErrorCodeValue, status?: number) => Promise<never>;

/**
 * A SMARTTT administrator: the account linked to their SMARTTT id, else the
 * administrator here with the same email (invited before administrators moved
 * to SMARTTT; their invitation link stops working), else a new one. No
 * admission or staff number is needed. Whether they are still an
 * administrator is SMARTTT's call at every sign-in, and at every SMARTTT
 * function the console uses (the integrations/admin/ endpoints re-check it).
 */
async function signInAdministrator(account: SmartttAccount, refuse: Refuse, context: RegistrationContext): Promise<string> {
  const conflict = (reason: string) =>
    refuse(reason, 'Your SMARTTT account clashes with another attendance account. Contact ICT.', ErrorCode.SMARTTT_ACCOUNT_CONFLICT, 409);
  const audit = {
    subjectEmail: account.email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };

  const existing = await smartttRepository.findAdminLinkCandidate(account.smartttUserId, account.email);
  if (existing) {
    if (existing.role !== 'ADMIN') return conflict(`attendance account is ${existing.role}, SMARTTT says administrator`);
    if (!existing.byId && existing.smartttUserId) return conflict('email already linked to another SMARTTT account');
    const email = account.email && !(await smartttRepository.isEmailTakenByOther(account.email, existing.userId)) ? account.email : null;
    await smartttRepository.refreshLinkedAdmin({ userId: existing.userId, smartttUserId: account.smartttUserId, fullName: account.fullName, email });
    if (!existing.byId) {
      await auditService.record({
        ...audit,
        action: 'SMARTTT_ACCOUNT_LINKED',
        outcome: 'SUCCESS',
        userId: existing.userId,
        metadata: { smartttUserId: account.smartttUserId, role: 'ADMIN' },
      });
    }
    return existing.userId;
  }

  if (!account.email) return refuse('no email', 'Your SMARTTT account has no email address. Add one in SMARTTT, then sign in here.');
  if (await smartttRepository.isEmailTakenByOther(account.email, null)) {
    return conflict('email used by another attendance account');
  }
  // Never used, as for students and lecturers: SMARTTT checks the password.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  try {
    return await transaction(async (tx) => {
      const userId = await smartttRepository.createAdminAccount(tx, {
        email: account.email!,
        fullName: account.fullName ?? account.email!,
        passwordHash,
        smartttUserId: account.smartttUserId,
      });
      await auditService.recordInTransaction(tx, {
        ...audit,
        userId,
        action: 'SMARTTT_ACCOUNT_CREATED',
        outcome: 'SUCCESS',
        metadata: { smartttUserId: account.smartttUserId, role: 'ADMIN' },
      });
      return userId;
    });
  } catch (error) {
    // Two first sign-ins raced; the loser uses the winner's account.
    if (isUniqueViolation(error)) {
      const winner = await smartttRepository.findAdminLinkCandidate(account.smartttUserId, account.email);
      if (winner?.byId && winner.role === 'ADMIN') return winner.userId;
      return conflict('unique violation creating administrator');
    }
    throw error;
  }
}

async function linkExisting(
  existing: smartttRepository.LinkCandidate,
  account: SmartttAccount,
  role: LinkedRole,
  number: string,
  refuse: Refuse,
  context: RegistrationContext,
): Promise<string> {
  const conflict = (reason: string) =>
    refuse(reason, 'Your SMARTTT account clashes with another attendance account. Contact the administrator.', ErrorCode.SMARTTT_ACCOUNT_CONFLICT, 409);

  if (existing.role !== role) return conflict(`attendance account is ${existing.role}, SMARTTT says ${role}`);
  // Found by number, but that account belongs to a different SMARTTT user: the number was reassigned there.
  if (!existing.byId && existing.smartttUserId) return conflict('number already linked to another SMARTTT account');
  if (existing.number !== number && (await smartttRepository.isNumberTakenByOther(role, number, existing.userId))) {
    return conflict('changed number already held by another attendance account');
  }
  // An email clash only keeps the old email; it doesn't stop the sign-in.
  const email = account.email && !(await smartttRepository.isEmailTakenByOther(account.email, existing.userId)) ? account.email : null;

  await smartttRepository.refreshLinkedAccount({
    userId: existing.userId,
    smartttUserId: account.smartttUserId,
    role,
    fullName: account.fullName,
    email,
    number,
    student: account.student
      ? { programme: account.student.programme, yearOfStudy: account.student.yearOfStudy, snapshot: account.student.raw }
      : undefined,
    lecturer: account.staff
      ? { title: account.staff.title, department: account.staff.department, snapshot: account.staff.raw }
      : undefined,
  });

  if (!existing.byId) {
    await auditService.record({
      action: 'SMARTTT_ACCOUNT_LINKED',
      outcome: 'SUCCESS',
      userId: existing.userId,
      subjectEmail: account.email,
      ...(role === 'STUDENT' ? { subjectRegistrationNumber: number } : { subjectStaffNumber: number }),
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      requestId: context.requestId,
      metadata: { smartttUserId: account.smartttUserId },
    });
  }
  if (role === 'STUDENT' && (!existing.byId || existing.number !== number)) await linkRosters(existing.userId, number);
  return existing.userId;
}

async function createFor(account: SmartttAccount, role: LinkedRole, number: string, refuse: Refuse, context: RegistrationContext): Promise<string> {
  const email = account.email ?? (role === 'STUDENT' ? account.student?.email : account.staff?.email) ?? null;
  if (!email) return refuse('no email', 'Your SMARTTT account has no email address. Add one in SMARTTT, then sign in here.');
  if (await smartttRepository.isEmailTakenByOther(email, null)) {
    return refuse(
      'email used by another attendance account',
      'Your SMARTTT email is already used by another attendance account. Contact the administrator.',
      ErrorCode.SMARTTT_ACCOUNT_CONFLICT,
      409,
    );
  }

  const fullName = account.fullName ?? account.student?.fullName ?? account.staff?.fullName ?? email;
  // Never used: SMARTTT checks the password. A random secret, hashed like any
  // other, so the column's NOT NULL holds and nothing can sign in with it.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  const audit = {
    subjectEmail: email,
    ...(role === 'STUDENT' ? { subjectRegistrationNumber: number } : { subjectStaffNumber: number }),
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };
  const onCreated = async (tx: PoolClient, userId: string) => {
    await smartttRepository.setSmartttUserId(userId, account.smartttUserId, tx);
    await auditService.recordInTransaction(tx, {
      ...audit,
      userId,
      action: 'SMARTTT_ACCOUNT_CREATED',
      outcome: 'SUCCESS',
      metadata: { smartttUserId: account.smartttUserId, role },
    });
  };

  try {
    if (role === 'STUDENT') {
      const created = await authRepository.createStudentAccount(
        {
          email,
          fullName,
          passwordHash,
          status: 'ACTIVE',
          registrationNumber: number,
          programme: account.student?.programme ?? null,
          yearOfStudy: account.student?.yearOfStudy ?? null,
          directorySource: 'SMARTTT',
          directorySnapshot: account.student?.raw ?? null,
        },
        onCreated,
      );
      await linkRosters(created.userId, number);
      return created.userId;
    }
    const staff = account.staff!;
    const created = await authRepository.createLecturerAccount(
      {
        email,
        fullName,
        passwordHash,
        status: 'ACTIVE',
        staffNumber: number,
        erpStaffId: null,
        erpSnapshot: staff.raw,
        title: staff.title,
        department: staff.department,
      },
      onCreated,
    );
    return created.userId;
  } catch (error) {
    // Two first sign-ins raced; the loser finds the account the winner made.
    if (isUniqueViolation(error)) {
      const winner = await smartttRepository.findLinkCandidate(account.smartttUserId, role, number);
      if (winner?.byId) return winner.userId;
      return refuse('unique violation creating account', 'Your SMARTTT account clashes with another attendance account. Contact the administrator.', ErrorCode.SMARTTT_ACCOUNT_CONFLICT, 409);
    }
    throw error;
  }
}

/** Puts a student on every class list already naming their registration number. Best-effort, like registration. */
async function linkRosters(userId: string, registrationNumber: string): Promise<void> {
  try {
    await linkAllocationsToStudent(userId, registrationNumber);
  } catch (error) {
    logger.error({ err: error, userId }, 'could not link student to rosters at first sign-in');
  }
}

export type StudentProvisioning =
  | { status: 'CREATED' | 'EXISTS'; userId: string }
  | { status: 'NOT_FOUND' | 'REFUSED' }
  | { status: 'UNAVAILABLE' };

/**
 * Creates the attendance account for a student SMARTTT knows but who has
 * never signed in here, so a terminal can record them on first contact (a
 * barcode scan of their ID card).
 *
 * Same rules as a first sign-in, minus the password: current student, has an
 * email, nothing here clashes with it. The SMARTTT user id is not in the
 * student lookup, so the account is left unlinked; findLinkCandidate matches
 * it by registration number at their first sign-in and links it then.
 */
export async function provisionStudentFromSmarttt(registrationNumber: string, context: RegistrationContext): Promise<StudentProvisioning> {
  if (!smartttAccountsEnabled()) return { status: 'NOT_FOUND' };

  const answer = await smartttClient.lookupStudent(registrationNumber);
  if (answer.status === 'NOT_FOUND' || answer.status === 'DISABLED') return { status: 'NOT_FOUND' };
  if (answer.status !== 'FOUND') return { status: 'UNAVAILABLE' };

  const student = answer.record;
  const number = student.registrationNumber;
  const refuse = async (reason: string): Promise<StudentProvisioning> => {
    await auditService.record({
      action: 'SMARTTT_ACCOUNT_REFUSED',
      outcome: 'FAILURE',
      reason,
      subjectEmail: student.email,
      subjectRegistrationNumber: number,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      requestId: context.requestId,
      metadata: { via: 'TERMINAL' },
    });
    return { status: 'REFUSED' };
  };

  if (!student.isActive) return refuse('student not current');
  if (!student.email) return refuse('no email');
  if (await smartttRepository.isEmailTakenByOther(student.email, null)) return refuse('email used by another attendance account');

  // Never used, as in createFor: the student signs in through SMARTTT.
  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
  try {
    const created = await authRepository.createStudentAccount(
      {
        email: student.email,
        fullName: student.fullName ?? student.email,
        passwordHash,
        status: 'ACTIVE',
        registrationNumber: number,
        programme: student.programme,
        yearOfStudy: student.yearOfStudy,
        directorySource: 'SMARTTT',
        directorySnapshot: student.raw,
      },
      async (tx, userId) => {
        await auditService.recordInTransaction(tx, {
          userId,
          action: 'SMARTTT_ACCOUNT_CREATED',
          outcome: 'SUCCESS',
          subjectEmail: student.email,
          subjectRegistrationNumber: number,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          requestId: context.requestId,
          metadata: { role: 'STUDENT', via: 'TERMINAL' },
        });
      },
    );
    await linkRosters(created.userId, number);
    return { status: 'CREATED', userId: created.userId };
  } catch (error) {
    // Two scans (or a scan and a sign-in) raced; the loser uses the winner's account.
    if (isUniqueViolation(error)) {
      const winner = await smartttRepository.findLinkCandidate('', 'STUDENT', number);
      if (winner) return { status: 'EXISTS', userId: winner.userId };
      return refuse('unique violation creating account');
    }
    throw error;
  }
}

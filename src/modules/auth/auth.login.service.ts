import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { fakeVerifyPassword, verifyPassword } from '../../common/utils/password.js';
import type { AccountStatus } from '../../db/types.js';
import { auditService } from '../audit/index.js';
import * as sessions from './auth.session.js';
import * as repo from './auth.session.repository.js';
import type { LoginInput } from './auth.schema.js';
import type { RegistrationContext } from './auth.service.js';

/**
 * Lecturer sign-in (README sections 3.1 and 4.1).
 *
 * Order matters, and each step is deliberate:
 *  1. Unknown account and wrong password give the SAME response, and the unknown-account path
 *     burns comparable CPU, so neither the message nor the timing reveals which accounts exist.
 *  2. A locked account is refused BEFORE the password is checked, so a lock cannot be guessed past.
 *  3. Account status is only revealed AFTER a correct password. Otherwise anyone could probe
 *     which staff numbers are registered, pending or suspended.
 *  4. Only ACTIVE accounts may sign in — pending, suspended and deactivated are refused.
 */

export interface IssuedSession {
  lecturer: repo.LecturerPublic;
  access: string;
  refresh: string;
  sessionExpiresAt: Date;
}

const BAD_CREDENTIALS = 'Incorrect staff number/email or password.';

const STATUS_MESSAGES: Record<Exclude<AccountStatus, 'ACTIVE'>, string> = {
  PENDING_VERIFICATION: 'Please confirm your email address before signing in. Check your inbox for the verification link.',
  PENDING_APPROVAL: 'Your email is confirmed. Your account is waiting for administrator approval.',
  SUSPENDED: 'This account has been suspended. Please contact the administrator.',
  DEACTIVATED: 'This account has been deactivated. Please contact the administrator.',
};

/** Staff numbers are stored upper-case and emails lower-case; anything with "@" is an email. */
export function normaliseIdentifier(identifier: string): string {
  const value = identifier.trim();
  return value.includes('@') ? value.toLowerCase() : value.toUpperCase();
}

export async function loginLecturer(input: LoginInput, context: RegistrationContext): Promise<IssuedSession> {
  const identifier = normaliseIdentifier(input.identifier);
  const audit = { subjectEmail: identifier.includes('@') ? identifier : null, subjectStaffNumber: identifier.includes('@') ? null : identifier, ipAddress: context.ipAddress, userAgent: context.userAgent, requestId: context.requestId };
  const fail = (reason: string, userId?: string) =>
    auditService.record({ ...audit, userId: userId ?? null, action: 'LOGIN_FAILED', outcome: 'FAILURE', reason });

  const user = await repo.findLecturerForLogin(identifier);

  if (!user) {
    await fakeVerifyPassword();
    await fail('unknown account');
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, BAD_CREDENTIALS);
  }

  const now = new Date();
  if (user.lockedUntil && user.lockedUntil > now) {
    await fail('account locked', user.id);
    const retryAfterSeconds = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000));
    throw new AppError(
      429,
      ErrorCode.ACCOUNT_LOCKED,
      `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
      { retryAfterSeconds },
    );
  }

  if (!(await verifyPassword(input.password, user.passwordHash))) {
    const { failedAttempts, lockedUntil } = await repo.recordFailedLogin(
      user.id,
      env.LOGIN_MAX_FAILED_ATTEMPTS,
      env.LOGIN_LOCKOUT_MINUTES,
    );
    await fail(lockedUntil ? `wrong password; account locked after ${failedAttempts} attempts` : 'wrong password', user.id);
    throw new AppError(401, ErrorCode.INVALID_CREDENTIALS, BAD_CREDENTIALS);
  }

  if (user.status !== 'ACTIVE') {
    await fail(`account not active: ${user.status}`, user.id);
    throw new AppError(403, ErrorCode.ACCOUNT_NOT_ACTIVE, STATUS_MESSAGES[user.status], {
      details: { status: user.status },
    });
  }

  const sessionId = sessions.newSessionId();
  const sessionExpiresAt = new Date(Date.now() + sessions.refreshTtlSeconds * 1000);
  const refresh = await sessions.signRefreshToken(user.id, sessionId, sessionExpiresAt);
  await repo.completeLogin({
    sessionId,
    userId: user.id,
    refreshTokenHash: sessions.hashRefreshToken(refresh),
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    expiresAt: sessionExpiresAt,
  });
  const access = await sessions.signAccessToken({ userId: user.id, sessionId, role: 'LECTURER' });

  await auditService.record({ ...audit, userId: user.id, action: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS' });
  return { lecturer: repo.toLecturerPublic(user), access, refresh, sessionExpiresAt };
}

/** Trades a valid refresh token for a fresh pair. The old refresh token stops working. */
export async function refreshSession(refreshToken: string | null, context: RegistrationContext): Promise<IssuedSession> {
  const denied = AppError.unauthenticated('Your session has expired. Please sign in again.');
  if (!refreshToken) throw denied;

  const claims = await sessions.verifyRefreshToken(refreshToken);
  if (!claims) throw denied;

  const session = await repo.findSession(claims.sessionId);
  if (!session || session.userId !== claims.userId || session.revokedAt || session.expiresAt <= new Date()) throw denied;
  if (session.status !== 'ACTIVE' || !session.lecturer) throw denied;

  const presentedHash = sessions.hashRefreshToken(refreshToken);
  if (presentedHash !== session.refreshTokenHash) {
    // A refresh token that was already rotated is being replayed: either the legitimate user or a
    // thief holds a stale copy. We cannot tell which, so end the session; the user signs in again.
    await repo.revokeSession(session.sessionId, 'refresh_reuse');
    await auditService.record({
      userId: session.userId, action: 'SESSION_REFRESH_REUSE_DETECTED', outcome: 'FAILURE',
      reason: 'rotated refresh token was presented again; session revoked',
      ipAddress: context.ipAddress, userAgent: context.userAgent, requestId: context.requestId,
    });
    throw denied;
  }

  const refresh = await sessions.signRefreshToken(session.userId, session.sessionId, session.expiresAt);
  if (!(await repo.rotateRefreshHash(session.sessionId, presentedHash, sessions.hashRefreshToken(refresh)))) {
    throw denied; // lost a race with a concurrent refresh
  }
  const access = await sessions.signAccessToken({ userId: session.userId, sessionId: session.sessionId, role: 'LECTURER' });
  return { lecturer: session.lecturer, access, refresh, sessionExpiresAt: session.expiresAt };
}

/** Ends the session named by whichever valid token the client still holds. Never throws. */
export async function logout(tokens: { access: string | null; refresh: string | null }, context: RegistrationContext): Promise<void> {
  const fromAccess = tokens.access ? await sessions.verifyAccessToken(tokens.access) : null;
  const fromRefresh = tokens.refresh ? await sessions.verifyRefreshToken(tokens.refresh) : null;
  const target = fromAccess ?? fromRefresh;
  if (!target) return;

  await repo.revokeSession(target.sessionId, 'logout');
  await auditService.record({
    userId: target.userId, action: 'LOGOUT', outcome: 'SUCCESS',
    ipAddress: context.ipAddress, userAgent: context.userAgent, requestId: context.requestId,
  });
}

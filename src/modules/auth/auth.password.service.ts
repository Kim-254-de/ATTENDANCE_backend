import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/index.js';
import { hashPassword, verifyPassword } from '../../common/utils/password.js';
import { generateToken, hashToken } from '../../common/utils/tokens.js';
import type { AccountStatus } from '../../db/types.js';
import { auditService } from '../audit/index.js';
import { notificationService } from '../notification/index.js';
import * as repo from './auth.password.repository.js';
import type { ForgotPasswordInput, ResetPasswordInput } from './auth.schema.js';
import type { RegistrationContext } from './auth.service.js';

/**
 * Password reset (README section 4.1).
 *
 * The governing rule: **the response never depends on whether the account
 * exists.** A forgotten-password form that answers differently for a real and
 * a made-up address is a free directory of everyone at the institution, so
 * every request gets the same 200 and the same wording.
 *
 * Everything interesting therefore happens in the audit log rather than in the
 * response body.
 */

/** Deliberately vague, and identical in every case. */
const GENERIC_REPLY =
  'If that email address has an account, a password reset link is on its way. Check your inbox, including spam.';

/** Statuses that may not reset. Nothing is sent, but the reply is unchanged. */
const BLOCKED_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>([
  'SUSPENDED',
  'DEACTIVATED',
]);

export interface ForgotPasswordResult {
  message: string;
}

export async function requestPasswordReset(
  input: ForgotPasswordInput,
  context: RegistrationContext,
): Promise<ForgotPasswordResult> {
  const { email } = input;
  const audit = {
    subjectEmail: email,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };

  // Minted before the account is looked up so both paths do the same work.
  // The token is simply discarded when there is nobody to send it to.
  const token = generateToken();

  const user = await repo.findUserForReset(email);

  if (!user) {
    await auditService.record({
      ...audit,
      action: 'PASSWORD_RESET_REQUESTED',
      outcome: 'FAILURE',
      reason: 'no account for that email',
    });
    return { message: GENERIC_REPLY };
  }

  if (BLOCKED_STATUSES.has(user.status)) {
    // A suspended account must not be recoverable by its holder; that is the
    // point of suspending it. The caller is told nothing.
    await auditService.record({
      ...audit,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      outcome: 'FAILURE',
      reason: `account status is ${user.status}`,
    });
    return { message: GENERIC_REPLY };
  }

  await repo.issueResetToken({
    userId: user.id,
    tokenHash: token.tokenHash,
    expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
    requestedIp: context.ipAddress,
  });

  // A delivery failure must not change the response — that would leak account
  // existence through an error the attacker can trigger. It is logged instead.
  try {
    await notificationService.sendPasswordReset({
      to: user.email,
      fullName: user.fullName,
      token: token.token,
      expiresInMinutes: env.PASSWORD_RESET_TTL_MINUTES,
    });
    await auditService.record({
      ...audit,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      outcome: 'SUCCESS',
    });
  } catch (error) {
    logger.error({ err: error, userId: user.id }, 'password reset email failed to send');
    await auditService.record({
      ...audit,
      userId: user.id,
      action: 'PASSWORD_RESET_REQUESTED',
      outcome: 'FAILURE',
      reason: 'delivery failed',
    });
  }

  return { message: GENERIC_REPLY };
}

export interface ResetPasswordResult {
  message: string;
}

/**
 * Completes a reset.
 *
 * Every failure mode — unknown token, expired, already used, superseded,
 * account since suspended — returns the same message, so the endpoint cannot
 * be used to probe which tokens are live.
 */
export async function resetPassword(
  input: ResetPasswordInput,
  context: RegistrationContext,
): Promise<ResetPasswordResult> {
  const invalid = AppError.badRequest(
    'This password reset link is invalid or has expired. Please request a new one.',
  );

  const stored = await repo.findResetToken(hashToken(input.token));
  const audit = {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    requestId: context.requestId,
  };

  if (!stored) throw invalid;

  const failed = (reason: string) =>
    auditService.record({
      ...audit,
      userId: stored.userId,
      subjectEmail: stored.email,
      action: 'PASSWORD_RESET_COMPLETED',
      outcome: 'FAILURE',
      reason,
    });

  if (stored.consumedAt) {
    await failed('token already used');
    throw invalid;
  }
  if (stored.invalidatedAt) {
    await failed('token superseded by a newer request');
    throw invalid;
  }
  if (stored.expiresAt <= new Date()) {
    await failed('token expired');
    throw invalid;
  }
  if (BLOCKED_STATUSES.has(stored.userStatus)) {
    await failed(`account status is ${stored.userStatus}`);
    throw invalid;
  }

  // Re-setting the same password leaves the account exactly as exposed as
  // whatever prompted the reset. Checked after the token is validated, so it
  // costs an Argon2 verify only for someone holding a genuine link.
  if (await verifyPassword(input.password, stored.currentPasswordHash)) {
    await failed('new password matches the current one');
    throw AppError.badRequest(
      'Your new password must be different from your current password.',
    );
  }

  const newPasswordHash = await hashPassword(input.password);
  const completed = await repo.completeReset({
    tokenId: stored.id,
    userId: stored.userId,
    newPasswordHash,
  });

  // Lost a race with a concurrent use of the same link.
  if (!completed) {
    await failed('token consumed concurrently');
    throw invalid;
  }

  await auditService.record({
    ...audit,
    userId: stored.userId,
    subjectEmail: stored.email,
    action: 'PASSWORD_RESET_COMPLETED',
    outcome: 'SUCCESS',
    reason: 'all sessions revoked',
  });

  logger.info({ userId: stored.userId }, 'password reset completed; sessions revoked');

  // Best-effort warning to the account holder. If the reset was not theirs,
  // this is how they find out. Never allowed to fail the request.
  void notificationService
    .sendPasswordChanged({ to: stored.email, fullName: stored.fullName })
    .catch((error: unknown) => {
      logger.error({ err: error, userId: stored.userId }, 'password change notice failed to send');
    });

  return {
    message: 'Your password has been changed. You have been signed out everywhere. Please sign in with your new password.',
  };
}

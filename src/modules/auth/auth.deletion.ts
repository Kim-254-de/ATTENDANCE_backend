import { AppError, ErrorCode } from '../../common/errors/index.js';
import { verifyPassword } from '../../common/utils/password.js';
import { logger } from '../../config/logger.js';
import { transaction } from '../../db/database.js';
import { smartttClient } from '../../integrations/smarttt/index.js';
import { auditService } from '../audit/index.js';
import * as deletionRepository from './auth.deletion.repository.js';
import type { DeletableRole } from './auth.deletion.repository.js';
import type { RegistrationContext } from './auth.service.js';
import { smartttAccountsEnabled } from './auth.smarttt.js';

/**
 * Deleting a student or lecturer account: by its owner (DELETE /auth/me), or
 * by a department or faculty officer for someone in their scope (the
 * department and faculty modules check the scope, then call deleteAccount).
 *
 * The account is anonymised, not removed (auth.deletion.repository.ts):
 * attendance figures stay correct, but nothing left in them names the person.
 * The audit row records that it happened and who did it, but carries none of
 * the erased details either.
 */

export type DeletedBy = 'SELF' | 'DEPARTMENT' | 'FACULTY';

export interface DeletionActor {
  userId: string;
  kind: DeletedBy;
}

/**
 * Anonymises one account. 404 when it is not a live account of `role`, which
 * also covers a second, simultaneous request for the same account.
 */
export async function deleteAccount(
  targetUserId: string,
  role: DeletableRole,
  actor: DeletionActor,
  context: RegistrationContext,
): Promise<void> {
  const notFound = () =>
    AppError.notFound(role === 'STUDENT' ? 'Student account not found.' : 'Lecturer account not found.');

  await transaction(async (client) => {
    if (!(await deletionRepository.anonymiseAccount(client, targetUserId, role))) throw notFound();
    await auditService.recordInTransaction(client, {
      action: 'ACCOUNT_DELETED',
      outcome: 'SUCCESS',
      userId: targetUserId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { role, deletedBy: actor.kind, actorUserId: actor.userId },
    });
  });
  logger.info({ userId: targetUserId, role, deletedBy: actor.kind }, 'account deleted');
}

/**
 * DELETE /auth/me. The password is checked the way the account signs in:
 * SMARTTT's, with SMARTTT accounts on, otherwise the one held here.
 */
export async function deleteOwnAccount(userId: string, password: string, context: RegistrationContext): Promise<void> {
  const account = await deletionRepository.findDeletableAccount(userId);
  if (!account) throw AppError.notFound('Account not found.');

  let confirmed: boolean;
  if (smartttAccountsEnabled()) {
    if (!account.number) throw AppError.badRequest('Your account has no registration or staff number to confirm with.');
    const answer = await smartttClient.authenticate(account.number, password);
    if (answer.status !== 'AUTHENTICATED' && answer.status !== 'INVALID_CREDENTIALS') {
      throw new AppError(
        503,
        ErrorCode.SMARTTT_UNAVAILABLE,
        'Your password could not be checked: SMARTTT could not be reached. Nothing was deleted. Try again in a minute.',
      );
    }
    // The SMARTTT account that answered must be the one this account is linked to.
    confirmed =
      answer.status === 'AUTHENTICATED' &&
      (account.smartttUserId === null || answer.account.smartttUserId === account.smartttUserId);
  } else {
    confirmed = await verifyPassword(password, account.passwordHash);
  }

  if (!confirmed) {
    await auditService.record({
      action: 'ACCOUNT_DELETED',
      outcome: 'FAILURE',
      userId,
      reason: 'password did not match',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    throw AppError.badRequest('Your password is incorrect.');
  }

  await deleteAccount(userId, account.role, { userId, kind: 'SELF' }, context);
}

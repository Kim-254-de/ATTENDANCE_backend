import { query, queryOne, transaction } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';

/** SQL for password reset. Every value goes through a bind parameter. */

export interface ResetCandidate {
  id: string;
  email: string;
  fullName: string;
  status: AccountStatus;
}

/**
 * The account a reset link would belong to, or null.
 *
 * Soft-deleted users are excluded. Status is returned rather than filtered so
 * the service can decide — and so the caller can log *why* nothing was sent
 * without the endpoint's response changing.
 */
export async function findUserForReset(email: string): Promise<ResetCandidate | null> {
  const row = await queryOne<{
    id: string;
    email: string;
    full_name: string;
    status: AccountStatus;
  }>(
    `SELECT id, email, full_name, status
       FROM users
      WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );

  if (!row) return null;
  return { id: row.id, email: row.email, fullName: row.full_name, status: row.status };
}

/**
 * Stores a new reset token and retires any earlier unused ones for that user,
 * so only the most recent link in an inbox works. Both happen in one
 * transaction: a window where the old token is dead and the new one is not yet
 * stored would lock the user out of their own reset.
 */
export async function issueResetToken(args: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  requestedIp: string | null;
}): Promise<void> {
  await transaction(async (client) => {
    await query(
      `UPDATE password_reset_tokens
          SET invalidated_at = NOW()
        WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [args.userId],
      client,
    );
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [args.userId, args.tokenHash, args.expiresAt, args.requestedIp],
      client,
    );
  });
}

export interface StoredResetToken {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  userStatus: AccountStatus;
  currentPasswordHash: string;
  email: string;
  fullName: string;
}

export async function findResetToken(tokenHash: string): Promise<StoredResetToken | null> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    expires_at: Date;
    consumed_at: Date | null;
    invalidated_at: Date | null;
    status: AccountStatus;
    password_hash: string;
    email: string;
    full_name: string;
    deleted_at: Date | null;
  }>(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at, t.invalidated_at,
            u.status, u.password_hash, u.email, u.full_name, u.deleted_at
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [tokenHash],
  );

  if (!row || row.deleted_at) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    invalidatedAt: row.invalidated_at,
    userStatus: row.status,
    currentPasswordHash: row.password_hash,
    email: row.email,
    fullName: row.full_name,
  };
}

/**
 * Completes the reset as one atomic unit:
 *
 *  1. Consume the token — guarded by `consumed_at IS NULL`, so two requests
 *     racing with the same link cannot both succeed.
 *  2. Retire the user's other outstanding tokens.
 *  3. Set the new password and clear the lockout. Someone who locked themselves
 *     out by forgetting their password should be able to sign in immediately.
 *  4. Revoke every live session. This is the step that matters most: if an
 *     attacker is why the password is being reset, leaving their session alive
 *     would make the reset pointless.
 *
 * Returns false when the token was already consumed by a concurrent request.
 */
export async function completeReset(args: {
  tokenId: string;
  userId: string;
  newPasswordHash: string;
}): Promise<boolean> {
  return transaction(async (client) => {
    const consumed = await query(
      `UPDATE password_reset_tokens
          SET consumed_at = NOW()
        WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [args.tokenId],
      client,
    );

    if (consumed.rowCount === 0) return false;

    await query(
      `UPDATE password_reset_tokens
          SET invalidated_at = NOW()
        WHERE user_id = $1 AND id <> $2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [args.userId, args.tokenId],
      client,
    );

    await query(
      `UPDATE users
          SET password_hash = $2,
              failed_login_attempts = 0,
              locked_until = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [args.userId, args.newPasswordHash],
      client,
    );

    await query(
      `UPDATE auth_sessions
          SET revoked_at = NOW(), revoked_reason = 'password_reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [args.userId],
      client,
    );

    return true;
  });
}

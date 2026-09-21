import type { PoolClient } from 'pg';
import { query, queryOne, transaction, type Queryable } from '../../db/database.js';
import type { AccountStatus, UserRole } from '../../db/types.js';

/**
 * All database access for the auth module.
 *
 * Every query is parameterised — values go through `$1, $2 …`, never string
 * interpolation. Keeping the SQL here means the service layer reads as policy
 * rather than as queries.
 */

export interface ExistingAccountCheck {
  emailTaken: boolean;
  staffNumberTaken: boolean;
}

/**
 * Pre-flight uniqueness check. This is an advisory look — the authoritative
 * guarantee is the unique index on the table, which is what makes two
 * simultaneous registrations safe. The service handles that race separately.
 */
export async function findConflictingAccounts(
  email: string,
  staffNumber: string,
): Promise<ExistingAccountCheck> {
  const row = await queryOne<{ email_taken: boolean; staff_number_taken: boolean }>(
    `SELECT
       EXISTS (SELECT 1 FROM users WHERE email = $1)                       AS email_taken,
       EXISTS (SELECT 1 FROM lecturer_profiles WHERE staff_number = $2)    AS staff_number_taken`,
    [email, staffNumber],
  );

  return {
    emailTaken: row?.email_taken ?? false,
    staffNumberTaken: row?.staff_number_taken ?? false,
  };
}

export interface CreateLecturerArgs {
  email: string;
  fullName: string;
  passwordHash: string;
  status: AccountStatus;
  staffNumber: string;
  erpStaffId: string | null;
  /** Verbatim ERP payload, stored as evidence against future disputes. */
  erpSnapshot: unknown;
  title: string | null;
  department: string | null;
  faculty: string | null;
  emailVerificationTokenHash: string;
  emailVerificationExpiresAt: Date;
}

export interface CreatedLecturer {
  userId: string;
  email: string;
  fullName: string;
  status: AccountStatus;
  staffNumber: string;
  createdAt: Date;
}

/**
 * Creates the user, the lecturer profile and the email verification token as
 * one unit. A half-created lecturer — an account with no profile, or a profile
 * with no way to verify the address — would be unrecoverable without manual
 * database surgery, so all three are written in a single transaction.
 *
 * `onCreated` runs inside that same transaction, so the audit entry for a
 * successful registration commits with the account or not at all.
 */
export async function createLecturerAccount(
  args: CreateLecturerArgs,
  onCreated?: (client: PoolClient, userId: string) => Promise<void>,
): Promise<CreatedLecturer> {
  return transaction(async (client) => {
    const user = await queryOne<{
      id: string;
      email: string;
      full_name: string;
      status: AccountStatus;
      created_at: Date;
    }>(
      `INSERT INTO users (email, password_hash, full_name, role, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, full_name, status, created_at`,
      [args.email, args.passwordHash, args.fullName, 'LECTURER' satisfies UserRole, args.status],
      client,
    );

    if (!user) {
      // An INSERT ... RETURNING that yields no row means a rule or trigger
      // swallowed it; continuing would create an orphaned profile.
      throw new Error('user insert returned no row');
    }

    await query(
      `INSERT INTO lecturer_profiles
         (user_id, staff_number, title, department, faculty, erp_staff_id, erp_verified_at, erp_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
      [
        user.id,
        args.staffNumber,
        args.title,
        args.department,
        args.faculty,
        args.erpStaffId,
        // jsonb column: pg serialises an object, so the payload is stored as
        // JSON rather than as the string "[object Object]".
        JSON.stringify(args.erpSnapshot ?? null),
      ],
      client,
    );

    await query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, args.emailVerificationTokenHash, args.emailVerificationExpiresAt],
      client,
    );

    if (onCreated) {
      await onCreated(client, user.id);
    }

    return {
      userId: user.id,
      email: user.email,
      fullName: user.full_name,
      status: user.status,
      staffNumber: args.staffNumber,
      createdAt: user.created_at,
    };
  });
}

export interface VerifiableToken {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  userStatus: AccountStatus;
  userRole: UserRole;
  emailVerifiedAt: Date | null;
}

export async function findEmailVerificationToken(
  tokenHash: string,
  client?: Queryable,
): Promise<VerifiableToken | null> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    expires_at: Date;
    consumed_at: Date | null;
    status: AccountStatus;
    role: UserRole;
    email_verified_at: Date | null;
  }>(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at,
            u.status, u.role, u.email_verified_at
       FROM email_verification_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [tokenHash],
    client,
  );

  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    userStatus: row.status,
    userRole: row.role,
    emailVerifiedAt: row.email_verified_at,
  };
}

/**
 * Marks the address verified and moves the account to its next status.
 *
 * The `consumed_at IS NULL` guard makes consumption atomic: two concurrent
 * requests carrying the same token cannot both succeed, because the second
 * UPDATE matches zero rows. Returns false in that case.
 */
export async function consumeEmailVerificationToken(
  tokenId: string,
  userId: string,
  nextStatus: AccountStatus,
): Promise<boolean> {
  return transaction(async (client) => {
    const consumed = await query(
      `UPDATE email_verification_tokens
          SET consumed_at = NOW()
        WHERE id = $1 AND consumed_at IS NULL`,
      [tokenId],
      client,
    );

    if (consumed.rowCount === 0) return false;

    await query(
      `UPDATE users
          SET email_verified_at = NOW(),
              status = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [userId, nextStatus],
      client,
    );

    return true;
  });
}

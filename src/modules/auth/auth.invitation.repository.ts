import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';

/**
 * SQL for invited accounts (auth.invitation.ts): administrators, management,
 * department officers, QA officers and the timetabling office. Every value goes through a bind parameter.
 */

export type InvitedRole = 'ADMIN' | 'MANAGEMENT' | 'DEPARTMENT' | 'QA' | 'TIMETABLING';

/** What an invitation is for: the role, and for a department officer the department (the others are university-wide). */
export type InvitationScope =
  | { role: 'ADMIN' }
  | { role: 'QA' }
  | { role: 'MANAGEMENT' }
  | { role: 'TIMETABLING' }
  | { role: 'DEPARTMENT'; departmentId: string };

export interface ExistingAccount {
  userId: string;
  role: string;
  status: AccountStatus;
}

/** The live account holding this email, if any. */
export async function findAccountByEmail(email: string): Promise<ExistingAccount | null> {
  const row = await queryOne<{ id: string; role: string; status: AccountStatus }>(
    `SELECT id, role, status FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );
  return row ? { userId: row.id, role: row.role, status: row.status } : null;
}

/** Whether any administrator can sign in. */
export async function hasActiveAdmin(): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL
     ) AS found`,
  );
  return row?.found ?? false;
}

/** Withdraws an account's unused invitations; the account itself is left as it is. */
export async function withdrawInvitations(userId: string): Promise<void> {
  await query(
    `UPDATE account_invitations SET invalidated_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [userId],
  );
}

/**
 * Creates the invited account: PENDING_VERIFICATION, with a password hash
 * nothing can match, plus its department or QA profile.
 */
export async function createInvitedAccount(
  client: PoolClient,
  args: { email: string; fullName: string; scope: InvitationScope },
): Promise<string> {
  const { rows: [user] } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status)
     VALUES ($1, '!', $2, $3, 'PENDING_VERIFICATION') RETURNING id`,
    [args.email, args.fullName, args.scope.role],
    client,
  );
  await setScope(client, user!.id, args.scope);
  return user!.id;
}

/**
 * Re-invites a deactivated account of the same role (someone returning to the
 * post): back to PENDING_VERIFICATION with no usable password, re-scoped to
 * wherever the new invitation is for.
 */
export async function reopenInvitedAccount(
  client: PoolClient,
  args: { userId: string; fullName: string; scope: InvitationScope },
): Promise<void> {
  await query(
    `UPDATE users
        SET full_name = $2, password_hash = '!', status = 'PENDING_VERIFICATION',
            email_verified_at = NULL, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
      WHERE id = $1`,
    [args.userId, args.fullName],
    client,
  );
  await setScope(client, args.userId, args.scope);
}

async function setScope(client: PoolClient, userId: string, scope: InvitationScope): Promise<void> {
  if (scope.role === 'DEPARTMENT') {
    await query(
      `INSERT INTO department_profiles (user_id, department_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET department_id = EXCLUDED.department_id, updated_at = NOW()`,
      [userId, scope.departmentId],
      client,
    );
  } else if (scope.role === 'QA') {
    await query(`INSERT INTO qa_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId], client);
  }
}

/** Stores a new invitation and retires the account's earlier unused ones, so only the newest link works. */
export async function issueInvitation(
  client: PoolClient,
  args: { userId: string; tokenHash: string; expiresAt: Date; invitedByUserId: string | null },
): Promise<void> {
  await query(
    `UPDATE account_invitations SET invalidated_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [args.userId],
    client,
  );
  await query(
    `INSERT INTO account_invitations (user_id, token_hash, expires_at, invited_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [args.userId, args.tokenHash, args.expiresAt, args.invitedByUserId],
    client,
  );
}

export interface StoredInvitation {
  id: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
  role: InvitedRole;
  status: AccountStatus;
  email: string;
  fullName: string;
  /** The department's name; null for the university-wide roles. */
  scopeName: string | null;
}

export async function findInvitation(tokenHash: string): Promise<StoredInvitation | null> {
  const row = await queryOne<{
    id: string; user_id: string; expires_at: Date; consumed_at: Date | null; invalidated_at: Date | null;
    role: InvitedRole; status: AccountStatus; email: string; full_name: string; deleted_at: Date | null;
    scope_name: string | null;
  }>(
    `SELECT i.id, i.user_id, i.expires_at, i.consumed_at, i.invalidated_at,
            u.role, u.status, u.email, u.full_name, u.deleted_at,
            d.name AS scope_name
       FROM account_invitations i
       JOIN users u ON u.id = i.user_id
  LEFT JOIN department_profiles dp ON dp.user_id = u.id
  LEFT JOIN departments         d  ON d.id = dp.department_id
      WHERE i.token_hash = $1 AND u.role IN ('ADMIN', 'MANAGEMENT', 'DEPARTMENT', 'QA', 'TIMETABLING')`,
    [tokenHash],
  );
  if (!row || row.deleted_at) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    invalidatedAt: row.invalidated_at,
    role: row.role,
    status: row.status,
    email: row.email,
    fullName: row.full_name,
    scopeName: row.scope_name,
  };
}

/**
 * Accepts an invitation as one unit: consume the token (guarded, so the same
 * link racing itself succeeds once), set the password, and make the account
 * ACTIVE with its email confirmed. False when the token was already used.
 */
export async function acceptInvitation(args: { invitationId: string; userId: string; passwordHash: string }): Promise<boolean> {
  return transaction(async (client) => {
    const consumed = await query(
      `UPDATE account_invitations SET consumed_at = NOW()
        WHERE id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > NOW()`,
      [args.invitationId],
      client,
    );
    if (consumed.rowCount === 0) return false;
    await query(
      `UPDATE users
          SET password_hash = $2, status = 'ACTIVE', email_verified_at = NOW(),
              failed_login_attempts = 0, locked_until = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'PENDING_VERIFICATION'`,
      [args.userId, args.passwordHash],
      client,
    );
    return true;
  });
}

export interface OfficerRow {
  userId: string;
  role: InvitedRole;
  fullName: string;
  email: string;
  status: AccountStatus;
  departmentId: string | null;
  departmentName: string | null;
  /** When the most recent invitation was sent. */
  invitedAt: Date | null;
  /** When the most recent unused invitation stops working; null once accepted or withdrawn. */
  invitationExpiresAt: Date | null;
  lastLoginAt: Date | null;
}

/** Administrators, management, department and QA officers. */
export async function listOfficers(filter: { roles: InvitedRole[]; userId?: string }): Promise<OfficerRow[]> {
  const { rows } = await query<{
    id: string; role: InvitedRole; full_name: string; email: string; status: AccountStatus;
    department_id: string | null; department_name: string | null;
    invited_at: Date | null; invitation_expires_at: Date | null; last_login_at: Date | null;
  }>(
    `SELECT u.id, u.role, u.full_name, u.email, u.status, u.last_login_at,
            d.id AS department_id, d.name AS department_name,
            inv.created_at AS invited_at,
            CASE WHEN inv.consumed_at IS NULL AND inv.invalidated_at IS NULL THEN inv.expires_at END AS invitation_expires_at
       FROM users u
  LEFT JOIN department_profiles dp ON dp.user_id = u.id
  LEFT JOIN departments         d  ON d.id = dp.department_id
  LEFT JOIN LATERAL (
         SELECT created_at, expires_at, consumed_at, invalidated_at FROM account_invitations
          WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
       ) inv ON TRUE
      WHERE u.deleted_at IS NULL
        AND u.role = ANY($1::text[])
        AND ($2::uuid IS NULL OR u.id = $2)
      ORDER BY u.status = 'DEACTIVATED', d.name NULLS FIRST, u.full_name`,
    [filter.roles, filter.userId ?? null],
  );
  return rows.map((r) => ({
    userId: r.id,
    role: r.role,
    fullName: r.full_name,
    email: r.email,
    status: r.status,
    departmentId: r.department_id,
    departmentName: r.department_name,
    invitedAt: r.invited_at,
    invitationExpiresAt: r.invitation_expires_at,
    lastLoginAt: r.last_login_at,
  }));
}

/** Removes an officer's access: DEACTIVATED, every session revoked, every outstanding invitation withdrawn. */
export async function deactivateAccount(userId: string): Promise<boolean> {
  return transaction(async (client) => {
    const updated = await query(
      `UPDATE users SET status = 'DEACTIVATED', updated_at = NOW()
        WHERE id = $1 AND status <> 'DEACTIVATED' AND deleted_at IS NULL`,
      [userId],
      client,
    );
    if (updated.rowCount === 0) return false;
    await query(
      `UPDATE account_invitations SET invalidated_at = NOW()
        WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
      [userId],
      client,
    );
    await query(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = 'deactivated'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
      client,
    );
    return true;
  });
}

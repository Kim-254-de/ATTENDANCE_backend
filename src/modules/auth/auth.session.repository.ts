import { query, queryOne, transaction } from '../../db/database.js';
import type { AccountStatus, UserRole } from '../../db/types.js';

/** SQL for sign-in and sessions. Every value goes through a bind parameter. */

/** What the portal shows about a signed-in lecturer. */
export interface LecturerPublic {
  id: string;
  role: 'lecturer';
  fullName: string;
  email: string;
  staffNumber: string;
  title: string;
  department: string;
}

export interface LoginCandidate {
  id: string;
  email: string;
  fullName: string;
  passwordHash: string;
  status: AccountStatus;
  failedAttempts: number;
  lockedUntil: Date | null;
  staffNumber: string;
  title: string | null;
  department: string | null;
}

interface LoginRow {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
  status: AccountStatus;
  failed_login_attempts: number;
  locked_until: Date | null;
  staff_number: string;
  title: string | null;
  department: string | null;
}

export const toLecturerPublic = (c: {
  id: string; fullName: string; email: string; staffNumber: string; title: string | null; department: string | null;
}): LecturerPublic => ({
  id: c.id,
  role: 'lecturer',
  fullName: c.fullName,
  email: c.email,
  staffNumber: c.staffNumber,
  title: c.title ?? '',
  department: c.department ?? '',
});

/** `identifier` is already normalised: lower-cased email, or upper-cased staff number. */
export async function findLecturerForLogin(identifier: string): Promise<LoginCandidate | null> {
  const byEmail = identifier.includes('@');
  const row = await queryOne<LoginRow>(
    `SELECT u.id, u.email, u.full_name, u.password_hash, u.status,
            u.failed_login_attempts, u.locked_until,
            p.staff_number, p.title, p.department
       FROM users u
       JOIN lecturer_profiles p ON p.user_id = u.id
      WHERE u.role = 'LECTURER'
        AND u.deleted_at IS NULL
        AND ${byEmail ? 'u.email' : 'p.staff_number'} = $1`,
    [identifier],
  );
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    status: row.status,
    failedAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until,
    staffNumber: row.staff_number,
    title: row.title,
    department: row.department,
  };
}

/**
 * Counts a wrong password and locks the account once the limit is reached.
 * The row is locked (FOR UPDATE) so two simultaneous wrong guesses both count, and an
 * expired lock starts a fresh count instead of re-locking on the very next mistake.
 */
export async function recordFailedLogin(
  userId: string,
  maxAttempts: number,
  lockoutMinutes: number,
): Promise<{ failedAttempts: number; lockedUntil: Date | null }> {
  const row = await queryOne<{ failed_login_attempts: number; locked_until: Date | null }>(
    `WITH cur AS (
       SELECT id,
              CASE WHEN locked_until IS NOT NULL AND locked_until <= NOW() THEN 0
                   ELSE failed_login_attempts END AS attempts
         FROM users WHERE id = $1 FOR UPDATE
     )
     UPDATE users u
        SET failed_login_attempts = cur.attempts + 1,
            locked_until = CASE WHEN cur.attempts + 1 >= $2
                                THEN NOW() + make_interval(mins => $3) ELSE NULL END
       FROM cur
      WHERE u.id = cur.id
  RETURNING u.failed_login_attempts, u.locked_until`,
    [userId, maxAttempts, lockoutMinutes],
  );
  return { failedAttempts: row?.failed_login_attempts ?? 0, lockedUntil: row?.locked_until ?? null };
}

export interface NewSession {
  sessionId: string;
  userId: string;
  refreshTokenHash: string;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
}

/** Successful sign-in: clear the failure counter and open the session in one transaction. */
export async function completeLogin(session: NewSession): Promise<void> {
  await transaction(async (client) => {
    await query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
      [session.userId],
      client,
    );
    await query(
      `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, ip_address, user_agent, expires_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [session.sessionId, session.userId, session.refreshTokenHash, session.ipAddress, session.userAgent, session.expiresAt],
      client,
    );
  });
}

export interface LiveSession {
  sessionId: string;
  userId: string;
  role: UserRole;
  status: AccountStatus;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lecturer: LecturerPublic | null;
}

/** A session with its owner, or null. Callers decide what "usable" means. */
export async function findSession(sessionId: string): Promise<LiveSession | null> {
  const row = await queryOne<{
    id: string; user_id: string; refresh_token_hash: string; expires_at: Date; revoked_at: Date | null;
    role: UserRole; status: AccountStatus; deleted_at: Date | null;
    email: string; full_name: string; staff_number: string | null; title: string | null; department: string | null;
  }>(
    `SELECT s.id, s.user_id, s.refresh_token_hash, s.expires_at, s.revoked_at,
            u.role, u.status, u.deleted_at, u.email, u.full_name,
            p.staff_number, p.title, p.department
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
  LEFT JOIN lecturer_profiles p ON p.user_id = u.id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!row || row.deleted_at) return null;
  return {
    sessionId: row.id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    refreshTokenHash: row.refresh_token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lecturer:
      row.role === 'LECTURER' && row.staff_number
        ? toLecturerPublic({
            id: row.user_id, fullName: row.full_name, email: row.email,
            staffNumber: row.staff_number, title: row.title, department: row.department,
          })
        : null,
  };
}

/** Swaps the refresh hash only if it still equals the one presented (atomic rotation). */
export async function rotateRefreshHash(sessionId: string, oldHash: string, newHash: string): Promise<boolean> {
  const result = await query(
    `UPDATE auth_sessions
        SET refresh_token_hash = $3, last_used_at = NOW()
      WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
    [sessionId, oldHash, newHash],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

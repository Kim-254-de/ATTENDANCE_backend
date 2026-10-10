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
  status: AccountStatus;
}

/** What the app shows about a signed-in student. */
export interface StudentPublic {
  id: string;
  role: 'student';
  fullName: string;
  email: string;
  registrationNumber: string;
  programme: string | null;
  yearOfStudy: number | null;
  status: AccountStatus;
}

/**
 * What the portal shows about a signed-in department officer. The department is
 * resolved here, once, so every department-scoped screen has the name without
 * another lookup — the authoritative scoping check still re-reads
 * `department_profiles` server-side (department.service.ts).
 */
export interface DepartmentOfficerPublic {
  id: string;
  role: 'department';
  fullName: string;
  email: string;
  departmentId: string;
  departmentName: string;
  status: AccountStatus;
}

/** Whoever is signed in: what GET /auth/me and sign-in return. */
export type AccountPublic = LecturerPublic | StudentPublic | DepartmentOfficerPublic;

export const toStudentPublic = (c: {
  id: string; fullName: string; email: string; registrationNumber: string;
  programme: string | null; yearOfStudy: number | null; status: AccountStatus;
}): StudentPublic => ({
  id: c.id,
  role: 'student',
  fullName: c.fullName,
  email: c.email,
  registrationNumber: c.registrationNumber,
  programme: c.programme,
  yearOfStudy: c.yearOfStudy,
  status: c.status,
});

export interface LoginCandidate {
  id: string;
  role: 'LECTURER' | 'STUDENT' | 'DEPARTMENT';
  email: string;
  fullName: string;
  passwordHash: string;
  status: AccountStatus;
  failedAttempts: number;
  lockedUntil: Date | null;
  /** What the app shows once signed in. */
  account: AccountPublic;
}

interface LoginRow {
  id: string;
  role: 'LECTURER' | 'STUDENT' | 'DEPARTMENT';
  email: string;
  full_name: string;
  password_hash: string;
  status: AccountStatus;
  failed_login_attempts: number;
  locked_until: Date | null;
  staff_number: string | null;
  title: string | null;
  department: string | null;
  registration_number: string | null;
  programme: string | null;
  year_of_study: number | null;
  department_id: string | null;
  department_name: string | null;
}

/** The public shape for a session or login row; null when its profile row is missing. */
function accountFrom(row: {
  id: string; role: UserRole; email: string; full_name: string; status: AccountStatus;
  staff_number: string | null; title: string | null; department: string | null;
  registration_number: string | null; programme: string | null; year_of_study: number | null;
  department_id: string | null; department_name: string | null;
}): AccountPublic | null {
  if (row.role === 'LECTURER' && row.staff_number) {
    return toLecturerPublic({
      id: row.id, fullName: row.full_name, email: row.email, staffNumber: row.staff_number,
      title: row.title, department: row.department, status: row.status,
    });
  }
  if (row.role === 'STUDENT' && row.registration_number) {
    return toStudentPublic({
      id: row.id, fullName: row.full_name, email: row.email, registrationNumber: row.registration_number,
      programme: row.programme, yearOfStudy: row.year_of_study, status: row.status,
    });
  }
  if (row.role === 'DEPARTMENT' && row.department_id) {
    return toDepartmentOfficerPublic({
      id: row.id, fullName: row.full_name, email: row.email,
      departmentId: row.department_id, departmentName: row.department_name, status: row.status,
    });
  }
  return null;
}

export const toLecturerPublic = (c: {
  id: string; fullName: string; email: string; staffNumber: string; title: string | null; department: string | null;
  status: AccountStatus;
}): LecturerPublic => ({
  id: c.id,
  role: 'lecturer',
  fullName: c.fullName,
  email: c.email,
  staffNumber: c.staffNumber,
  title: c.title ?? '',
  department: c.department ?? '',
  status: c.status,
});

export const toDepartmentOfficerPublic = (c: {
  id: string; fullName: string; email: string; departmentId: string; departmentName: string | null;
  status: AccountStatus;
}): DepartmentOfficerPublic => ({
  id: c.id,
  role: 'department',
  fullName: c.fullName,
  email: c.email,
  departmentId: c.departmentId,
  departmentName: c.departmentName ?? '',
  status: c.status,
});

/**
 * A lecturer, student or department-officer account for sign-in. `identifier` is already
 * normalised: a lower-cased email, or an upper-cased staff number
 * (lecturers) or registration number (students).
 */
export async function findAccountForLogin(identifier: string): Promise<LoginCandidate | null> {
  const byEmail = identifier.includes('@');
  const row = await queryOne<LoginRow>(
    `SELECT u.id, u.role, u.email, u.full_name, u.password_hash, u.status,
            u.failed_login_attempts, u.locked_until,
            p.staff_number, p.title, p.department,
            sp.registration_number, sp.programme, sp.year_of_study,
            dp.department_id, d.name AS department_name
       FROM users u
  LEFT JOIN lecturer_profiles   p  ON p.user_id = u.id
  LEFT JOIN student_profiles    sp ON sp.user_id = u.id
  LEFT JOIN department_profiles dp ON dp.user_id = u.id
  LEFT JOIN departments         d  ON d.id = dp.department_id
      WHERE u.role IN ('LECTURER', 'STUDENT', 'DEPARTMENT')
        AND u.deleted_at IS NULL
        AND ${byEmail ? 'u.email = $1' : '(p.staff_number = $1 OR sp.registration_number = $1)'}
      ORDER BY u.role
      LIMIT 1`,
    [identifier],
  );
  if (!row) return null;
  const account = accountFrom(row);
  if (!account) return null; // a user without its profile row cannot be shown as anyone
  return {
    id: row.id,
    role: row.role,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    status: row.status,
    failedAttempts: row.failed_login_attempts,
    lockedUntil: row.locked_until,
    account,
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
  student: StudentPublic | null;
  department: DepartmentOfficerPublic | null;
}

/** A session with its owner, or null. Callers decide what "usable" means. */
export async function findSession(sessionId: string): Promise<LiveSession | null> {
  const row = await queryOne<{
    id: string; user_id: string; refresh_token_hash: string; expires_at: Date; revoked_at: Date | null;
    role: UserRole; status: AccountStatus; deleted_at: Date | null;
    email: string; full_name: string; staff_number: string | null; title: string | null; department: string | null;
    registration_number: string | null; programme: string | null; year_of_study: number | null;
    department_id: string | null; department_name: string | null;
  }>(
    `SELECT s.id, s.user_id, s.refresh_token_hash, s.expires_at, s.revoked_at,
            u.role, u.status, u.deleted_at, u.email, u.full_name,
            p.staff_number, p.title, p.department,
            sp.registration_number, sp.programme, sp.year_of_study,
            dp.department_id, d.name AS department_name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
  LEFT JOIN lecturer_profiles   p  ON p.user_id = u.id
  LEFT JOIN student_profiles    sp ON sp.user_id = u.id
  LEFT JOIN department_profiles dp ON dp.user_id = u.id
  LEFT JOIN departments         d  ON d.id = dp.department_id
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
    ...(() => {
      const account = accountFrom({ ...row, id: row.user_id });
      return {
        lecturer: account?.role === 'lecturer' ? account : null,
        student: account?.role === 'student' ? account : null,
        department: account?.role === 'department' ? account : null,
      };
    })(),
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

/**
 * For change-password: signs out every other device but not the session
 * making the change. Unlike the emailed-token reset flow (which has no
 * session to trust and revokes all of them), this one already has proof —
 * the caller just presented the current password.
 */
export async function revokeOtherSessions(
  userId: string,
  exceptSessionId: string,
  reason: string,
): Promise<void> {
  await query(
    `UPDATE auth_sessions
        SET revoked_at = NOW(), revoked_reason = $3
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, exceptSessionId, reason],
  );
}

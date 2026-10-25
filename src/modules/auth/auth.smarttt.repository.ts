import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';
import { DEPARTMENT_BY_NAME } from './auth.repository.js';

/** SQL for linking attendance accounts to SMARTTT accounts (auth.smarttt.ts). Every query is parameterised. */

export type LinkedRole = 'STUDENT' | 'LECTURER';

export interface LinkCandidate {
  userId: string;
  role: string;
  status: AccountStatus;
  smartttUserId: string | null;
  /** Registration number (student) or staff number (lecturer). */
  number: string | null;
  /** True when found by SMARTTT id, false when found by number. */
  byId: boolean;
}

/**
 * The attendance account for a SMARTTT account: the one already linked to its
 * id, else the student or lecturer holding the same number (an account
 * registered here before sign-in moved to SMARTTT).
 */
export async function findLinkCandidate(smartttUserId: string, role: LinkedRole, number: string): Promise<LinkCandidate | null> {
  const row = await queryOne<{
    id: string;
    role: string;
    status: AccountStatus;
    smarttt_user_id: string | null;
    number: string | null;
    by_id: boolean;
  }>(
    `SELECT u.id, u.role, u.status, u.smarttt_user_id,
            COALESCE(sp.registration_number, p.staff_number) AS number,
            (u.smarttt_user_id IS NOT DISTINCT FROM $1) AS by_id
       FROM users u
  LEFT JOIN student_profiles  sp ON sp.user_id = u.id
  LEFT JOIN lecturer_profiles p  ON p.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND (u.smarttt_user_id = $1
             OR ($2 = 'STUDENT'  AND sp.registration_number = $3)
             OR ($2 = 'LECTURER' AND p.staff_number = $3))
      ORDER BY by_id DESC
      LIMIT 1`,
    [smartttUserId, role, number],
  );
  if (!row) return null;
  return {
    userId: row.id,
    role: row.role,
    status: row.status,
    smartttUserId: row.smarttt_user_id,
    number: row.number,
    byId: row.by_id,
  };
}

/** Whether another account already uses this email. */
export async function isEmailTakenByOther(email: string, userId: string | null): Promise<boolean> {
  const row = await queryOne<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE email = $1 AND ($2::uuid IS NULL OR id <> $2)) AS taken`,
    [email, userId],
  );
  return row?.taken ?? false;
}

/** Whether another account already holds this registration or staff number. */
export async function isNumberTakenByOther(role: LinkedRole, number: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ taken: boolean }>(
    role === 'STUDENT'
      ? `SELECT EXISTS (SELECT 1 FROM student_profiles WHERE registration_number = $1 AND user_id <> $2) AS taken`
      : `SELECT EXISTS (SELECT 1 FROM lecturer_profiles WHERE staff_number = $1 AND user_id <> $2) AS taken`,
    [number, userId],
  );
  return row?.taken ?? false;
}

export async function setSmartttUserId(userId: string, smartttUserId: string, client?: PoolClient): Promise<void> {
  await query(`UPDATE users SET smarttt_user_id = $2, updated_at = NOW() WHERE id = $1`, [userId, smartttUserId], client);
}

/**
 * Brings a linked account up to date with SMARTTT at sign-in: SMARTTT's
 * name, email and number win. A pending account becomes ACTIVE (SMARTTT
 * vouches for it); a suspended or deactivated one stays as an administrator
 * left it.
 */
export async function refreshLinkedAccount(args: {
  userId: string;
  smartttUserId: string;
  role: LinkedRole;
  fullName: string | null;
  email: string | null;
  number: string;
  student?: { programme: string | null; yearOfStudy: number | null; snapshot: unknown };
  lecturer?: { title: string | null; department: string | null; snapshot: unknown };
}): Promise<void> {
  await query(
    `UPDATE users
        SET smarttt_user_id = $2,
            full_name = COALESCE($3, full_name),
            email = COALESCE($4, email),
            status = CASE WHEN status IN ('PENDING_VERIFICATION', 'PENDING_APPROVAL') THEN 'ACTIVE' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [args.userId, args.smartttUserId, args.fullName, args.email],
  );
  if (args.role === 'STUDENT' && args.student) {
    await query(
      `UPDATE student_profiles
          SET registration_number = $2, programme = COALESCE($3, programme), year_of_study = COALESCE($4, year_of_study),
              directory_source = 'SMARTTT', directory_verified_at = NOW(), directory_snapshot = $5, updated_at = NOW()
        WHERE user_id = $1`,
      [args.userId, args.number, args.student.programme, args.student.yearOfStudy, JSON.stringify(args.student.snapshot ?? null)],
    );
  } else if (args.role === 'STUDENT') {
    // No student record in SMARTTT yet: the admission number on the account still wins.
    await query(`UPDATE student_profiles SET registration_number = $2, updated_at = NOW() WHERE user_id = $1`, [args.userId, args.number]);
  }
  if (args.role === 'LECTURER' && args.lecturer) {
    await query(
      `UPDATE lecturer_profiles
          SET staff_number = $2, title = COALESCE($3, title), department = COALESCE($4, department),
              erp_verified_at = NOW(), erp_snapshot = $5, updated_at = NOW(),
              -- Only fills an empty department: once a lecturer is placed, by
              -- name or by an officer moving them, sign-in never moves them back.
              department_id = COALESCE(department_id, ${DEPARTMENT_BY_NAME('COALESCE($4, department)')})
        WHERE user_id = $1`,
      [args.userId, args.number, args.lecturer.title, args.lecturer.department, JSON.stringify(args.lecturer.snapshot ?? null)],
    );
  }
}

// -- administrators ------------------------------------------------------------------

/**
 * The attendance account for a SMARTTT administrator: the one already linked
 * to its SMARTTT id (whatever its role, so a clash can be reported), else an
 * administrator with the same email (one invited here before administrators
 * moved to SMARTTT, who keeps their history).
 */
export async function findAdminLinkCandidate(smartttUserId: string, email: string | null): Promise<LinkCandidate | null> {
  const row = await queryOne<{ id: string; role: string; status: AccountStatus; smarttt_user_id: string | null; by_id: boolean }>(
    `SELECT u.id, u.role, u.status, u.smarttt_user_id,
            (u.smarttt_user_id IS NOT DISTINCT FROM $1) AS by_id
       FROM users u
      WHERE u.deleted_at IS NULL
        AND (u.smarttt_user_id = $1 OR (u.role = 'ADMIN' AND $2::text IS NOT NULL AND u.email = $2))
      ORDER BY by_id DESC
      LIMIT 1`,
    [smartttUserId, email],
  );
  if (!row) return null;
  return { userId: row.id, role: row.role, status: row.status, smartttUserId: row.smarttt_user_id, number: null, byId: row.by_id };
}

/**
 * Brings a linked administrator up to date with SMARTTT at sign-in. A pending
 * one (invited here, never accepted) becomes ACTIVE and its invitation link
 * stops working; a deactivated one stays as an administrator left it.
 */
export async function refreshLinkedAdmin(args: { userId: string; smartttUserId: string; fullName: string | null; email: string | null }): Promise<void> {
  await query(
    `UPDATE users
        SET smarttt_user_id = $2,
            full_name = COALESCE($3, full_name),
            email = COALESCE($4, email),
            status = CASE WHEN status IN ('PENDING_VERIFICATION', 'PENDING_APPROVAL') THEN 'ACTIVE' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`,
    [args.userId, args.smartttUserId, args.fullName, args.email],
  );
  await query(
    `UPDATE account_invitations SET invalidated_at = NOW()
      WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
    [args.userId],
  );
}

/** A new ACTIVE administrator linked to their SMARTTT account. `passwordHash` is never used: SMARTTT checks the password. */
export async function createAdminAccount(
  client: PoolClient,
  args: { email: string; fullName: string; passwordHash: string; smartttUserId: string },
): Promise<string> {
  const { rows: [user] } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, smarttt_user_id)
     VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE', $4) RETURNING id`,
    [args.email, args.passwordHash, args.fullName, args.smartttUserId],
    client,
  );
  return user!.id;
}

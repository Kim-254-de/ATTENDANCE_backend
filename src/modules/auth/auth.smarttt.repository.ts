import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/database.js';
import type { AccountStatus } from '../../db/types.js';

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
  lecturer?: { title: string | null; department: string | null; faculty: string | null; snapshot: unknown };
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
              faculty = COALESCE($5, faculty), erp_verified_at = NOW(), erp_snapshot = $6, updated_at = NOW()
        WHERE user_id = $1`,
      [args.userId, args.number, args.lecturer.title, args.lecturer.department, args.lecturer.faculty,
        JSON.stringify(args.lecturer.snapshot ?? null)],
    );
  }
}

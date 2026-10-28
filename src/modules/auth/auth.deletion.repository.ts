import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/database.js';

/**
 * SQL for deleting a student or lecturer account (auth.deletion.ts). Every
 * query is parameterised.
 *
 * Deleting is a soft delete plus anonymisation, never a DELETE FROM users:
 * attendance records, sessions and units reference the user row without
 * cascading (db/migrations/001_auth_schema.sql: "attendance history outlives
 * accounts"), so the row stays and everything that says who it was goes.
 */

export type DeletableRole = 'STUDENT' | 'LECTURER';

export interface DeletableAccount {
  userId: string;
  role: DeletableRole;
  email: string;
  fullName: string;
  passwordHash: string;
  smartttUserId: string | null;
  /** Registration number (student) or staff number (lecturer). */
  number: string | null;
}

/** A live student or lecturer account, or null (deleted, missing, or another role). */
export async function findDeletableAccount(userId: string): Promise<DeletableAccount | null> {
  const row = await queryOne<{
    id: string;
    role: DeletableRole;
    email: string;
    full_name: string;
    password_hash: string;
    smarttt_user_id: string | null;
    number: string | null;
  }>(
    `SELECT u.id, u.role, u.email, u.full_name, u.password_hash, u.smarttt_user_id,
            COALESCE(sp.registration_number, lp.staff_number) AS number
       FROM users u
  LEFT JOIN student_profiles  sp ON sp.user_id = u.id
  LEFT JOIN lecturer_profiles lp ON lp.user_id = u.id
      WHERE u.id = $1 AND u.role IN ('STUDENT', 'LECTURER') AND u.deleted_at IS NULL`,
    [userId],
  );
  if (!row) return null;
  return {
    userId: row.id,
    role: row.role,
    email: row.email,
    fullName: row.full_name,
    passwordHash: row.password_hash,
    smartttUserId: row.smarttt_user_id,
    number: row.number,
  };
}

/**
 * Anonymises the account and removes everything that is only about the
 * person. Returns false when the account was already deleted (or never was a
 * student or lecturer), so two simultaneous requests delete it once.
 *
 * Kept: attendance records (minus the device they were made from), the
 * sessions and units a lecturer ran, and roster rows (the institution's
 * enrolment data, re-synced from SMARTTT/ERP anyway). A roster row is
 * unlinked rather than kept pointing at the deleted account, so the same
 * person registering again is put back on it (linkAllocationsToStudent).
 */
export async function anonymiseAccount(client: PoolClient, userId: string, role: DeletableRole): Promise<boolean> {
  // The placeholder keeps the UNIQUE email and number columns unique, and
  // frees the real ones for a new account.
  const tag = `DELETED-${userId.replace(/-/g, '').toUpperCase()}`;
  const result = await query(
    `UPDATE users
        SET email = $2,
            full_name = $3,
            password_hash = '!',
            status = 'DEACTIVATED',
            deleted_at = NOW(),
            avatar_data_url = NULL,
            smarttt_user_id = NULL,
            face_consent_at = NULL,
            failed_login_attempts = 0,
            locked_until = NULL,
            updated_at = NOW()
      WHERE id = $1 AND role = $4 AND deleted_at IS NULL`,
    [userId, `${tag.toLowerCase()}@deleted.invalid`, role === 'STUDENT' ? 'Deleted student' : 'Deleted lecturer', role],
    client,
  );
  if ((result.rowCount ?? 0) === 0) return false;

  // Sign-in and recovery: every session, passkey and outstanding link.
  await query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId], client);
  await query(`DELETE FROM webauthn_credentials WHERE user_id = $1`, [userId], client);
  await query(`DELETE FROM webauthn_challenges WHERE user_id = $1`, [userId], client);
  await query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId], client);
  await query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId], client);

  if (role === 'STUDENT') {
    // Biometrics and cards identify the person; none of it is needed for history.
    await query(`DELETE FROM face_enrollments WHERE student_user_id = $1`, [userId], client);
    await query(`DELETE FROM student_fingerprints WHERE student_user_id = $1`, [userId], client);
    await query(`DELETE FROM student_cards WHERE student_user_id = $1`, [userId], client);
    await query(`DELETE FROM student_timetable_units WHERE student_user_id = $1`, [userId], client);
    await query(
      `UPDATE student_profiles
          SET registration_number = $2, directory_snapshot = NULL, updated_at = NOW()
        WHERE user_id = $1`,
      [userId, tag],
      client,
    );
    await query(
      `UPDATE attendance_records SET ip_address = NULL, user_agent = NULL WHERE student_user_id = $1`,
      [userId],
      client,
    );
    // A request to join that nobody approved goes. A row without a
    // registration number has nothing else to identify it by
    // (unit_allocations_identified), so it stays on the anonymised account.
    await query(
      `UPDATE unit_allocations
          SET status = CASE WHEN status = 'PENDING' THEN 'DROPPED' ELSE status END,
              student_user_id = CASE WHEN registration_number IS NULL THEN student_user_id END,
              updated_at = NOW()
        WHERE student_user_id = $1`,
      [userId],
      client,
    );
  } else {
    // department_id stays, so the department's figures still include the
    // classes this lecturer taught.
    await query(
      `UPDATE lecturer_profiles
          SET staff_number = $2, phone = NULL, erp_staff_id = NULL, erp_snapshot = NULL, updated_at = NOW()
        WHERE user_id = $1`,
      [userId, tag],
      client,
    );
    // Nobody is left to run a class that is still open. The window is cut to
    // now, but never to before it opened (attendance_sessions_window).
    await query(
      `UPDATE attendance_sessions
          SET status = 'CLOSED',
              closes_at = GREATEST(LEAST(closes_at, NOW()), opens_at + INTERVAL '1 second'),
              updated_at = NOW()
        WHERE lecturer_user_id = $1 AND status <> 'CLOSED'`,
      [userId],
      client,
    );
  }
  return true;
}

import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for fingerprint enrolments. Every query is parameterised.
 *
 * No fingerprint is stored here, and none ever reaches this service: the
 * reader keeps its own templates and does the match itself, returning the slot
 * it matched. What this maps is (terminal, slot) -> student. See
 * `db/migrations/021_fingerprint_verification.sql` for why it is keyed that way.
 */

export interface FingerprintHolder {
  enrolmentId: string;
  studentUserId: string;
  /** For the terminal's display, so the student can see who was recorded. */
  fullName: string;
  registrationNumber: string | null;
}

/**
 * The student this terminal's slot belongs to, or null.
 *
 * Scoped to the terminal because a slot number is only meaningful on the
 * reader that enrolled it. Only ACTIVE enrolments resolve, so a revoked finger
 * is indistinguishable from an unenrolled one — the right answer in both cases.
 */
export async function findFingerprintHolder(
  terminalId: string,
  fingerRefHmac: string,
): Promise<FingerprintHolder | null> {
  const row = await queryOne<{
    enrolment_id: string;
    student_user_id: string;
    full_name: string;
    registration_number: string | null;
  }>(
    `SELECT f.id AS enrolment_id, f.student_user_id, u.full_name, p.registration_number
       FROM student_fingerprints f
       JOIN users u                 ON u.id = f.student_user_id
       LEFT JOIN student_profiles p ON p.user_id = f.student_user_id
      WHERE f.terminal_id = $1
        AND f.finger_ref_hmac = $2
        AND f.status = 'ACTIVE'
        AND u.deleted_at IS NULL`,
    [terminalId, fingerRefHmac],
  );
  if (!row) return null;
  return {
    enrolmentId: row.enrolment_id,
    studentUserId: row.student_user_id,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
  };
}

export interface EnrolFingerprintArgs {
  studentUserId: string;
  terminalId: string;
  fingerRefHmac: string;
  label: string | null;
  enrolledByUserId: string | null;
}

/**
 * Binds a reader slot to a student.
 *
 * Throws a unique violation when that slot on that terminal is already taken,
 * or when the student already has an ACTIVE enrolment on it — one usable
 * finger per student per terminal, so re-enrolling means revoking first.
 */
export async function enrolFingerprint(args: EnrolFingerprintArgs): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO student_fingerprints
       (student_user_id, terminal_id, finger_ref_hmac, label, status, enrolled_by_user_id)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5)
     RETURNING id`,
    [args.studentUserId, args.terminalId, args.fingerRefHmac, args.label, args.enrolledByUserId],
  );
  if (!row) throw new Error('student_fingerprints insert returned no row');
  return row.id;
}

/**
 * Takes a student's enrolment out of use. With no terminal named, revokes every
 * one they have — which is what you want when someone leaves.
 */
export async function revokeFingerprints(
  studentUserId: string,
  terminalId?: string,
): Promise<number> {
  const result = terminalId
    ? await query(
        `UPDATE student_fingerprints
            SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
          WHERE student_user_id = $1 AND terminal_id = $2 AND status = 'ACTIVE'`,
        [studentUserId, terminalId],
      )
    : await query(
        `UPDATE student_fingerprints
            SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
          WHERE student_user_id = $1 AND status = 'ACTIVE'`,
        [studentUserId],
      );
  return result.rowCount ?? 0;
}

export interface FingerprintSummary {
  id: string;
  terminalId: string;
  label: string | null;
  status: 'ACTIVE' | 'REVOKED';
  enrolledAt: Date;
  revokedAt: Date | null;
}

/** A student's enrolments, current first. The slot reference is never returned. */
export async function listFingerprints(studentUserId: string): Promise<FingerprintSummary[]> {
  const result = await query<{
    id: string;
    terminal_id: string;
    label: string | null;
    status: 'ACTIVE' | 'REVOKED';
    enrolled_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, terminal_id, label, status, enrolled_at, revoked_at
       FROM student_fingerprints
      WHERE student_user_id = $1
      ORDER BY status = 'ACTIVE' DESC, enrolled_at DESC`,
    [studentUserId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    terminalId: r.terminal_id,
    label: r.label,
    status: r.status,
    enrolledAt: r.enrolled_at,
    revokedAt: r.revoked_at,
  }));
}

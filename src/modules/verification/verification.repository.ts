import { query, queryOne, transaction } from '../../db/database.js';
import type { Candidate, Vector } from './face.match.js';

/** All SQL for face check-in. Every query is parameterised. */

export interface FaceStatus {
  consentedAt: Date | null;
  enrolledAt: Date | null;
  model: string | null;
}

export async function findFaceStatus(studentUserId: string): Promise<FaceStatus> {
  const row = await queryOne<{ face_consent_at: Date | null; updated_at: Date | null; model: string | null }>(
    `SELECT u.face_consent_at, f.updated_at, f.model
       FROM users u
       LEFT JOIN face_enrollments f ON f.student_user_id = u.id
      WHERE u.id = $1`,
    [studentUserId],
  );
  return { consentedAt: row?.face_consent_at ?? null, enrolledAt: row?.updated_at ?? null, model: row?.model ?? null };
}

/** Records consent. Giving it again keeps the original time. */
export async function giveConsent(studentUserId: string): Promise<Date> {
  const row = await queryOne<{ face_consent_at: Date }>(
    `UPDATE users SET face_consent_at = COALESCE(face_consent_at, NOW()), updated_at = NOW()
      WHERE id = $1
      RETURNING face_consent_at`,
    [studentUserId],
  );
  if (!row) throw new Error(`user ${studentUserId} not found`);
  return row.face_consent_at;
}

/** Withdraws consent and deletes the student's templates, together. True when there were templates. */
export async function withdrawConsent(studentUserId: string): Promise<boolean> {
  return transaction(async (client) => {
    await query(`UPDATE users SET face_consent_at = NULL, updated_at = NOW() WHERE id = $1`, [studentUserId], client);
    const deleted = await query(`DELETE FROM face_enrollments WHERE student_user_id = $1`, [studentUserId], client);
    return (deleted.rowCount ?? 0) > 0;
  });
}

/** What enrolling this student from this unit's roster needs to know. Null when the unit does not exist. */
export interface EnrollmentTarget {
  unitCode: string;
  lecturerUserId: string;
  /** The student is ACTIVE on the unit. */
  onUnit: boolean;
  consentedAt: Date | null;
  fullName: string | null;
  registrationNumber: string | null;
}

export async function findEnrollmentTarget(unitId: string, studentUserId: string): Promise<EnrollmentTarget | null> {
  const row = await queryOne<{
    code: string;
    lecturer_user_id: string;
    on_unit: boolean;
    face_consent_at: Date | null;
    full_name: string | null;
    registration_number: string | null;
  }>(
    `SELECT un.code, un.lecturer_user_id,
            (a.status = 'ACTIVE' AND s.id IS NOT NULL) IS TRUE AS on_unit,
            s.face_consent_at, COALESCE(a.full_name, s.full_name) AS full_name, a.registration_number
       FROM units un
       LEFT JOIN unit_allocations a ON a.unit_id = un.id AND a.student_user_id = $2
       LEFT JOIN users s ON s.id = $2 AND s.role = 'STUDENT'
      WHERE un.id = $1`,
    [unitId, studentUserId],
  );
  if (!row) return null;
  return {
    unitCode: row.code,
    lecturerUserId: row.lecturer_user_id,
    onUnit: row.on_unit,
    consentedAt: row.face_consent_at,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
  };
}

/** Creates or replaces the student's enrollment. `replaced` is true when there was one already. */
export async function upsertEnrollment(args: {
  studentUserId: string;
  model: string;
  embeddings: Vector[];
  enrolledByUserId: string;
}): Promise<{ enrolledAt: Date; replaced: boolean }> {
  const row = await queryOne<{ updated_at: Date; replaced: boolean }>(
    `INSERT INTO face_enrollments (student_user_id, model, embeddings, enrolled_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (student_user_id) DO UPDATE
        SET model = EXCLUDED.model, embeddings = EXCLUDED.embeddings,
            enrolled_by_user_id = EXCLUDED.enrolled_by_user_id, updated_at = NOW()
     RETURNING updated_at, (xmax <> 0) AS replaced`,
    [args.studentUserId, args.model, JSON.stringify(args.embeddings), args.enrolledByUserId],
  );
  if (!row) throw new Error('face_enrollments upsert returned no row');
  return { enrolledAt: row.updated_at, replaced: row.replaced };
}

export async function deleteEnrollment(studentUserId: string): Promise<boolean> {
  const result = await query(`DELETE FROM face_enrollments WHERE student_user_id = $1`, [studentUserId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Every other enrolled student's templates from the same model, to catch a
 * face being enrolled under a second name. Whole-school on purpose: the same
 * person enrolled twice is a problem whichever units they are on.
 */
export async function findOtherEnrollments(studentUserId: string, model: string): Promise<Candidate[]> {
  const { rows } = await query<{ student_user_id: string; embeddings: Vector[] }>(
    `SELECT student_user_id, embeddings FROM face_enrollments WHERE student_user_id <> $1 AND model = $2`,
    [studentUserId, model],
  );
  return rows.map((row) => ({ studentUserId: row.student_user_id, templates: row.embeddings }));
}

/**
 * Who a terminal frame may match: students ACTIVE on the unit who still
 * consent and are enrolled with this model. A student on another unit is
 * never a candidate, so a face can only be recognised into a class they are on.
 */
export async function findUnitCandidates(unitId: string, model: string): Promise<Candidate[]> {
  const { rows } = await query<{ student_user_id: string; embeddings: Vector[] }>(
    `SELECT f.student_user_id, f.embeddings
       FROM unit_allocations a
       JOIN users s ON s.id = a.student_user_id AND s.face_consent_at IS NOT NULL
       JOIN face_enrollments f ON f.student_user_id = a.student_user_id AND f.model = $2
      WHERE a.unit_id = $1 AND a.status = 'ACTIVE'`,
    [unitId, model],
  );
  return rows.map((row) => ({ studentUserId: row.student_user_id, templates: row.embeddings }));
}

/** Whether the student can still be recorded by face on this unit: ACTIVE on it, consenting and enrolled. */
export async function isFaceCheckInEligible(unitId: string, studentUserId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM unit_allocations a
         JOIN users s ON s.id = a.student_user_id AND s.face_consent_at IS NOT NULL
         JOIN face_enrollments f ON f.student_user_id = a.student_user_id
        WHERE a.unit_id = $1 AND a.student_user_id = $2 AND a.status = 'ACTIVE'
     ) AS ok`,
    [unitId, studentUserId],
  );
  return row?.ok ?? false;
}

/** What the terminal shows for a match, so the lecturer can check the face against the person. */
export interface StudentCard {
  studentUserId: string;
  fullName: string;
  registrationNumber: string | null;
  avatarDataUrl: string | null;
}

export async function findStudentCard(unitId: string, studentUserId: string): Promise<StudentCard | null> {
  const row = await queryOne<{
    id: string;
    full_name: string;
    registration_number: string | null;
    avatar_data_url: string | null;
  }>(
    `SELECT s.id, COALESCE(a.full_name, s.full_name) AS full_name, a.registration_number, s.avatar_data_url
       FROM users s
       LEFT JOIN unit_allocations a ON a.unit_id = $1 AND a.student_user_id = s.id
      WHERE s.id = $2`,
    [unitId, studentUserId],
  );
  if (!row) return null;
  return {
    studentUserId: row.id,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
    avatarDataUrl: row.avatar_data_url,
  };
}

export async function hasAlreadyCheckedIn(sessionId: string, studentUserId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM attendance_records WHERE session_id = $1 AND student_user_id = $2) AS ok`,
    [sessionId, studentUserId],
  );
  return row?.ok ?? false;
}

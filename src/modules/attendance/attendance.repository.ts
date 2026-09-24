import { query, queryOne } from '../../db/database.js';

/** All SQL for the attendance module. Every query is parameterised. */

export interface NewRecord {
  sessionId: string;
  unitId: string;
  studentUserId: string;
  qrAgeSeconds: number;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Writes the check-in. Throws a unique violation when the student is already
 * recorded for this session — the UNIQUE (session_id, student_user_id)
 * constraint is what stops two simultaneous scans both landing.
 */
export async function insertRecord(record: NewRecord): Promise<{ id: string; recordedAt: Date }> {
  const row = await queryOne<{ id: string; recorded_at: Date }>(
    `INSERT INTO attendance_records
       (session_id, student_user_id, allocation_id, qr_age_seconds, ip_address, user_agent)
     VALUES ($1, $2,
             (SELECT id FROM unit_allocations WHERE unit_id = $3 AND student_user_id = $2),
             $4, $5, $6)
     RETURNING id, recorded_at`,
    [
      record.sessionId,
      record.studentUserId,
      record.unitId,
      record.qrAgeSeconds,
      record.ipAddress,
      record.userAgent,
    ],
  );
  if (!row) throw new Error('attendance_records insert returned no row');
  return { id: row.id, recordedAt: row.recorded_at };
}

export interface AttendeeRow {
  id: string;
  studentUserId: string;
  fullName: string;
  registrationNumber: string | null;
  recordedAt: Date;
}

/** Everyone recorded for a session, most recent first — what the lecturer watches arrive. */
export async function listRecords(sessionId: string): Promise<AttendeeRow[]> {
  const result = await query<{
    id: string;
    student_user_id: string;
    full_name: string;
    registration_number: string | null;
    recorded_at: Date;
  }>(
    `SELECT r.id, r.student_user_id, u.full_name, a.registration_number, r.recorded_at
       FROM attendance_records r
       JOIN users u ON u.id = r.student_user_id
       LEFT JOIN unit_allocations a ON a.id = r.allocation_id
      WHERE r.session_id = $1
      ORDER BY r.recorded_at DESC`,
    [sessionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    studentUserId: row.student_user_id,
    fullName: row.full_name,
    registrationNumber: row.registration_number,
    recordedAt: row.recorded_at,
  }));
}

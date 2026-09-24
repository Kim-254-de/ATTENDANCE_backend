import { query } from '../../db/database.js';

/** All SQL for the reporting module. Every query is parameterised. */

export interface SessionReportRow {
  id: string;
  opensAt: Date;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  /** Checked in. */
  present: number;
  /** ACTIVE allocations on the unit right now — the same roster-size convention session.service.ts's countAttendance uses. */
  total: number;
}

/**
 * One row per session the lecturer has ever opened, newest first. Backs both
 * the Dashboard's "Recent Sessions" (small `limit`) and the Attendance page's
 * full log (`unitId` narrows to one unit's tab).
 */
export async function listSessionReports(
  lecturerUserId: string,
  options: { unitId?: string; limit?: number } = {},
): Promise<SessionReportRow[]> {
  const result = await query<{
    id: string;
    opens_at: Date;
    unit_id: string;
    unit_code: string;
    unit_name: string | null;
    present: number;
    total: number;
  }>(
    `SELECT s.id, s.opens_at, s.unit_id, u.code AS unit_code, u.name AS unit_name,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::int AS present,
            (SELECT COUNT(*) FROM unit_allocations a
              WHERE a.unit_id = s.unit_id AND a.status = 'ACTIVE')::int AS total
       FROM attendance_sessions s
       JOIN units u ON u.id = s.unit_id
      WHERE s.lecturer_user_id = $1
        AND ($2::uuid IS NULL OR s.unit_id = $2)
      ORDER BY s.opens_at DESC
      LIMIT $3`,
    [lecturerUserId, options.unitId ?? null, options.limit ?? 500],
  );
  return result.rows.map((row) => ({
    id: row.id,
    opensAt: row.opens_at,
    unitId: row.unit_id,
    unitCode: row.unit_code,
    unitName: row.unit_name,
    present: row.present,
    total: row.total,
  }));
}

export interface AttendeeCsvRow {
  registrationNumber: string | null;
  fullName: string | null;
  recordedAt: Date | null;
}

/** Every ACTIVE allocation on the session's unit, with whether (and when) they checked in to THIS session. */
export async function listSessionAttendeesForExport(
  sessionId: string,
  unitId: string,
): Promise<AttendeeCsvRow[]> {
  const result = await query<{
    registration_number: string | null;
    full_name: string | null;
    recorded_at: Date | null;
  }>(
    `SELECT a.registration_number, COALESCE(a.full_name, s.full_name) AS full_name, r.recorded_at
       FROM unit_allocations a
       LEFT JOIN users s ON s.id = a.student_user_id
       LEFT JOIN attendance_records r ON r.allocation_id = a.id AND r.session_id = $1
      WHERE a.unit_id = $2 AND a.status = 'ACTIVE'
      ORDER BY full_name NULLS LAST, a.registration_number`,
    [sessionId, unitId],
  );
  return result.rows.map((row) => ({
    registrationNumber: row.registration_number,
    fullName: row.full_name,
    recordedAt: row.recorded_at,
  }));
}

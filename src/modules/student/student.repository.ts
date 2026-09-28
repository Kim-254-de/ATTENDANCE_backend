import { query } from '../../db/database.js';

/** All SQL for the student module. Every query is parameterised. */

export interface StudentUnitRow {
  id: string;
  code: string;
  name: string | null;
  base_code: string | null;
  class_group: string | null;
  lecturer_name: string;
  day_of_week: number | null;
  start_time: string | null;
  end_time: string | null;
  sessions_held: number;
  sessions_attended: number;
}

/**
 * The units a student is on (ACTIVE on the roster), with how many class
 * sessions each has held so far and how many of them the student attended.
 *
 * "Held" counts a session once it counts for or against the student: it has
 * ended (closed, or past closes_at), or they already checked in. A class still
 * taking check-ins that they haven't scanned yet isn't an absence yet — the
 * same rule as the attendance history's OPEN mark, so the two figures agree.
 */
export async function findUnitsForStudent(studentUserId: string): Promise<StudentUnitRow[]> {
  const result = await query<StudentUnitRow>(
    `SELECT u.id, u.code, u.name, u.base_code, u.class_group,
            lu.full_name AS lecturer_name,
            s.day_of_week, s.start_time, s.end_time,
            COUNT(DISTINCT se.id) FILTER (
              WHERE se.opens_at <= NOW()
                AND (r.id IS NOT NULL OR se.status = 'CLOSED' OR se.closes_at <= NOW())
            )::int                                                        AS sessions_held,
            COUNT(DISTINCT r.id)::int                                     AS sessions_attended
       FROM unit_allocations a
       JOIN units u  ON u.id = a.unit_id
       JOIN users lu ON lu.id = u.lecturer_user_id
  LEFT JOIN unit_schedule s        ON s.unit_id = u.id
  LEFT JOIN attendance_sessions se ON se.unit_id = u.id
  LEFT JOIN attendance_records r   ON r.session_id = se.id AND r.student_user_id = $1
      WHERE a.student_user_id = $1 AND a.status = 'ACTIVE'
      GROUP BY u.id, lu.full_name, s.day_of_week, s.start_time, s.end_time
      ORDER BY u.code`,
    [studentUserId],
  );
  return result.rows;
}

export interface AttendanceHistoryRow {
  session_id: string;
  title: string | null;
  opens_at: Date;
  closes_at: Date;
  status: 'OPEN' | 'PAUSED' | 'CLOSED';
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  recorded_at: Date | null;
}

/** Every class session held for the student's units, newest first, with their check-in if any. */
export async function findAttendanceHistory(
  studentUserId: string,
  options: { unitId?: string; limit: number },
): Promise<AttendanceHistoryRow[]> {
  const result = await query<AttendanceHistoryRow>(
    `SELECT se.id AS session_id, se.title, se.opens_at, se.closes_at, se.status,
            u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            r.recorded_at
       FROM unit_allocations a
       JOIN units u               ON u.id = a.unit_id
       JOIN attendance_sessions se ON se.unit_id = u.id AND se.opens_at <= NOW()
  LEFT JOIN attendance_records r  ON r.session_id = se.id AND r.student_user_id = $1
      WHERE a.student_user_id = $1 AND a.status = 'ACTIVE'
        AND ($2::uuid IS NULL OR u.id = $2::uuid)
      ORDER BY se.opens_at DESC
      LIMIT $3`,
    [studentUserId, options.unitId ?? null, options.limit],
  );
  return result.rows;
}

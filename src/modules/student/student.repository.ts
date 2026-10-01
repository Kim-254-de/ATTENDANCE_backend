import { query, queryOne, transaction } from '../../db/database.js';

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

/** The registration number the student registered with; null for a user with no student profile. */
export async function findRegistrationNumber(studentUserId: string): Promise<string | null> {
  const row = await queryOne<{ registration_number: string }>(
    `SELECT registration_number FROM student_profiles WHERE user_id = $1`,
    [studentUserId],
  );
  return row?.registration_number ?? null;
}

export interface TimetableUnitInput {
  code: string;
  baseCode: string;
  group: string | null;
  name: string;
  groupRequired: boolean;
  lecturers: string[];
  slots: { dayOfWeek: number; startTime: string; endTime: string; room: string | null }[];
}

export interface TimetableUnitRow {
  code: string;
  base_code: string;
  class_group: string | null;
  name: string | null;
  group_required: boolean;
  lecturer_names: string[];
  slots: TimetableUnitInput['slots'];
}

/** Replaces the student's SMARTTT registrations with this list, in one go. */
export async function replaceTimetableUnits(studentUserId: string, units: TimetableUnitInput[]): Promise<void> {
  await transaction(async (client) => {
    await query(`DELETE FROM student_timetable_units WHERE student_user_id = $1`, [studentUserId], client);
    for (const u of units) {
      await query(
        `INSERT INTO student_timetable_units
           (student_user_id, code, base_code, class_group, name, group_required, lecturer_names, slots)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [studentUserId, u.code, u.baseCode, u.group, u.name, u.groupRequired, u.lecturers, JSON.stringify(u.slots)],
        client,
      );
    }
  });
}

/** The student's SMARTTT registrations as last synced, by code. */
export async function findTimetableUnits(studentUserId: string): Promise<TimetableUnitRow[]> {
  const result = await query<TimetableUnitRow>(
    `SELECT code, base_code, class_group, name, group_required, lecturer_names, slots
       FROM student_timetable_units
      WHERE student_user_id = $1
      ORDER BY code`,
    [studentUserId],
  );
  return result.rows;
}

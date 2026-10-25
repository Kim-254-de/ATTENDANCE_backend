import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for the management module. Every query is parameterised.
 *
 * University-wide: every department, no scope. Teaching is counted under
 * the unit's owning department (`units.department_id`), and a session's rate
 * is check-ins over the unit's ACTIVE allocations, as the department portal
 * computes it, so a department reads the same here as there. One difference: a
 * rate is null, not 0, when nothing has been measured yet, so the charts can
 * tell "no classes held" from "nobody came".
 */

/**
 * One session's attendance rate, 0–100, or NULL when the unit has no ACTIVE
 * allocations to measure against. Expects the session aliased `s`.
 */
const SESSION_RATE = `
  (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::numeric
  / NULLIF((SELECT COUNT(*) FROM unit_allocations a
             WHERE a.unit_id = s.unit_id AND a.status = 'ACTIVE'), 0) * 100`;

/**
 * A unit's year of study, 1–4, or NULL when it belongs to none of them.
 * Expects the unit aliased `u`.
 *
 * The first digit of the unit code is the year it is taught in ("COSC 103"
 * is Year 1, "COSC 410" Year 4). A code whose first digit is 5 or more is a
 * postgraduate unit and has no year here. Only a code with no digit at all
 * falls back to the year most of its students are in.
 */
const UNIT_YEAR = `
  CASE
    WHEN substring(u.code from '[0-9]') IS NOT NULL THEN
      CASE WHEN substring(u.code from '[0-9]') IN ('1', '2', '3', '4') THEN substring(u.code from '[0-9]')::int END
    ELSE (SELECT mode() WITHIN GROUP (ORDER BY sp.year_of_study)::int
            FROM unit_allocations a
            JOIN student_profiles sp ON sp.user_id = a.student_user_id
           WHERE a.unit_id = u.id AND a.status = 'ACTIVE' AND sp.year_of_study BETWEEN 1 AND 4)
  END`;

/** Distinct students on a set of allocations: by account, else by registration number. */
const DISTINCT_STUDENTS = `COUNT(DISTINCT COALESCE(a.student_user_id::text, 'reg:' || a.registration_number))`;

export const YEARS = [1, 2, 3, 4] as const;

export interface DepartmentRow {
  departmentId: string;
  departmentName: string;
  departmentCode: string | null;
  unitCount: number;
  studentCount: number;
  sessionsHeld: number;
  /** Check-ins recorded in the department's classes: the pie chart's share. */
  checkIns: number;
  /** Mean of per-session rates, 0–100. Null until a class with a roster has been held. */
  avgAttendanceRate: number | null;
}

/** Every department in the university, most check-ins first. */
export async function listDepartments(): Promise<DepartmentRow[]> {
  const { rows } = await query<{
    department_id: string;
    department_name: string;
    department_code: string | null;
    unit_count: number;
    student_count: number;
    sessions_held: number;
    check_ins: number;
    avg_attendance_rate: number | null;
  }>(
    `WITH dept_units AS (SELECT id, department_id FROM units WHERE department_id IS NOT NULL)
     SELECT d.id AS department_id, d.name AS department_name, d.code AS department_code,

            (SELECT COUNT(*) FROM dept_units du WHERE du.department_id = d.id)::int AS unit_count,

            (SELECT ${DISTINCT_STUDENTS} FROM unit_allocations a
               JOIN dept_units du ON du.id = a.unit_id
              WHERE du.department_id = d.id AND a.status = 'ACTIVE')::int AS student_count,

            (SELECT COUNT(*) FROM attendance_sessions s
               JOIN dept_units du ON du.id = s.unit_id
              WHERE du.department_id = d.id)::int AS sessions_held,

            (SELECT COUNT(*) FROM attendance_records r
               JOIN attendance_sessions s ON s.id = r.session_id
               JOIN dept_units du ON du.id = s.unit_id
              WHERE du.department_id = d.id)::int AS check_ins,

            (SELECT AVG(rate)::float8
               FROM (SELECT ${SESSION_RATE} AS rate
                       FROM attendance_sessions s
                       JOIN dept_units du ON du.id = s.unit_id
                      WHERE du.department_id = d.id) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate

       FROM departments d
      ORDER BY check_ins DESC, d.name`,
  );
  return rows.map((r) => ({
    departmentId: r.department_id,
    departmentName: r.department_name,
    departmentCode: r.department_code,
    unitCount: r.unit_count,
    studentCount: r.student_count,
    sessionsHeld: r.sessions_held,
    checkIns: r.check_ins,
    avgAttendanceRate: r.avg_attendance_rate,
  }));
}

export interface DepartmentHeader {
  departmentId: string;
  departmentName: string;
  departmentCode: string | null;
}

/** One department's name and code. Null when it doesn't exist. */
export async function findDepartment(departmentId: string): Promise<DepartmentHeader | null> {
  const row = await queryOne<{ id: string; name: string; code: string | null }>(
    `SELECT d.id, d.name, d.code
       FROM departments d
      WHERE d.id = $1`,
    [departmentId],
  );
  return row ? { departmentId: row.id, departmentName: row.name, departmentCode: row.code } : null;
}

export interface YearRow {
  year: number;
  unitCount: number;
  studentCount: number;
  sessionsHeld: number;
  checkIns: number;
  avgAttendanceRate: number | null;
}

/**
 * One department's figures for Years 1–4, every year present even when
 * empty, plus how many of its units belong to no year (postgraduate codes).
 */
export async function listYears(departmentId: string): Promise<{ years: YearRow[]; unitsWithoutYear: number }> {
  const { rows } = await query<{
    year: number | null;
    unit_count: number;
    student_count: number;
    sessions_held: number;
    check_ins: number;
    avg_attendance_rate: number | null;
  }>(
    `WITH du AS (SELECT u.id, ${UNIT_YEAR} AS year FROM units u WHERE u.department_id = $1),
          sess AS (SELECT du.year,
                          (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::int AS check_ins,
                          ${SESSION_RATE} AS rate
                     FROM attendance_sessions s JOIN du ON du.id = s.unit_id)
     SELECT y.year,
            (SELECT COUNT(*) FROM du WHERE du.year = y.year)::int AS unit_count,
            (SELECT ${DISTINCT_STUDENTS} FROM unit_allocations a JOIN du ON du.id = a.unit_id
              WHERE du.year = y.year AND a.status = 'ACTIVE')::int AS student_count,
            (SELECT COUNT(*) FROM sess WHERE sess.year = y.year)::int AS sessions_held,
            (SELECT COALESCE(SUM(check_ins), 0) FROM sess WHERE sess.year = y.year)::int AS check_ins,
            (SELECT AVG(rate)::float8 FROM sess WHERE sess.year = y.year AND rate IS NOT NULL) AS avg_attendance_rate
       FROM generate_series(1, 4) AS y(year)
     UNION ALL
     SELECT NULL, (SELECT COUNT(*) FROM du WHERE du.year IS NULL)::int, 0, 0, 0, NULL
      ORDER BY year NULLS LAST`,
    [departmentId],
  );
  const unplaced = rows.find((r) => r.year === null);
  return {
    years: rows
      .filter((r) => r.year !== null)
      .map((r) => ({
        year: r.year!,
        unitCount: r.unit_count,
        studentCount: r.student_count,
        sessionsHeld: r.sessions_held,
        checkIns: r.check_ins,
        avgAttendanceRate: r.avg_attendance_rate,
      })),
    unitsWithoutYear: unplaced?.unit_count ?? 0,
  };
}

export interface YearUnitRow {
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  staffNumber: string | null;
  sessionsHeld: number;
  avgAttendanceRate: number | null;
}

/** The department's units taught in one year, by code. */
export async function listYearUnits(departmentId: string, year: number): Promise<YearUnitRow[]> {
  const { rows } = await query<{
    unit_id: string;
    unit_code: string;
    unit_name: string | null;
    lecturer_user_id: string;
    lecturer_name: string;
    staff_number: string | null;
    sessions_held: number;
    avg_attendance_rate: number | null;
  }>(
    `SELECT u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            u.lecturer_user_id, lu.full_name AS lecturer_name, lp.staff_number,
            (SELECT COUNT(*) FROM attendance_sessions s WHERE s.unit_id = u.id)::int AS sessions_held,
            (SELECT AVG(rate)::float8
               FROM (SELECT ${SESSION_RATE} AS rate FROM attendance_sessions s WHERE s.unit_id = u.id) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate
       FROM units u
       JOIN users lu ON lu.id = u.lecturer_user_id
  LEFT JOIN lecturer_profiles lp ON lp.user_id = u.lecturer_user_id
      WHERE u.department_id = $1 AND (${UNIT_YEAR}) = $2
      ORDER BY u.code`,
    [departmentId, year],
  );
  return rows.map((r) => ({
    unitId: r.unit_id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    staffNumber: r.staff_number,
    sessionsHeld: r.sessions_held,
    avgAttendanceRate: r.avg_attendance_rate,
  }));
}

export interface UnitStudentRow {
  unitId: string;
  studentUserId: string | null;
  registrationNumber: string | null;
  fullName: string | null;
  yearOfStudy: number | null;
  sessionsHeld: number;
  sessionsAttended: number;
}

/**
 * The students on the given units' rosters, with how many of each unit's
 * classes they attended. "Held" counts the way the eligibility report does
 * (eligibility.repository.ts listStanding): a class that has opened and is
 * over, or that this student already checked in to.
 */
export async function listUnitStudents(unitIds: string[]): Promise<UnitStudentRow[]> {
  if (unitIds.length === 0) return [];
  const { rows } = await query<{
    unit_id: string;
    student_user_id: string | null;
    registration_number: string | null;
    full_name: string | null;
    year_of_study: number | null;
    sessions_held: number;
    sessions_attended: number;
  }>(
    `SELECT a.unit_id, a.student_user_id, a.registration_number,
            COALESCE(a.full_name, su.full_name) AS full_name, sp.year_of_study,
            COUNT(DISTINCT se.id) FILTER (
              WHERE se.opens_at <= NOW()
                AND (r.id IS NOT NULL OR se.status = 'CLOSED' OR se.closes_at <= NOW())
            )::int AS sessions_held,
            COUNT(DISTINCT r.id)::int AS sessions_attended
       FROM unit_allocations a
  LEFT JOIN users su ON su.id = a.student_user_id
  LEFT JOIN student_profiles sp ON sp.user_id = a.student_user_id
  LEFT JOIN attendance_sessions se ON se.unit_id = a.unit_id
  LEFT JOIN attendance_records r ON r.session_id = se.id AND r.student_user_id = a.student_user_id
      WHERE a.unit_id = ANY($1::uuid[]) AND a.status = 'ACTIVE'
      GROUP BY a.id, a.unit_id, a.student_user_id, a.registration_number, a.full_name, su.full_name, sp.year_of_study
      ORDER BY full_name NULLS LAST, a.registration_number`,
    [unitIds],
  );
  return rows.map((r) => ({
    unitId: r.unit_id,
    studentUserId: r.student_user_id,
    registrationNumber: r.registration_number,
    fullName: r.full_name,
    yearOfStudy: r.year_of_study,
    sessionsHeld: r.sessions_held,
    sessionsAttended: r.sessions_attended,
  }));
}

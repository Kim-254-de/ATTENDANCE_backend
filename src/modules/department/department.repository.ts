import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for the department module. Every query is parameterised.
 *
 * Every query here takes a `department_id` as `$1` and is scoped through
 * `lecturer_profiles.department_id`. A unit has no department column of its own
 * on purpose (`db/migrations/020_departments.sql`): its department is its
 * lecturer's, so `units.lecturer_user_id -> lecturer_profiles.user_id` is the
 * only route in, and nothing can drift out of agreement with it.
 *
 * The attendance figures are the same ones the lecturer module reports, just
 * re-scoped: a per-session rate of checked-in ÷ ACTIVE allocations, averaged.
 * Keeping the shape identical to `lecturer.repository.ts` is deliberate — a
 * department's numbers must reconcile with what each lecturer sees.
 */

/** Lecturers of one department, as a scalar subquery every aggregate below reuses. */
const DEPT_LECTURERS = `SELECT user_id FROM lecturer_profiles WHERE department_id = $1`;

/**
 * One session's attendance rate, 0–100, or NULL when the unit has no ACTIVE
 * allocations to measure against. `$1` is bound by the enclosing query.
 */
const SESSION_RATE = `
  (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::numeric
  / NULLIF((SELECT COUNT(*) FROM unit_allocations a
             WHERE a.unit_id = s.unit_id AND a.status = 'ACTIVE'), 0) * 100`;

/** Minutes a session started after its scheduled slot. Negative when it started early. */
const LATE_MINUTES = `EXTRACT(EPOCH FROM (s.opens_at - s.scheduled_start_at)) / 60`;

/** Sessions the grace window applies to: only ones with a schedule to be late against. */
const MEASURABLE = `s.scheduled_start_at IS NOT NULL`;

export interface OfficerDepartment {
  departmentId: string;
  departmentName: string;
  facultyId: string | null;
  facultyName: string | null;
}

/**
 * The department an officer oversees, read from `department_profiles` rather
 * than taken from the session's cached account — this is the value every other
 * query here is scoped by, so it is re-read from the row that owns it.
 */
export async function findOfficerDepartment(userId: string): Promise<OfficerDepartment | null> {
  const row = await queryOne<{
    department_id: string;
    department_name: string;
    faculty_id: string | null;
    faculty_name: string | null;
  }>(
    `SELECT d.id AS department_id, d.name AS department_name,
            f.id AS faculty_id, f.name AS faculty_name
       FROM department_profiles dp
       JOIN departments d ON d.id = dp.department_id
  LEFT JOIN faculties   f ON f.id = d.faculty_id
      WHERE dp.user_id = $1`,
    [userId],
  );
  if (!row) return null;
  return {
    departmentId: row.department_id,
    departmentName: row.department_name,
    facultyId: row.faculty_id,
    facultyName: row.faculty_name,
  };
}

export interface DepartmentOverviewRow {
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  /** 0–100, averaged across every session in the department. */
  avgAttendanceRate: number;
  sessionsHeld: number;
  /** 0–100, or null when no session in the department has a schedule to be judged against. */
  onTimeRate: number | null;
}

/**
 * The department's stat cards. `graceMinutes` is bound, not interpolated, so
 * the grace window is a value like any other.
 *
 * `studentCount` counts distinct students, keyed by user id where the
 * allocation is linked and by registration number where it is not yet — the
 * same COALESCE identity `unit_allocations`' two partial unique indexes use.
 * That differs from a lecturer's own `totalStudents`, which counts allocations
 * (a student on two units counts twice): at department scale a head count is
 * what is being asked for.
 */
export async function getOverview(
  departmentId: string,
  graceMinutes: number,
): Promise<DepartmentOverviewRow> {
  const row = await queryOne<{
    lecturer_count: number;
    student_count: number;
    unit_count: number;
    avg_attendance_rate: number;
    sessions_held: number;
    on_time_rate: number | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM lecturer_profiles WHERE department_id = $1)::int AS lecturer_count,

       (SELECT COUNT(*) FROM units u
         WHERE u.lecturer_user_id IN (${DEPT_LECTURERS}))::int AS unit_count,

       (SELECT COUNT(DISTINCT COALESCE(a.student_user_id::text, 'reg:' || a.registration_number))
          FROM unit_allocations a
          JOIN units u ON u.id = a.unit_id
         WHERE a.status = 'ACTIVE'
           AND u.lecturer_user_id IN (${DEPT_LECTURERS}))::int AS student_count,

       (SELECT COUNT(*) FROM attendance_sessions s
         WHERE s.lecturer_user_id IN (${DEPT_LECTURERS}))::int AS sessions_held,

       (SELECT COALESCE(AVG(rate), 0)::float8
          FROM (SELECT ${SESSION_RATE} AS rate
                  FROM attendance_sessions s
                 WHERE s.lecturer_user_id IN (${DEPT_LECTURERS})) per_session
         WHERE rate IS NOT NULL) AS avg_attendance_rate,

       (SELECT (COUNT(*) FILTER (WHERE s.opens_at <= s.scheduled_start_at + make_interval(mins => $2))::numeric
                / NULLIF(COUNT(*), 0) * 100)::float8
          FROM attendance_sessions s
         WHERE s.lecturer_user_id IN (${DEPT_LECTURERS})
           AND ${MEASURABLE}) AS on_time_rate`,
    [departmentId, graceMinutes],
  );
  return {
    lecturerCount: row?.lecturer_count ?? 0,
    studentCount: row?.student_count ?? 0,
    unitCount: row?.unit_count ?? 0,
    avgAttendanceRate: row?.avg_attendance_rate ?? 0,
    sessionsHeld: row?.sessions_held ?? 0,
    onTimeRate: row?.on_time_rate ?? null,
  };
}

export interface DepartmentLecturerRow {
  userId: string;
  fullName: string;
  staffNumber: string;
  unitsTaught: number;
  /** ACTIVE allocations across the lecturer's units — the same count `lecturer.repository.ts` reports. */
  studentsTaught: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  /** Null when none of the lecturer's sessions has a schedule behind it. */
  avgLateMinutes: number | null;
  onTimeRate: number | null;
}

/**
 * One row per lecturer in the department. The per-lecturer aggregates are the
 * lecturer module's `getSummary` run for each of them, so a lecturer opening
 * their own dashboard sees the same four numbers this row reports.
 */
export async function listLecturers(
  departmentId: string,
  graceMinutes: number,
): Promise<DepartmentLecturerRow[]> {
  const { rows } = await query<{
    user_id: string;
    full_name: string;
    staff_number: string;
    units_taught: number;
    students_taught: number;
    avg_attendance_rate: number;
    sessions_held: number;
    avg_late_minutes: number | null;
    on_time_rate: number | null;
  }>(
    `SELECT lp.user_id, usr.full_name, lp.staff_number,

            (SELECT COUNT(*) FROM units u WHERE u.lecturer_user_id = lp.user_id)::int AS units_taught,

            (SELECT COUNT(*) FROM unit_allocations a
               JOIN units u ON u.id = a.unit_id
              WHERE u.lecturer_user_id = lp.user_id AND a.status = 'ACTIVE')::int AS students_taught,

            (SELECT COUNT(*) FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id)::int AS sessions_held,

            (SELECT COALESCE(AVG(rate), 0)::float8
               FROM (SELECT ${SESSION_RATE} AS rate
                       FROM attendance_sessions s
                      WHERE s.lecturer_user_id = lp.user_id) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate,

            (SELECT AVG(${LATE_MINUTES})::float8
               FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id AND ${MEASURABLE}) AS avg_late_minutes,

            (SELECT (COUNT(*) FILTER (WHERE s.opens_at <= s.scheduled_start_at + make_interval(mins => $2))::numeric
                     / NULLIF(COUNT(*), 0) * 100)::float8
               FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id AND ${MEASURABLE}) AS on_time_rate

       FROM lecturer_profiles lp
       JOIN users usr ON usr.id = lp.user_id
      WHERE lp.department_id = $1 AND usr.deleted_at IS NULL
      ORDER BY usr.full_name`,
    [departmentId, graceMinutes],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    staffNumber: r.staff_number,
    unitsTaught: r.units_taught,
    studentsTaught: r.students_taught,
    avgAttendanceRate: r.avg_attendance_rate,
    sessionsHeld: r.sessions_held,
    avgLateMinutes: r.avg_late_minutes,
    onTimeRate: r.on_time_rate,
  }));
}

/**
 * The department a lecturer belongs to, for the drill-down's ownership check.
 * Null when there is no lecturer profile for that user id at all.
 */
export async function findLecturerDepartmentId(lecturerUserId: string): Promise<string | null> {
  const row = await queryOne<{ department_id: string | null }>(
    `SELECT department_id FROM lecturer_profiles WHERE user_id = $1`,
    [lecturerUserId],
  );
  return row ? row.department_id : null;
}

export interface LecturerHeaderRow {
  userId: string;
  fullName: string;
  staffNumber: string;
  title: string | null;
  email: string;
}

export async function findLecturerHeader(lecturerUserId: string): Promise<LecturerHeaderRow | null> {
  const row = await queryOne<{
    user_id: string;
    full_name: string;
    staff_number: string;
    title: string | null;
    email: string;
  }>(
    `SELECT lp.user_id, usr.full_name, lp.staff_number, lp.title, usr.email
       FROM lecturer_profiles lp
       JOIN users usr ON usr.id = lp.user_id
      WHERE lp.user_id = $1`,
    [lecturerUserId],
  );
  if (!row) return null;
  return {
    userId: row.user_id,
    fullName: row.full_name,
    staffNumber: row.staff_number,
    title: row.title,
    email: row.email,
  };
}

export interface DepartmentUnitRow {
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  activeStudents: number;
  sessionsHeld: number;
  avgAttendanceRate: number;
}

/**
 * Units in the department, or just one lecturer's when `lecturerUserId` is
 * given (the drill-down reuses this rather than keeping a second copy of the
 * per-unit rate query). The department filter is applied either way, so
 * narrowing to a lecturer can never widen the scope.
 */
export async function listUnits(
  departmentId: string,
  lecturerUserId?: string,
): Promise<DepartmentUnitRow[]> {
  const { rows } = await query<{
    unit_id: string;
    unit_code: string;
    unit_name: string | null;
    lecturer_user_id: string;
    lecturer_name: string;
    active_students: number;
    sessions_held: number;
    avg_attendance_rate: number;
  }>(
    `SELECT u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            u.lecturer_user_id, usr.full_name AS lecturer_name,

            (SELECT COUNT(*) FROM unit_allocations a
              WHERE a.unit_id = u.id AND a.status = 'ACTIVE')::int AS active_students,

            (SELECT COUNT(*) FROM attendance_sessions s WHERE s.unit_id = u.id)::int AS sessions_held,

            (SELECT COALESCE(AVG(rate), 0)::float8
               FROM (SELECT ${SESSION_RATE} AS rate
                       FROM attendance_sessions s
                      WHERE s.unit_id = u.id) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate

       FROM units u
       JOIN users usr ON usr.id = u.lecturer_user_id
      WHERE u.lecturer_user_id IN (${DEPT_LECTURERS})
        AND ($2::uuid IS NULL OR u.lecturer_user_id = $2)
      ORDER BY u.code`,
    [departmentId, lecturerUserId ?? null],
  );
  return rows.map((r) => ({
    unitId: r.unit_id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    activeStudents: r.active_students,
    sessionsHeld: r.sessions_held,
    avgAttendanceRate: r.avg_attendance_rate,
  }));
}

export interface DepartmentStudentRow {
  id: string;
  registration_number: string | null;
  student_user_id: string | null;
  full_name: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_user_id: string;
  lecturer_name: string;
  sessions_held: number;
  sessions_attended: number;
}

/**
 * `lecturer.repository.ts`'s `listStudents` widened from one lecturer to every
 * lecturer in the department — one row per (student, unit), with the owning
 * lecturer named so a department can see who teaches a struggling class.
 * sessions_held/sessions_attended keep that query's exact meaning: held counts
 * a session once it has opened and either has a check-in or has finished;
 * attended counts this student's own check-ins.
 */
export async function listStudents(departmentId: string): Promise<DepartmentStudentRow[]> {
  const { rows } = await query<DepartmentStudentRow>(
    `SELECT a.id, a.registration_number, a.student_user_id,
            COALESCE(a.full_name, su.full_name) AS full_name,
            u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            u.lecturer_user_id, lu.full_name AS lecturer_name,
            COUNT(DISTINCT se.id) FILTER (
              WHERE se.opens_at <= NOW()
                AND (r.id IS NOT NULL OR se.status = 'CLOSED' OR se.closes_at <= NOW())
            )::int AS sessions_held,
            COUNT(DISTINCT r.id)::int AS sessions_attended
       FROM unit_allocations a
       JOIN units u  ON u.id = a.unit_id
       JOIN users lu ON lu.id = u.lecturer_user_id
  LEFT JOIN users su ON su.id = a.student_user_id
  LEFT JOIN attendance_sessions se ON se.unit_id = u.id
  LEFT JOIN attendance_records r   ON r.session_id = se.id AND r.student_user_id = a.student_user_id
      WHERE u.lecturer_user_id IN (${DEPT_LECTURERS}) AND a.status = 'ACTIVE'
      GROUP BY a.id, a.registration_number, a.student_user_id, a.full_name, su.full_name,
               u.id, u.code, u.name, u.lecturer_user_id, lu.full_name
      ORDER BY full_name NULLS LAST, u.code`,
    [departmentId],
  );
  return rows;
}

export interface TimekeepingRow {
  sessionId: string;
  unitId: string;
  unitCode: string;
  lecturerUserId: string;
  lecturerName: string;
  title: string | null;
  scheduledStartAt: Date;
  opensAt: Date;
  /** Rounded minutes late. Negative when the class was activated early. */
  lateMinutes: number;
}

/**
 * The department's punctuality log, one row per class meeting, newest first.
 *
 * Sessions with no `scheduled_start_at` are excluded rather than reported as
 * on time: there is no schedule behind them, so nothing to be late against —
 * see `db/migrations/020_departments.sql`. `scheduledStartAt` is therefore
 * never null on these rows.
 */
export async function listTimekeeping(
  departmentId: string,
  options: { lecturerUserId?: string; unitId?: string; limit: number },
): Promise<TimekeepingRow[]> {
  const { rows } = await query<{
    session_id: string;
    unit_id: string;
    unit_code: string;
    lecturer_user_id: string;
    lecturer_name: string;
    title: string | null;
    scheduled_start_at: Date;
    opens_at: Date;
    late_minutes: number;
  }>(
    `SELECT s.id AS session_id, s.unit_id, u.code AS unit_code,
            s.lecturer_user_id, usr.full_name AS lecturer_name, s.title,
            s.scheduled_start_at, s.opens_at,
            ROUND(${LATE_MINUTES})::int AS late_minutes
       FROM attendance_sessions s
       JOIN units u   ON u.id = s.unit_id
       JOIN users usr ON usr.id = s.lecturer_user_id
      WHERE s.lecturer_user_id IN (${DEPT_LECTURERS})
        AND ${MEASURABLE}
        AND ($2::uuid IS NULL OR s.lecturer_user_id = $2)
        AND ($3::uuid IS NULL OR s.unit_id = $3)
      ORDER BY s.opens_at DESC
      LIMIT $4`,
    [departmentId, options.lecturerUserId ?? null, options.unitId ?? null, options.limit],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    title: r.title,
    scheduledStartAt: r.scheduled_start_at,
    opensAt: r.opens_at,
    lateMinutes: r.late_minutes,
  }));
}

export interface LecturerSessionRow {
  sessionId: string;
  unitId: string;
  unitCode: string;
  title: string | null;
  status: string;
  opensAt: Date;
  closesAt: Date;
  scheduledStartAt: Date | null;
  present: number;
  /** ACTIVE allocations on the unit now — the roster-size convention the reporting module uses. */
  total: number;
}

/** The drill-down's recent sessions for one lecturer, with their timekeeping. */
export async function listLecturerSessions(
  lecturerUserId: string,
  limit: number,
): Promise<LecturerSessionRow[]> {
  const { rows } = await query<{
    session_id: string;
    unit_id: string;
    unit_code: string;
    title: string | null;
    status: string;
    opens_at: Date;
    closes_at: Date;
    scheduled_start_at: Date | null;
    present: number;
    total: number;
  }>(
    `SELECT s.id AS session_id, s.unit_id, u.code AS unit_code, s.title, s.status,
            s.opens_at, s.closes_at, s.scheduled_start_at,
            (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::int AS present,
            (SELECT COUNT(*) FROM unit_allocations a
              WHERE a.unit_id = s.unit_id AND a.status = 'ACTIVE')::int AS total
       FROM attendance_sessions s
       JOIN units u ON u.id = s.unit_id
      WHERE s.lecturer_user_id = $1
      ORDER BY s.opens_at DESC
      LIMIT $2`,
    [lecturerUserId, limit],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    title: r.title,
    status: r.status,
    opensAt: r.opens_at,
    closesAt: r.closes_at,
    scheduledStartAt: r.scheduled_start_at,
    present: r.present,
    total: r.total,
  }));
}

import { query, queryOne, transaction } from '../../db/database.js';

/**
 * All SQL for the faculty module. Every query is parameterised.
 *
 * The department module one level down: every query here takes a
 * `faculty_id` as `$1`. Teaching is scoped by the unit's owning department
 * (`units.department_id IN (SELECT id FROM departments WHERE faculty_id = $1)`),
 * staff by the lecturer's own department — the same split
 * `department.repository.ts` makes. The rate math and the "null means nothing measured yet"
 * rule are identical to `department.repository.ts` — a faculty's numbers
 * must reconcile with what each of its departments reports on its own.
 */

/** Departments of one faculty. */
const FACULTY_DEPTS = `SELECT id FROM departments WHERE faculty_id = $1`;

/** Units owned by any department of one faculty, as a subquery every aggregate below reuses. */
const FACULTY_UNITS = `SELECT id FROM units WHERE department_id IN (${FACULTY_DEPTS})`;

/**
 * The faculty's departments, or just `$3` when it is set — the department
 * drill-down's narrowing. `$3` can only narrow: it is ANDed with the faculty.
 */
const SCOPE_DEPTS = `SELECT id FROM departments WHERE faculty_id = $1 AND ($3::uuid IS NULL OR id = $3)`;
const SCOPE_UNITS = `SELECT id FROM units WHERE department_id IN (${SCOPE_DEPTS})`;

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

export interface OfficerFaculty {
  facultyId: string;
  facultyName: string;
}

/**
 * The faculty an officer oversees, read from `faculty_profiles` rather than
 * taken from the session's cached account — this is the value every other
 * query here is scoped by, so it is re-read from the row that owns it.
 */
export async function findOfficerFaculty(userId: string): Promise<OfficerFaculty | null> {
  const row = await queryOne<{ faculty_id: string; faculty_name: string }>(
    `SELECT f.id AS faculty_id, f.name AS faculty_name
       FROM faculty_profiles fp
       JOIN faculties f ON f.id = fp.faculty_id
      WHERE fp.user_id = $1`,
    [userId],
  );
  if (!row) return null;
  return { facultyId: row.faculty_id, facultyName: row.faculty_name };
}

export interface FacultyOverviewRow {
  departmentCount: number;
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  /** 0–100, averaged across every session in the faculty. */
  avgAttendanceRate: number;
  sessionsHeld: number;
  /** 0–100, or null when no session in the faculty has a schedule to be judged against. */
  onTimeRate: number | null;
}

/**
 * The faculty's stat cards. `studentCount` counts distinct students, the same
 * head-count identity `department.repository.ts getOverview` uses — a
 * student on two units in the faculty still counts once.
 */
export async function getOverview(
  facultyId: string,
  graceMinutes: number,
): Promise<FacultyOverviewRow> {
  const row = await queryOne<{
    department_count: number;
    lecturer_count: number;
    student_count: number;
    unit_count: number;
    avg_attendance_rate: number;
    sessions_held: number;
    on_time_rate: number | null;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM departments WHERE faculty_id = $1)::int AS department_count,

       (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users usr ON usr.id = lp.user_id
         WHERE lp.department_id IN (SELECT id FROM departments WHERE faculty_id = $1)
           AND usr.deleted_at IS NULL)::int AS lecturer_count,

       (SELECT COUNT(*) FROM units u
         WHERE u.department_id IN (${FACULTY_DEPTS}))::int AS unit_count,

       (SELECT COUNT(DISTINCT COALESCE(a.student_user_id::text, 'reg:' || a.registration_number))
          FROM unit_allocations a
         WHERE a.status = 'ACTIVE'
           AND a.unit_id IN (${FACULTY_UNITS}))::int AS student_count,

       (SELECT COUNT(*) FROM attendance_sessions s
         WHERE s.unit_id IN (${FACULTY_UNITS}))::int AS sessions_held,

       (SELECT COALESCE(AVG(rate), 0)::float8
          FROM (SELECT ${SESSION_RATE} AS rate
                  FROM attendance_sessions s
                 WHERE s.unit_id IN (${FACULTY_UNITS})) per_session
         WHERE rate IS NOT NULL) AS avg_attendance_rate,

       (SELECT (COUNT(*) FILTER (WHERE s.opens_at <= s.scheduled_start_at + make_interval(mins => $2))::numeric
                / NULLIF(COUNT(*), 0) * 100)::float8
          FROM attendance_sessions s
         WHERE s.unit_id IN (${FACULTY_UNITS})
           AND ${MEASURABLE}) AS on_time_rate`,
    [facultyId, graceMinutes],
  );
  return {
    departmentCount: row?.department_count ?? 0,
    lecturerCount: row?.lecturer_count ?? 0,
    studentCount: row?.student_count ?? 0,
    unitCount: row?.unit_count ?? 0,
    avgAttendanceRate: row?.avg_attendance_rate ?? 0,
    sessionsHeld: row?.sessions_held ?? 0,
    onTimeRate: row?.on_time_rate ?? null,
  };
}

export interface FacultyDepartmentRow {
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  onTimeRate: number | null;
}

/**
 * One row per department in the faculty — the same six figures
 * `getOverview` reports for the whole faculty, computed per department
 * instead. This is the faculty's one genuinely new capability: comparing
 * departments against each other, which is nothing a department officer
 * could see on their own.
 */
export async function listDepartments(
  facultyId: string,
  graceMinutes: number,
): Promise<FacultyDepartmentRow[]> {
  const { rows } = await query<{
    department_id: string;
    department_name: string;
    lecturer_count: number;
    student_count: number;
    unit_count: number;
    avg_attendance_rate: number;
    sessions_held: number;
    on_time_rate: number | null;
  }>(
    `SELECT d.id AS department_id, d.name AS department_name,

            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users usr ON usr.id = lp.user_id
              WHERE lp.department_id = d.id AND usr.deleted_at IS NULL)::int AS lecturer_count,

            (SELECT COUNT(*) FROM units u WHERE u.department_id = d.id)::int AS unit_count,

            (SELECT COUNT(DISTINCT COALESCE(a.student_user_id::text, 'reg:' || a.registration_number))
               FROM unit_allocations a
              WHERE a.status = 'ACTIVE'
                AND a.unit_id IN (SELECT id FROM units WHERE department_id = d.id))::int AS student_count,

            (SELECT COUNT(*) FROM attendance_sessions s
              WHERE s.unit_id IN (SELECT id FROM units WHERE department_id = d.id))::int AS sessions_held,

            (SELECT COALESCE(AVG(rate), 0)::float8
               FROM (SELECT ${SESSION_RATE} AS rate
                       FROM attendance_sessions s
                      WHERE s.unit_id IN (SELECT id FROM units WHERE department_id = d.id)) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate,

            (SELECT (COUNT(*) FILTER (WHERE s.opens_at <= s.scheduled_start_at + make_interval(mins => $2))::numeric
                     / NULLIF(COUNT(*), 0) * 100)::float8
               FROM attendance_sessions s
              WHERE s.unit_id IN (SELECT id FROM units WHERE department_id = d.id)
                AND ${MEASURABLE}) AS on_time_rate

       FROM departments d
      WHERE d.faculty_id = $1
      ORDER BY d.name`,
    [facultyId, graceMinutes],
  );
  return rows.map((r) => ({
    departmentId: r.department_id,
    departmentName: r.department_name,
    lecturerCount: r.lecturer_count,
    studentCount: r.student_count,
    unitCount: r.unit_count,
    avgAttendanceRate: r.avg_attendance_rate,
    sessionsHeld: r.sessions_held,
    onTimeRate: r.on_time_rate,
  }));
}

/** The faculty one department belongs to, for the department drill-down's ownership check. Null if the department does not exist. */
export async function findDepartmentFacultyId(departmentId: string): Promise<string | null> {
  const row = await queryOne<{ faculty_id: string | null }>(
    `SELECT faculty_id FROM departments WHERE id = $1`,
    [departmentId],
  );
  return row ? row.faculty_id : null;
}

export async function findDepartmentName(departmentId: string): Promise<string | null> {
  const row = await queryOne<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [departmentId]);
  return row?.name ?? null;
}

/**
 * Whether a lecturer is one the faculty deals with — staff of one of its
 * departments, or teaching one of its units — for the drill-down's ownership check.
 */
export async function isLecturerInFacultyScope(facultyId: string, lecturerUserId: string): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
        WHERE lp.user_id = $2 AND u.deleted_at IS NULL
          AND (lp.department_id IN (${FACULTY_DEPTS})
               OR EXISTS (SELECT 1 FROM units un WHERE un.lecturer_user_id = lp.user_id AND un.id IN (${FACULTY_UNITS})))
     ) AS found`,
    [facultyId, lecturerUserId],
  );
  return row?.found ?? false;
}

/** The faculty one lecturer's home department belongs to, for the account-deletion ownership check. Null when there is no lecturer profile for that user id, or it names no department. */
export async function findLecturerFacultyId(lecturerUserId: string): Promise<string | null> {
  const row = await queryOne<{ faculty_id: string | null }>(
    `SELECT d.faculty_id
       FROM lecturer_profiles lp
       JOIN departments d ON d.id = lp.department_id
       JOIN users u       ON u.id = lp.user_id
      WHERE lp.user_id = $1 AND u.deleted_at IS NULL`,
    [lecturerUserId],
  );
  return row ? row.faculty_id : null;
}

export interface FacultyLecturerRow {
  userId: string;
  fullName: string;
  staffNumber: string;
  /** The lecturer's home department; null while unassigned. May be outside the faculty for a borrowed lecturer. */
  departmentId: string | null;
  departmentName: string | null;
  /** Whether the home department is in scope (the faculty, or the narrowed department). */
  isOwnStaff: boolean;
  /** Units in scope the lecturer teaches; every figure below is over these alone. */
  unitsTaught: number;
  unitsElsewhere: number;
  studentsTaught: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  avgLateMinutes: number | null;
  onTimeRate: number | null;
}

/**
 * One row per lecturer in the faculty — its departments' staff plus anyone
 * teaching one of its units — or just one department's when `departmentId`
 * is given; the department drill-down reuses this rather than keeping a
 * second copy of the per-lecturer aggregate query. Figures are over the
 * units in scope, so the rows add up to the faculty's (or department's) totals.
 */
export async function listLecturers(
  facultyId: string,
  graceMinutes: number,
  departmentId?: string,
): Promise<FacultyLecturerRow[]> {
  const { rows } = await query<{
    user_id: string;
    full_name: string;
    staff_number: string;
    department_id: string | null;
    department_name: string | null;
    is_own_staff: boolean;
    units_taught: number;
    units_elsewhere: number;
    students_taught: number;
    avg_attendance_rate: number;
    sessions_held: number;
    avg_late_minutes: number | null;
    on_time_rate: number | null;
  }>(
    `SELECT lp.user_id, usr.full_name, lp.staff_number, d.id AS department_id, d.name AS department_name,
            COALESCE(lp.department_id IN (${SCOPE_DEPTS}), FALSE) AS is_own_staff,

            (SELECT COUNT(*) FROM units u
              WHERE u.lecturer_user_id = lp.user_id AND u.id IN (${SCOPE_UNITS}))::int AS units_taught,

            (SELECT COUNT(*) FROM units u
              WHERE u.lecturer_user_id = lp.user_id AND u.id NOT IN (${SCOPE_UNITS}))::int AS units_elsewhere,

            (SELECT COUNT(*) FROM unit_allocations a
              WHERE a.unit_id IN (SELECT id FROM units WHERE lecturer_user_id = lp.user_id)
                AND a.unit_id IN (${SCOPE_UNITS}) AND a.status = 'ACTIVE')::int AS students_taught,

            (SELECT COUNT(*) FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id AND s.unit_id IN (${SCOPE_UNITS}))::int AS sessions_held,

            (SELECT COALESCE(AVG(rate), 0)::float8
               FROM (SELECT ${SESSION_RATE} AS rate
                       FROM attendance_sessions s
                      WHERE s.lecturer_user_id = lp.user_id AND s.unit_id IN (${SCOPE_UNITS})) per_session
              WHERE rate IS NOT NULL) AS avg_attendance_rate,

            (SELECT AVG(${LATE_MINUTES})::float8
               FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id AND s.unit_id IN (${SCOPE_UNITS}) AND ${MEASURABLE}) AS avg_late_minutes,

            (SELECT (COUNT(*) FILTER (WHERE s.opens_at <= s.scheduled_start_at + make_interval(mins => $2))::numeric
                     / NULLIF(COUNT(*), 0) * 100)::float8
               FROM attendance_sessions s
              WHERE s.lecturer_user_id = lp.user_id AND s.unit_id IN (${SCOPE_UNITS}) AND ${MEASURABLE}) AS on_time_rate

       FROM lecturer_profiles lp
       JOIN users usr ON usr.id = lp.user_id
  LEFT JOIN departments d ON d.id = lp.department_id
      WHERE usr.deleted_at IS NULL
        AND (lp.department_id IN (${SCOPE_DEPTS})
             OR lp.user_id IN (SELECT lecturer_user_id FROM units WHERE id IN (${SCOPE_UNITS})))
      ORDER BY NOT COALESCE(lp.department_id IN (${SCOPE_DEPTS}), FALSE), d.name NULLS LAST, usr.full_name`,
    [facultyId, graceMinutes, departmentId ?? null],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    fullName: r.full_name,
    staffNumber: r.staff_number,
    departmentId: r.department_id,
    departmentName: r.department_name,
    isOwnStaff: r.is_own_staff,
    unitsTaught: r.units_taught,
    unitsElsewhere: r.units_elsewhere,
    studentsTaught: r.students_taught,
    avgAttendanceRate: r.avg_attendance_rate,
    sessionsHeld: r.sessions_held,
    avgLateMinutes: r.avg_late_minutes,
    onTimeRate: r.on_time_rate,
  }));
}

/** Whether a student is on any roster of the faculty's units — the scope an officer may delete a student account in. */
export async function isStudentInFaculty(facultyId: string, studentUserId: string): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM unit_allocations a JOIN units u ON u.id = a.unit_id
        WHERE a.student_user_id = $2 AND u.department_id IN (${FACULTY_DEPTS})
     ) AS found`,
    [facultyId, studentUserId],
  );
  return row?.found ?? false;
}

export interface LecturerHeaderRow {
  userId: string;
  fullName: string;
  staffNumber: string;
  title: string | null;
  email: string;
  /** Home department; null while unassigned. */
  departmentId: string | null;
  departmentName: string | null;
}

export async function findLecturerHeader(lecturerUserId: string): Promise<LecturerHeaderRow | null> {
  const row = await queryOne<{
    user_id: string;
    full_name: string;
    staff_number: string;
    title: string | null;
    email: string;
    department_id: string | null;
    department_name: string | null;
  }>(
    `SELECT lp.user_id, usr.full_name, lp.staff_number, lp.title, usr.email,
            d.id AS department_id, d.name AS department_name
       FROM lecturer_profiles lp
       JOIN users usr ON usr.id = lp.user_id
  LEFT JOIN departments d ON d.id = lp.department_id
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
    departmentId: row.department_id,
    departmentName: row.department_name,
  };
}

export interface FacultyUnitRow {
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  departmentId: string;
  departmentName: string;
  activeStudents: number;
  sessionsHeld: number;
  avgAttendanceRate: number;
}

/**
 * Units owned by the faculty's departments, optionally narrowed to one lecturer or one
 * department — both the lecturer drill-down and the department drill-down
 * reuse this rather than keeping their own copies of the per-unit rate query.
 */
export async function listUnits(
  facultyId: string,
  options: { lecturerUserId?: string; departmentId?: string } = {},
): Promise<FacultyUnitRow[]> {
  const { rows } = await query<{
    unit_id: string;
    unit_code: string;
    unit_name: string | null;
    lecturer_user_id: string;
    lecturer_name: string;
    department_id: string;
    department_name: string;
    active_students: number;
    sessions_held: number;
    avg_attendance_rate: number;
  }>(
    `SELECT u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            u.lecturer_user_id, usr.full_name AS lecturer_name,
            d.id AS department_id, d.name AS department_name,

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
       JOIN departments d ON d.id = u.department_id
      WHERE d.faculty_id = $1
        AND ($2::uuid IS NULL OR u.lecturer_user_id = $2)
        AND ($3::uuid IS NULL OR d.id = $3)
      ORDER BY d.name, u.code`,
    [facultyId, options.lecturerUserId ?? null, options.departmentId ?? null],
  );
  return rows.map((r) => ({
    unitId: r.unit_id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    activeStudents: r.active_students,
    sessionsHeld: r.sessions_held,
    avgAttendanceRate: r.avg_attendance_rate,
  }));
}

export interface FacultyStudentRow {
  id: string;
  registration_number: string | null;
  student_user_id: string | null;
  full_name: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_user_id: string;
  lecturer_name: string;
  department_id: string;
  department_name: string;
  sessions_held: number;
  sessions_attended: number;
}

/**
 * `department.repository.ts`'s `listStudents` widened from one department to
 * every department in the faculty — one row per (student, unit), with the
 * teaching lecturer and the unit's owning department named.
 */
export async function listStudents(facultyId: string): Promise<FacultyStudentRow[]> {
  const { rows } = await query<FacultyStudentRow>(
    `SELECT a.id, a.registration_number, a.student_user_id,
            COALESCE(a.full_name, su.full_name) AS full_name,
            u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            u.lecturer_user_id, lu.full_name AS lecturer_name,
            d.id AS department_id, d.name AS department_name,
            COUNT(DISTINCT se.id) FILTER (
              WHERE se.opens_at <= NOW()
                AND (r.id IS NOT NULL OR se.status = 'CLOSED' OR se.closes_at <= NOW())
            )::int AS sessions_held,
            COUNT(DISTINCT r.id)::int AS sessions_attended
       FROM unit_allocations a
       JOIN units u  ON u.id = a.unit_id
       JOIN users lu ON lu.id = u.lecturer_user_id
       JOIN departments d ON d.id = u.department_id
  LEFT JOIN users su ON su.id = a.student_user_id
  LEFT JOIN attendance_sessions se ON se.unit_id = u.id
  LEFT JOIN attendance_records r   ON r.session_id = se.id AND r.student_user_id = a.student_user_id
      WHERE d.faculty_id = $1 AND a.status = 'ACTIVE'
      GROUP BY a.id, a.registration_number, a.student_user_id, a.full_name, su.full_name,
               u.id, u.code, u.name, u.lecturer_user_id, lu.full_name, d.id, d.name
      ORDER BY full_name NULLS LAST, u.code`,
    [facultyId],
  );
  return rows;
}

export interface TimekeepingRow {
  sessionId: string;
  unitId: string;
  unitCode: string;
  lecturerUserId: string;
  lecturerName: string;
  departmentId: string;
  departmentName: string;
  title: string | null;
  scheduledStartAt: Date;
  opensAt: Date;
  /** Rounded minutes late. Negative when the class was activated early. */
  lateMinutes: number;
}

/**
 * The faculty's punctuality log, one row per class meeting, newest first.
 * Sessions with no `scheduled_start_at` are excluded rather than reported as
 * on time — see `department.repository.ts listTimekeeping`.
 */
export async function listTimekeeping(
  facultyId: string,
  options: { lecturerUserId?: string; unitId?: string; departmentId?: string; limit: number },
): Promise<TimekeepingRow[]> {
  const { rows } = await query<{
    session_id: string;
    unit_id: string;
    unit_code: string;
    lecturer_user_id: string;
    lecturer_name: string;
    department_id: string;
    department_name: string;
    title: string | null;
    scheduled_start_at: Date;
    opens_at: Date;
    late_minutes: number;
  }>(
    `SELECT s.id AS session_id, s.unit_id, u.code AS unit_code,
            s.lecturer_user_id, usr.full_name AS lecturer_name,
            d.id AS department_id, d.name AS department_name, s.title,
            s.scheduled_start_at, s.opens_at,
            ROUND(${LATE_MINUTES})::int AS late_minutes
       FROM attendance_sessions s
       JOIN units u   ON u.id = s.unit_id
       JOIN users usr ON usr.id = s.lecturer_user_id
       JOIN departments d ON d.id = u.department_id
      WHERE d.faculty_id = $1
        AND ${MEASURABLE}
        AND ($2::uuid IS NULL OR s.lecturer_user_id = $2)
        AND ($3::uuid IS NULL OR s.unit_id = $3)
        AND ($4::uuid IS NULL OR d.id = $4)
      ORDER BY s.opens_at DESC
      LIMIT $5`,
    [facultyId, options.lecturerUserId ?? null, options.unitId ?? null, options.departmentId ?? null, options.limit],
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
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

/** The lecturer drill-down's recent sessions on the faculty's units, with their timekeeping. */
export async function listLecturerSessions(
  facultyId: string,
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
      WHERE u.department_id IN (${FACULTY_DEPTS}) AND s.lecturer_user_id = $2
      ORDER BY s.opens_at DESC
      LIMIT $3`,
    [facultyId, lecturerUserId, limit],
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

/**
 * The department a proposed name would duplicate: one whose name has the same
 * canonical form, or one this spelling is already a known alias of. Null when
 * the name is genuinely new.
 */
export async function findDepartmentForName(name: string): Promise<{ id: string; name: string } | null> {
  return queryOne<{ id: string; name: string }>(
    `SELECT d.id, d.name FROM departments d WHERE d.id = department_for_name($1)`,
    [name],
  );
}

export interface NewDepartment {
  id: string;
  name: string;
}

/**
 * Creates a department in the given faculty. A duplicate name is a
 * unique-constraint violation the service layer turns into a 409.
 *
 * Unassigned lecturers whose SMARTTT department name matches are placed in it
 * at once, the same match sign-in makes (`department_for_name`): they signed
 * in before the department existed.
 */
export async function createDepartment(facultyId: string, name: string): Promise<NewDepartment> {
  return transaction(async (client) => {
    const row = await queryOne<{ id: string; name: string }>(
      `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id, name`,
      [name, facultyId],
      client,
    );
    if (!row) throw new Error('departments insert returned no row');
    await query(
      `UPDATE lecturer_profiles SET department_id = $1, updated_at = NOW()
        WHERE department_id IS NULL AND department_for_name(department) = $1`,
      [row.id],
      client,
    );
    return row;
  });
}

export interface NewCourseOffering {
  id: string;
  code: string;
  name: string | null;
  departmentId: string;
  segmentsPlanned: number;
}

/**
 * Provides a course to a department: a row with no lecturer yet. Throws the
 * raw Postgres unique-violation on a duplicate code — the service layer maps
 * it to a 409, the same way `unit.service.ts createUnit` does for `units.code`.
 */
export async function createCourseOffering(
  departmentId: string,
  code: string,
  name: string | null,
  createdByUserId: string,
): Promise<NewCourseOffering> {
  const row = await queryOne<{ id: string; code: string; name: string | null; department_id: string; segments_planned: number }>(
    `INSERT INTO course_offerings (code, name, department_id, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, code, name, department_id, segments_planned`,
    [code, name, departmentId, createdByUserId],
  );
  if (!row) throw new Error('course_offerings insert returned no row');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    departmentId: row.department_id,
    segmentsPlanned: row.segments_planned,
  };
}

export interface CourseOfferingListRow {
  id: string;
  code: string;
  name: string | null;
  segmentsPlanned: number;
  segmentsFilled: number;
}

/** Offerings in one department, with how many of their planned segments already have a lecturer — same query `department.repository.ts listCourseOfferings` runs, one level up. */
export async function listCourseOfferings(departmentId: string): Promise<CourseOfferingListRow[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string | null;
    segments_planned: number;
    segments_filled: number;
  }>(
    `SELECT co.id, co.code, co.name, co.segments_planned,
            (SELECT COUNT(*) FROM units u WHERE u.offering_id = co.id)::int AS segments_filled
       FROM course_offerings co
      WHERE co.department_id = $1
      ORDER BY co.code`,
    [departmentId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    segmentsPlanned: r.segments_planned,
    segmentsFilled: r.segments_filled,
  }));
}

export interface FacultyCourseOfferingRow {
  id: string;
  code: string;
  name: string | null;
  departmentId: string;
  departmentName: string;
  segmentsPlanned: number;
  segmentsFilled: number;
}

/** Every course offering across every department in the faculty, with department named — the faculty-wide view across `listCourseOfferings`' per-department one. */
export async function listFacultyCourseOfferings(facultyId: string): Promise<FacultyCourseOfferingRow[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string | null;
    department_id: string;
    department_name: string;
    segments_planned: number;
    segments_filled: number;
  }>(
    `SELECT co.id, co.code, co.name, d.id AS department_id, d.name AS department_name, co.segments_planned,
            (SELECT COUNT(*) FROM units u WHERE u.offering_id = co.id)::int AS segments_filled
       FROM course_offerings co
       JOIN departments d ON d.id = co.department_id
      WHERE d.faculty_id = $1
      ORDER BY d.name, co.code`,
    [facultyId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    segmentsPlanned: r.segments_planned,
    segmentsFilled: r.segments_filled,
  }));
}

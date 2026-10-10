import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import * as facultyRepository from './faculty.repository.js';

/**
 * Faculty oversight: what one faculty's officer may see about the teaching
 * every department in that faculty does. The same two rules
 * `department.service.ts` holds, one level up.
 *
 * 1. **Scope comes from the database, not the request.** The caller's
 *    faculty is read from their own `faculty_profiles` row by user id —
 *    never from a query parameter, and never from the account cached on the
 *    session. Nothing an officer sends can widen what they see.
 *
 * 2. **Ownership is checked before anything is returned.** The two
 *    endpoints that name something else (a lecturer, a department) resolve
 *    its own faculty first and refuse unless it matches.
 *
 * Everything here is read-only, so nothing is audited — same precedent.
 */

/** How late a class may be activated and still count as on time. */
export const ON_TIME_GRACE_MINUTES = 5;

/** Recent sessions shown on a lecturer drill-down. */
const DRILLDOWN_SESSION_LIMIT = 20;

/** 0–100 to one decimal, the same rounding every other module's rates use. */
const round1 = (value: number): number => Math.round(value * 10) / 10;
const round1OrNull = (value: number | null): number | null => (value === null ? null : round1(value));

/** Attended ÷ held as a percentage; null until a session has been held. */
const rateOf = (attended: number, held: number): number | null =>
  held > 0 ? Math.round((attended / held) * 1000) / 10 : null;

/** Minutes between a scheduled start and the actual one. Negative when activated early. */
const lateMinutes = (scheduledStartAt: Date | null, opensAt: Date): number | null =>
  scheduledStartAt === null
    ? null
    : Math.round((opensAt.getTime() - scheduledStartAt.getTime()) / 60_000);

export interface FacultyDto {
  facultyId: string;
  facultyName: string;
}

/**
 * The caller's own faculty. Every other function starts here, so a faculty
 * officer whose profile row has been removed gets one clear 403 rather than
 * empty results that look like a faculty with no departments.
 */
async function requireOwnFaculty(userId: string): Promise<FacultyDto> {
  const faculty = await facultyRepository.findOfficerFaculty(userId);
  if (!faculty) {
    throw AppError.forbidden('Your account is not attached to a faculty.');
  }
  return faculty;
}

/** GET /faculties/me */
export async function getMyFaculty(userId: string): Promise<FacultyDto> {
  return requireOwnFaculty(userId);
}

export interface FacultyOverviewDto {
  facultyId: string;
  facultyName: string;
  departmentCount: number;
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  /** 0–100, one decimal; 0 when no session has been held yet. */
  avgAttendanceRate: number;
  sessionsHeld: number;
  /** 0–100, one decimal. Null when no session in the faculty has a scheduled start to be judged against. */
  onTimeRate: number | null;
  graceMinutes: number;
  periodLabel: string;
}

/** GET /faculties/overview */
export async function getOverview(userId: string): Promise<FacultyOverviewDto> {
  const faculty = await requireOwnFaculty(userId);
  const row = await facultyRepository.getOverview(faculty.facultyId, ON_TIME_GRACE_MINUTES);
  return {
    facultyId: faculty.facultyId,
    facultyName: faculty.facultyName,
    departmentCount: row.departmentCount,
    lecturerCount: row.lecturerCount,
    studentCount: row.studentCount,
    unitCount: row.unitCount,
    avgAttendanceRate: round1(row.avgAttendanceRate),
    sessionsHeld: row.sessionsHeld,
    onTimeRate: round1OrNull(row.onTimeRate),
    graceMinutes: ON_TIME_GRACE_MINUTES,
    periodLabel: 'All time',
  };
}

export interface FacultyDepartmentDto {
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  onTimeRate: number | null;
}

const toDepartmentDto = (r: facultyRepository.FacultyDepartmentRow): FacultyDepartmentDto => ({
  departmentId: r.departmentId,
  departmentName: r.departmentName,
  lecturerCount: r.lecturerCount,
  studentCount: r.studentCount,
  unitCount: r.unitCount,
  avgAttendanceRate: round1(r.avgAttendanceRate),
  sessionsHeld: r.sessionsHeld,
  onTimeRate: round1OrNull(r.onTimeRate),
});

/** GET /faculties/departments — one row per department, the faculty's distinguishing view. */
export async function listDepartments(userId: string): Promise<FacultyDepartmentDto[]> {
  const faculty = await requireOwnFaculty(userId);
  const rows = await facultyRepository.listDepartments(faculty.facultyId, ON_TIME_GRACE_MINUTES);
  return rows.map(toDepartmentDto);
}

export interface FacultyLecturerDto {
  userId: string;
  fullName: string;
  staffNumber: string;
  departmentId: string;
  departmentName: string;
  unitsTaught: number;
  studentsTaught: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  avgLateMinutes: number | null;
  onTimeRate: number | null;
}

const toLecturerDto = (r: facultyRepository.FacultyLecturerRow): FacultyLecturerDto => ({
  userId: r.userId,
  fullName: r.fullName,
  staffNumber: r.staffNumber,
  departmentId: r.departmentId,
  departmentName: r.departmentName,
  unitsTaught: r.unitsTaught,
  studentsTaught: r.studentsTaught,
  avgAttendanceRate: round1(r.avgAttendanceRate),
  sessionsHeld: r.sessionsHeld,
  avgLateMinutes: round1OrNull(r.avgLateMinutes),
  onTimeRate: round1OrNull(r.onTimeRate),
});

/** GET /faculties/lecturers — every lecturer in the faculty, across every department. */
export async function listLecturers(userId: string): Promise<FacultyLecturerDto[]> {
  const faculty = await requireOwnFaculty(userId);
  const rows = await facultyRepository.listLecturers(faculty.facultyId, ON_TIME_GRACE_MINUTES);
  return rows.map(toLecturerDto);
}

export interface FacultyUnitDto {
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

const toUnitDto = (r: facultyRepository.FacultyUnitRow): FacultyUnitDto => ({
  unitId: r.unitId,
  unitCode: r.unitCode,
  unitName: r.unitName,
  lecturerUserId: r.lecturerUserId,
  lecturerName: r.lecturerName,
  departmentId: r.departmentId,
  departmentName: r.departmentName,
  activeStudents: r.activeStudents,
  sessionsHeld: r.sessionsHeld,
  avgAttendanceRate: round1(r.avgAttendanceRate),
});

/** GET /faculties/units */
export async function listUnits(userId: string): Promise<FacultyUnitDto[]> {
  const faculty = await requireOwnFaculty(userId);
  return (await facultyRepository.listUnits(faculty.facultyId)).map(toUnitDto);
}

/**
 * GET /faculties/departments/:departmentId
 *
 * A department outside the caller's faculty is reported as not found, not
 * forbidden — the same enumeration-resistance rule the lecturer drill-down
 * uses.
 */
/** A course offering as the department-detail drill-down lists it, with how many segments are filled. */
export interface DepartmentCourseDto {
  id: string;
  code: string;
  name: string | null;
  segmentsPlanned: number;
  segmentsFilled: number;
}

export async function getDepartmentDetail(
  userId: string,
  departmentId: string,
): Promise<{
  departmentId: string;
  departmentName: string;
  lecturers: FacultyLecturerDto[];
  units: FacultyUnitDto[];
  courses: DepartmentCourseDto[];
}> {
  const faculty = await requireOwnFaculty(userId);

  const departmentFacultyId = await facultyRepository.findDepartmentFacultyId(departmentId);
  if (departmentFacultyId !== faculty.facultyId) {
    throw AppError.notFound('No such department in your faculty.');
  }
  const departmentName = await facultyRepository.findDepartmentName(departmentId);
  if (!departmentName) throw AppError.notFound('No such department in your faculty.');

  const [lecturers, units, courses] = await Promise.all([
    facultyRepository.listLecturers(faculty.facultyId, ON_TIME_GRACE_MINUTES, departmentId),
    facultyRepository.listUnits(faculty.facultyId, { departmentId }),
    facultyRepository.listCourseOfferings(departmentId),
  ]);

  return {
    departmentId,
    departmentName,
    lecturers: lecturers.map(toLecturerDto),
    units: units.map(toUnitDto),
    courses,
  };
}

export interface LecturerSessionDto {
  sessionId: string;
  unitId: string;
  unitCode: string;
  title: string | null;
  status: string;
  opensAt: string;
  closesAt: string;
  scheduledStartAt: string | null;
  lateMinutes: number | null;
  present: number;
  total: number;
  attendanceRate: number | null;
}

export interface FacultyLecturerDetailDto {
  lecturer: {
    userId: string;
    fullName: string;
    staffNumber: string;
    title: string | null;
    email: string;
    departmentId: string;
    departmentName: string;
  };
  units: FacultyUnitDto[];
  sessions: LecturerSessionDto[];
}

/**
 * GET /faculties/lecturers/:lecturerUserId
 *
 * A lecturer outside the caller's faculty is reported as not found, not
 * forbidden — the same enumeration-resistance rule `department.service.ts`
 * uses.
 */
export async function getLecturerDetail(
  userId: string,
  lecturerUserId: string,
): Promise<FacultyLecturerDetailDto> {
  const faculty = await requireOwnFaculty(userId);

  const lecturerFacultyId = await facultyRepository.findLecturerFacultyId(lecturerUserId);
  if (lecturerFacultyId !== faculty.facultyId) {
    throw AppError.notFound('No such lecturer in your faculty.');
  }

  const [header, units, sessions] = await Promise.all([
    facultyRepository.findLecturerHeader(lecturerUserId),
    facultyRepository.listUnits(faculty.facultyId, { lecturerUserId }),
    facultyRepository.listLecturerSessions(lecturerUserId, DRILLDOWN_SESSION_LIMIT),
  ]);
  if (!header) throw AppError.notFound('No such lecturer in your faculty.');

  return {
    lecturer: header,
    units: units.map(toUnitDto),
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      unitId: s.unitId,
      unitCode: s.unitCode,
      title: s.title,
      status: s.status,
      opensAt: s.opensAt.toISOString(),
      closesAt: s.closesAt.toISOString(),
      scheduledStartAt: s.scheduledStartAt ? s.scheduledStartAt.toISOString() : null,
      lateMinutes: lateMinutes(s.scheduledStartAt, s.opensAt),
      present: s.present,
      total: s.total,
      attendanceRate: rateOf(s.present, s.total),
    })),
  };
}

export interface FacultyStudentDto {
  id: string;
  registrationNumber: string | null;
  studentUserId: string | null;
  fullName: string | null;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  departmentId: string;
  departmentName: string;
  sessionsHeld: number;
  sessionsAttended: number;
  attendanceRate: number | null;
}

/** GET /faculties/students */
export async function listStudents(userId: string): Promise<FacultyStudentDto[]> {
  const faculty = await requireOwnFaculty(userId);
  const rows = await facultyRepository.listStudents(faculty.facultyId);
  return rows.map((r) => ({
    id: r.id,
    registrationNumber: r.registration_number,
    studentUserId: r.student_user_id,
    fullName: r.full_name,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: r.lecturer_name,
    departmentId: r.department_id,
    departmentName: r.department_name,
    sessionsHeld: r.sessions_held,
    sessionsAttended: r.sessions_attended,
    attendanceRate: rateOf(r.sessions_attended, r.sessions_held),
  }));
}

export interface TimekeepingDto {
  sessionId: string;
  unitId: string;
  unitCode: string;
  lecturerUserId: string;
  lecturerName: string;
  departmentId: string;
  departmentName: string;
  title: string | null;
  scheduledStartAt: string;
  opensAt: string;
  lateMinutes: number;
  onTime: boolean;
}

const TIMEKEEPING_DEFAULT_LIMIT = 50;

/** GET /faculties/timekeeping — `?lecturerUserId=&unitId=&departmentId=&limit=`, none of which can widen the scope. */
export async function listTimekeeping(
  userId: string,
  options: { lecturerUserId?: string; unitId?: string; departmentId?: string; limit?: number } = {},
): Promise<TimekeepingDto[]> {
  const faculty = await requireOwnFaculty(userId);
  const rows = await facultyRepository.listTimekeeping(faculty.facultyId, {
    lecturerUserId: options.lecturerUserId,
    unitId: options.unitId,
    departmentId: options.departmentId,
    limit: options.limit ?? TIMEKEEPING_DEFAULT_LIMIT,
  });
  return rows.map((r) => ({
    sessionId: r.sessionId,
    unitId: r.unitId,
    unitCode: r.unitCode,
    lecturerUserId: r.lecturerUserId,
    lecturerName: r.lecturerName,
    departmentId: r.departmentId,
    departmentName: r.departmentName,
    title: r.title,
    scheduledStartAt: r.scheduledStartAt.toISOString(),
    opensAt: r.opensAt.toISOString(),
    lateMinutes: r.lateMinutes,
    onTime: r.lateMinutes <= ON_TIME_GRACE_MINUTES,
  }));
}

/**
 * How this university actually provisions a class: faculty decides which
 * courses a department offers, the department decides how many
 * lecturer-taught sections it needs and assigns its own lecturers to them
 * (`department.service.ts allocateLecturer`). Both actions below create
 * rows scoped to the caller's own faculty — never to a `departmentId` the
 * caller merely names.
 */

/** POST /faculties/departments */
export async function createDepartment(userId: string, name: string): Promise<{ departmentId: string; departmentName: string }> {
  const faculty = await requireOwnFaculty(userId);
  try {
    const department = await facultyRepository.createDepartment(faculty.facultyId, name);
    return { departmentId: department.id, departmentName: department.name };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(`A department named "${name}" already exists.`, ErrorCode.CONFLICT, {
        details: [{ field: 'name', message: 'This department name is already in use.' }],
      });
    }
    throw error;
  }
}

export interface CourseOfferingDto {
  id: string;
  code: string;
  name: string | null;
  departmentId: string;
  segmentsPlanned: number;
}

/**
 * POST /faculties/departments/:departmentId/courses
 *
 * A department outside the caller's faculty is reported as not found, not
 * forbidden — the same enumeration-resistance rule the drill-downs use.
 */
export async function provideCourse(
  userId: string,
  departmentId: string,
  code: string,
  name: string | null,
): Promise<CourseOfferingDto> {
  const faculty = await requireOwnFaculty(userId);

  const departmentFacultyId = await facultyRepository.findDepartmentFacultyId(departmentId);
  if (departmentFacultyId !== faculty.facultyId) {
    throw AppError.notFound('No such department in your faculty.');
  }

  try {
    const offering = await facultyRepository.createCourseOffering(departmentId, code, name, userId);
    return offering;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(`${code} already exists as a course or unit.`, ErrorCode.CONFLICT, {
        details: [{ field: 'code', message: 'This code is already in use.' }],
      });
    }
    throw error;
  }
}

export interface FacultyCourseDto {
  id: string;
  code: string;
  name: string | null;
  departmentId: string;
  departmentName: string;
  segmentsPlanned: number;
  segmentsFilled: number;
}

/** GET /faculties/courses — every course offering across every department, department named. */
export async function listCourses(userId: string): Promise<FacultyCourseDto[]> {
  const faculty = await requireOwnFaculty(userId);
  return facultyRepository.listFacultyCourseOfferings(faculty.facultyId);
}

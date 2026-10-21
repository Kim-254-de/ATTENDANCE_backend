import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import * as invitationService from '../auth/auth.invitation.js';
import type { InviteeInput } from '../auth/auth.schema.js';
import { deleteAccount } from '../auth/auth.deletion.js';
import { listOfficers } from '../auth/auth.invitation.repository.js';
import type { RegistrationContext } from '../auth/auth.service.js';
import * as facultyRepository from './faculty.repository.js';
import * as placement from '../lecturer/lecturer.placement.js';
import { eligibilityService } from '../eligibility/index.js';
import { evaluationService } from '../quality-assurance/index.js';

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
  /** Home department; null while unassigned, and possibly outside the faculty for a borrowed lecturer. */
  departmentId: string | null;
  departmentName: string | null;
  /** False for a lecturer from elsewhere teaching one of the faculty's (or department's) units. */
  isOwnStaff: boolean;
  /** Units in scope only; every figure below is over these. */
  unitsTaught: number;
  unitsElsewhere: number;
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
  isOwnStaff: r.isOwnStaff,
  unitsTaught: r.unitsTaught,
  unitsElsewhere: r.unitsElsewhere,
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
    departmentId: string | null;
    departmentName: string | null;
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

  if (!(await facultyRepository.isLecturerInFacultyScope(faculty.facultyId, lecturerUserId))) {
    throw AppError.notFound('No such lecturer in your faculty.');
  }

  const [header, units, sessions] = await Promise.all([
    facultyRepository.findLecturerHeader(lecturerUserId),
    facultyRepository.listUnits(faculty.facultyId, { lecturerUserId }),
    facultyRepository.listLecturerSessions(faculty.facultyId, lecturerUserId, DRILLDOWN_SESSION_LIMIT),
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
  // "Department of Computer Science" next to "Computer Science" is the same
  // department spelled twice; refuse it before the exact-name constraint would.
  const existing = await facultyRepository.findDepartmentForName(name);
  if (existing) {
    throw AppError.conflict(`"${name}" is the same department as "${existing.name}", which already exists.`, ErrorCode.CONFLICT, {
      details: [{ field: 'name', message: `Already exists as "${existing.name}".` }],
    });
  }
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

/**
 * DELETE /faculties/lecturers/:lecturerUserId
 *
 * 404 unless the lecturer's own department is in the caller's faculty:
 * teaching one of its units gives the faculty no say over the account. The account is anonymised (auth.deletion.ts).
 */
export async function deleteLecturer(userId: string, lecturerUserId: string, context: RegistrationContext): Promise<void> {
  const faculty = await requireOwnFaculty(userId);
  if ((await facultyRepository.findLecturerFacultyId(lecturerUserId)) !== faculty.facultyId) {
    throw AppError.notFound('No such lecturer in your faculty.');
  }
  await deleteAccount(lecturerUserId, 'LECTURER', { userId, kind: 'FACULTY' }, context);
}

/** DELETE /faculties/students/:studentUserId — 404 unless the student is on a roster of one of the faculty's units. */
export async function deleteStudent(userId: string, studentUserId: string, context: RegistrationContext): Promise<void> {
  const faculty = await requireOwnFaculty(userId);
  if (!(await facultyRepository.isStudentInFaculty(faculty.facultyId, studentUserId))) {
    throw AppError.notFound('No such student in your faculty.');
  }
  await deleteAccount(studentUserId, 'STUDENT', { userId, kind: 'FACULTY' }, context);
}

/** GET /faculties/officers — the department officers of the faculty's departments, invited or active. */
export async function listDepartmentOfficers(userId: string): Promise<invitationService.OfficerDto[]> {
  const faculty = await requireOwnFaculty(userId);
  return (await listOfficers({ roles: ['DEPARTMENT'], facultyId: faculty.facultyId })).map(invitationService.officerDto);
}

/**
 * POST /faculties/departments/:departmentId/officers
 *
 * A faculty officer invites the officer for one of its own departments
 * (auth.invitation.ts). A department outside the faculty is a 404, like the
 * drill-downs.
 */
export async function inviteDepartmentOfficer(
  userId: string,
  inviterName: string,
  departmentId: string,
  input: InviteeInput,
  context: RegistrationContext,
): Promise<invitationService.InvitationResult> {
  const faculty = await requireOwnFaculty(userId);
  if ((await facultyRepository.findDepartmentFacultyId(departmentId)) !== faculty.facultyId) {
    throw AppError.notFound('No such department in your faculty.');
  }
  const departmentName = await facultyRepository.findDepartmentName(departmentId);
  return invitationService.invite(
    { email: input.email, fullName: input.fullName, scope: { role: 'DEPARTMENT', departmentId }, scopeName: departmentName },
    { userId, fullName: inviterName },
    context,
  );
}

/** A department officer of one of the caller's departments, or 404. */
async function requireOwnDepartmentOfficer(userId: string, officerUserId: string) {
  const faculty = await requireOwnFaculty(userId);
  const [officer] = await listOfficers({ roles: ['DEPARTMENT'], facultyId: faculty.facultyId, userId: officerUserId });
  if (!officer) throw AppError.notFound('No such department officer in your faculty.');
  return officer;
}

/** POST /faculties/officers/:userId/resend */
export async function resendDepartmentOfficerInvitation(
  userId: string,
  inviterName: string,
  officerUserId: string,
  context: RegistrationContext,
): Promise<invitationService.InvitationResult> {
  const officer = await requireOwnDepartmentOfficer(userId, officerUserId);
  return invitationService.resend(officer, { userId, fullName: inviterName }, context);
}

/** POST /faculties/officers/:userId/deactivate */
export async function deactivateDepartmentOfficer(userId: string, officerUserId: string, context: RegistrationContext): Promise<void> {
  const officer = await requireOwnDepartmentOfficer(userId, officerUserId);
  await invitationService.deactivate(officer, userId, context);
}

/** Most lecturers the placement list returns at once. */
const PLACEMENT_LIMIT = 100;

/**
 * GET /faculties/lecturer-placement — lecturers the officer may place:
 * every unassigned lecturer in the institution (they belong to no faculty
 * yet, so any faculty may claim them), then the faculty's own staff.
 */
export async function listPlacementLecturers(
  userId: string,
  options: { search?: string; unassignedOnly?: boolean } = {},
): Promise<placement.PlacementLecturerRow[]> {
  const faculty = await requireOwnFaculty(userId);
  return placement.listLecturers({
    facultyId: faculty.facultyId,
    unassignedOnly: options.unassignedOnly,
    search: options.search?.trim() || null,
    limit: PLACEMENT_LIMIT,
  });
}

/**
 * PATCH /faculties/lecturers/:lecturerUserId/department
 *
 * The lecturer must be unassigned or already in one of the faculty's
 * departments (404 otherwise, as everywhere), and the target must be one of
 * the faculty's departments. Moving a lecturer to another faculty is an
 * administrator's call, since neither faculty officer sees both sides.
 */
export async function moveLecturer(
  userId: string,
  lecturerUserId: string,
  departmentId: string,
  context: RegistrationContext,
): Promise<placement.MoveResult> {
  const faculty = await requireOwnFaculty(userId);
  const lecturer = await placement.findLecturer(lecturerUserId);
  if (!lecturer || (lecturer.departmentId !== null && lecturer.facultyId !== faculty.facultyId)) {
    throw AppError.notFound('No such lecturer in your faculty.');
  }
  const department = await placement.findDepartment(departmentId);
  if (!department || department.facultyId !== faculty.facultyId) {
    throw AppError.badRequest('Choose one of your faculty\'s departments.');
  }
  if (lecturer.departmentId === department.id) return { ...lecturer, learnedSpelling: null, alsoPlaced: 0 };
  return placement.moveLecturer(lecturer, department, { userId, kind: 'FACULTY' }, context);
}

/** GET /faculties/eligibility — `?departmentId=` narrows to one of the faculty's departments (404 for any other). */
export async function getEligibility(
  userId: string,
  options: { departmentId?: string; includeAll?: boolean } = {},
): Promise<eligibilityService.EligibilityReportDto> {
  const faculty = await requireOwnFaculty(userId);
  if (options.departmentId && (await facultyRepository.findDepartmentFacultyId(options.departmentId)) !== faculty.facultyId) {
    throw AppError.notFound('No such department in your faculty.');
  }
  return eligibilityService.buildReport(
    options.departmentId ? { departmentId: options.departmentId } : { facultyId: faculty.facultyId },
    { includeAll: options.includeAll },
  );
}

/** GET /faculties/evaluations — evaluation rounds that have opened. */
export async function listEvaluations(userId: string): Promise<evaluationService.RoundDto[]> {
  await requireOwnFaculty(userId);
  return evaluationService.listStartedRounds();
}

/** GET /faculties/evaluations/:id — `?departmentId=` narrows to one of the faculty's departments (404 for any other). */
export async function getEvaluationResults(
  userId: string,
  roundId: string,
  departmentId?: string,
): Promise<evaluationService.RoundResultsDto> {
  const faculty = await requireOwnFaculty(userId);
  if (departmentId && (await facultyRepository.findDepartmentFacultyId(departmentId)) !== faculty.facultyId) {
    throw AppError.notFound('No such department in your faculty.');
  }
  return evaluationService.getResults(roundId, departmentId ? { departmentId } : { facultyId: faculty.facultyId });
}

import { AppError } from '../../common/errors/index.js';
import * as departmentRepository from './department.repository.js';

/**
 * Department oversight: what one department's officer may see about the
 * teaching their department does.
 *
 * Two rules hold for every function here.
 *
 * 1. **Scope comes from the database, not the request.** The caller's
 *    department is read from their own `department_profiles` row by user id —
 *    never from a query parameter, and never from the account cached on the
 *    session. Nothing an officer sends can widen what they see.
 *
 * 2. **Ownership is checked before anything is returned.** The only endpoint
 *    that names another user (the lecturer drill-down) resolves that
 *    lecturer's own `department_id` first and refuses unless it matches.
 *
 * Everything here is read-only, so nothing is audited — the same precedent the
 * reporting module's GET endpoints set. An officer reading their department's
 * own figures is not an event; there is nothing to reconstruct later.
 */

/**
 * How late a class may be activated and still count as on time. Rooms do not
 * unlock on the second and a projector takes a minute, so a strict comparison
 * would report honest lecturers as late.
 */
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

export interface DepartmentDto {
  departmentId: string;
  departmentName: string;
  facultyId: string | null;
  facultyName: string | null;
}

/**
 * The caller's own department. Every other function starts here, so a
 * department officer whose profile row has been removed gets one clear 403
 * rather than empty results that look like a department with no staff.
 */
async function requireOwnDepartment(userId: string): Promise<DepartmentDto> {
  const department = await departmentRepository.findOfficerDepartment(userId);
  if (!department) {
    throw AppError.forbidden('Your account is not attached to a department.');
  }
  return department;
}

/** GET /departments/me */
export async function getMyDepartment(userId: string): Promise<DepartmentDto> {
  return requireOwnDepartment(userId);
}

export interface DepartmentOverviewDto {
  departmentId: string;
  departmentName: string;
  lecturerCount: number;
  studentCount: number;
  unitCount: number;
  /** 0–100, one decimal; 0 when no session has been held yet. */
  avgAttendanceRate: number;
  sessionsHeld: number;
  /**
   * 0–100, one decimal. Null — not 0 — when no session in the department has a
   * scheduled start to be judged against, so "nothing measured" cannot be
   * mistaken for "nobody on time".
   */
  onTimeRate: number | null;
  graceMinutes: number;
  /** Honest: there is no semester concept in this schema to scope the figures to. */
  periodLabel: string;
}

/** GET /departments/overview */
export async function getOverview(userId: string): Promise<DepartmentOverviewDto> {
  const department = await requireOwnDepartment(userId);
  const row = await departmentRepository.getOverview(department.departmentId, ON_TIME_GRACE_MINUTES);
  return {
    departmentId: department.departmentId,
    departmentName: department.departmentName,
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

export interface DepartmentLecturerDto {
  userId: string;
  fullName: string;
  staffNumber: string;
  unitsTaught: number;
  studentsTaught: number;
  avgAttendanceRate: number;
  sessionsHeld: number;
  /** Mean minutes late across the lecturer's scheduled sessions; null when none is measurable. */
  avgLateMinutes: number | null;
  onTimeRate: number | null;
}

/** GET /departments/lecturers */
export async function listLecturers(userId: string): Promise<DepartmentLecturerDto[]> {
  const department = await requireOwnDepartment(userId);
  const rows = await departmentRepository.listLecturers(department.departmentId, ON_TIME_GRACE_MINUTES);
  return rows.map((r) => ({
    userId: r.userId,
    fullName: r.fullName,
    staffNumber: r.staffNumber,
    unitsTaught: r.unitsTaught,
    studentsTaught: r.studentsTaught,
    avgAttendanceRate: round1(r.avgAttendanceRate),
    sessionsHeld: r.sessionsHeld,
    avgLateMinutes: round1OrNull(r.avgLateMinutes),
    onTimeRate: round1OrNull(r.onTimeRate),
  }));
}

export interface DepartmentUnitDto {
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  activeStudents: number;
  sessionsHeld: number;
  avgAttendanceRate: number;
}

const toUnitDto = (r: departmentRepository.DepartmentUnitRow): DepartmentUnitDto => ({
  unitId: r.unitId,
  unitCode: r.unitCode,
  unitName: r.unitName,
  lecturerUserId: r.lecturerUserId,
  lecturerName: r.lecturerName,
  activeStudents: r.activeStudents,
  sessionsHeld: r.sessionsHeld,
  avgAttendanceRate: round1(r.avgAttendanceRate),
});

/** GET /departments/units */
export async function listUnits(userId: string): Promise<DepartmentUnitDto[]> {
  const department = await requireOwnDepartment(userId);
  return (await departmentRepository.listUnits(department.departmentId)).map(toUnitDto);
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
  /** Null when the session has no scheduled start to compare against. */
  lateMinutes: number | null;
  present: number;
  total: number;
  attendanceRate: number | null;
}

export interface DepartmentLecturerDetailDto {
  lecturer: {
    userId: string;
    fullName: string;
    staffNumber: string;
    title: string | null;
    email: string;
  };
  units: DepartmentUnitDto[];
  sessions: LecturerSessionDto[];
}

/**
 * GET /departments/lecturers/:lecturerUserId
 *
 * A lecturer outside the caller's department is reported as not found, not as
 * forbidden: "this lecturer exists but is not yours" would let an officer
 * enumerate staff across the whole institution one user id at a time.
 */
export async function getLecturerDetail(
  userId: string,
  lecturerUserId: string,
): Promise<DepartmentLecturerDetailDto> {
  const department = await requireOwnDepartment(userId);

  const lecturerDepartmentId = await departmentRepository.findLecturerDepartmentId(lecturerUserId);
  if (lecturerDepartmentId !== department.departmentId) {
    throw AppError.notFound('No such lecturer in your department.');
  }

  const [header, units, sessions] = await Promise.all([
    departmentRepository.findLecturerHeader(lecturerUserId),
    departmentRepository.listUnits(department.departmentId, lecturerUserId),
    departmentRepository.listLecturerSessions(lecturerUserId, DRILLDOWN_SESSION_LIMIT),
  ]);
  if (!header) throw AppError.notFound('No such lecturer in your department.');

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

export interface DepartmentStudentDto {
  id: string;
  registrationNumber: string | null;
  studentUserId: string | null;
  fullName: string | null;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  lecturerName: string;
  sessionsHeld: number;
  sessionsAttended: number;
  /** 0–100, one decimal; null until a session has been held for this unit. */
  attendanceRate: number | null;
}

/** GET /departments/students */
export async function listStudents(userId: string): Promise<DepartmentStudentDto[]> {
  const department = await requireOwnDepartment(userId);
  const rows = await departmentRepository.listStudents(department.departmentId);
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
  title: string | null;
  scheduledStartAt: string;
  opensAt: string;
  /** Minutes late, rounded. Negative when the class was activated early. */
  lateMinutes: number;
  onTime: boolean;
}

/** Shown when the request names no limit of its own. */
const TIMEKEEPING_DEFAULT_LIMIT = 50;

/**
 * GET /departments/timekeeping
 *
 * `lecturerUserId` and `unitId` narrow the log; neither can widen it, because
 * the department filter is applied alongside them rather than instead of them.
 * A lecturer from another department simply matches no rows.
 */
export async function listTimekeeping(
  userId: string,
  options: { lecturerUserId?: string; unitId?: string; limit?: number } = {},
): Promise<TimekeepingDto[]> {
  const department = await requireOwnDepartment(userId);
  const rows = await departmentRepository.listTimekeeping(department.departmentId, {
    lecturerUserId: options.lecturerUserId,
    unitId: options.unitId,
    limit: options.limit ?? TIMEKEEPING_DEFAULT_LIMIT,
  });
  return rows.map((r) => ({
    sessionId: r.sessionId,
    unitId: r.unitId,
    unitCode: r.unitCode,
    lecturerUserId: r.lecturerUserId,
    lecturerName: r.lecturerName,
    title: r.title,
    scheduledStartAt: r.scheduledStartAt.toISOString(),
    opensAt: r.opensAt.toISOString(),
    lateMinutes: r.lateMinutes,
    onTime: r.lateMinutes <= ON_TIME_GRACE_MINUTES,
  }));
}

/**
 * Course provisioning, the department's half: faculty has already provided
 * the course (`faculty.service.ts provideCourse`); from here the department
 * decides how many lecturer-taught segments it needs and assigns its own
 * lecturers to them. Allocating is immediate — no confirmation step, no
 * ERP check — and reuses `units.base_code`/`class_group`, so the resulting
 * unit is a completely ordinary one to every other module in this codebase.
 */

export interface CourseOfferingDto {
  id: string;
  code: string;
  name: string | null;
  segmentsPlanned: number;
  segmentsFilled: number;
}

/** GET /departments/courses */
export async function listCourses(userId: string): Promise<CourseOfferingDto[]> {
  const department = await requireOwnDepartment(userId);
  return departmentRepository.listCourseOfferings(department.departmentId);
}

/**
 * An offering outside the caller's department is reported as not found, not
 * forbidden — the same enumeration-resistance rule every other named-resource
 * endpoint in this module uses.
 */
async function requireOwnOffering(userId: string, offeringId: string): Promise<DepartmentDto> {
  const department = await requireOwnDepartment(userId);
  const offeringDepartmentId = await departmentRepository.findOfferingDepartmentId(offeringId);
  if (offeringDepartmentId !== department.departmentId) {
    throw AppError.notFound('No such course in your department.');
  }
  return department;
}

/** PATCH /departments/courses/:offeringId — how many sections this course needs. */
export async function setSegmentCount(userId: string, offeringId: string, segmentsPlanned: number): Promise<void> {
  await requireOwnOffering(userId, offeringId);
  const filled = await departmentRepository.countFilledSegments(offeringId);
  if (segmentsPlanned < filled) {
    throw AppError.badRequest(
      `This course already has ${filled} section${filled === 1 ? '' : 's'} assigned; it cannot be reduced below that.`,
    );
  }
  await departmentRepository.updateSegmentsPlanned(offeringId, segmentsPlanned);
}

export interface AllocatedUnitDto {
  unitId: string;
  code: string;
}

/**
 * POST /departments/courses/:offeringId/segments
 *
 * The lecturer must belong to this department — the same ownership rule the
 * oversight endpoints use, now enforced on a write: a department can only
 * assign its own staff, never borrow another department's lecturer.
 */
export async function allocateLecturer(
  userId: string,
  offeringId: string,
  lecturerUserId: string,
): Promise<AllocatedUnitDto> {
  const department = await requireOwnOffering(userId, offeringId);

  const lecturerDepartmentId = await departmentRepository.findLecturerDepartmentId(lecturerUserId);
  if (lecturerDepartmentId !== department.departmentId) {
    throw AppError.badRequest('That lecturer is not in your department.');
  }

  const result = await departmentRepository.allocateLecturerToSegment(offeringId, lecturerUserId);
  if (!result.ok) {
    throw AppError.conflict('This course already has a lecturer assigned to every planned section.');
  }
  return { unitId: result.unitId, code: result.code };
}

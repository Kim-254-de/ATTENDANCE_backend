import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as facultyService from './faculty.service.js';
import type { InviteeInput } from '../auth/auth.schema.js';
import type { CreateDepartmentInput, DepartmentIdParam, LecturerUserIdParam, OfficerUserIdParam, ProvideCourseInput, StudentUserIdParam, TimekeepingQuery } from './faculty.schema.js';

/**
 * HTTP in and out only. The caller's faculty is never read from the
 * request — the service resolves it from the signed-in user id.
 */
function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/faculties/me */
export async function me(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.getMyFaculty(userId(req)));
}

/** GET /api/v1/faculties/overview */
export async function overview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.getOverview(userId(req)));
}

/** GET /api/v1/faculties/departments */
export async function departments(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listDepartments(userId(req)));
}

/** GET /api/v1/faculties/departments/:departmentId */
export async function departmentDetail(req: Request, res: Response): Promise<void> {
  const { departmentId } = req.params as unknown as DepartmentIdParam;
  sendSuccess(res, await facultyService.getDepartmentDetail(userId(req), departmentId));
}

/** GET /api/v1/faculties/lecturers */
export async function lecturers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listLecturers(userId(req)));
}

/** GET /api/v1/faculties/lecturers/:lecturerUserId */
export async function lecturerDetail(req: Request, res: Response): Promise<void> {
  const { lecturerUserId } = req.params as unknown as LecturerUserIdParam;
  sendSuccess(res, await facultyService.getLecturerDetail(userId(req), lecturerUserId));
}

/** GET /api/v1/faculties/students */
export async function students(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listStudents(userId(req)));
}

/** GET /api/v1/faculties/units */
export async function units(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listUnits(userId(req)));
}

/** GET /api/v1/faculties/timekeeping */
export async function timekeeping(req: Request, res: Response): Promise<void> {
  const { lecturerUserId, unitId, departmentId, limit } = req.query as unknown as TimekeepingQuery;
  sendSuccess(res, await facultyService.listTimekeeping(userId(req), { lecturerUserId, unitId, departmentId, limit }));
}

/** POST /api/v1/faculties/departments */
export async function createDepartment(req: Request, res: Response): Promise<void> {
  const { name } = req.body as CreateDepartmentInput;
  sendCreated(res, await facultyService.createDepartment(userId(req), name));
}

/** POST /api/v1/faculties/departments/:departmentId/courses */
export async function provideCourse(req: Request, res: Response): Promise<void> {
  const { departmentId } = req.params as unknown as DepartmentIdParam;
  const { code, name } = req.body as ProvideCourseInput;
  sendCreated(res, await facultyService.provideCourse(userId(req), departmentId, code, name ?? null));
}

/** GET /api/v1/faculties/courses */
export async function courses(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listCourses(userId(req)));
}

/** DELETE /api/v1/faculties/lecturers/:lecturerUserId */
export async function deleteLecturer(req: Request, res: Response): Promise<void> {
  const { lecturerUserId } = req.params as unknown as LecturerUserIdParam;
  await facultyService.deleteLecturer(userId(req), lecturerUserId, { ...clientFingerprint(req), requestId: req.requestId });
  res.status(204).end();
}

/** DELETE /api/v1/faculties/students/:studentUserId */
export async function deleteStudent(req: Request, res: Response): Promise<void> {
  const { studentUserId } = req.params as unknown as StudentUserIdParam;
  await facultyService.deleteStudent(userId(req), studentUserId, { ...clientFingerprint(req), requestId: req.requestId });
  res.status(204).end();
}

const facultyContext = (req: Request) => ({ ...clientFingerprint(req), requestId: req.requestId });
const officerName = (req: Request) => req.auth?.faculty?.fullName ?? '';

/** GET /api/v1/faculties/officers */
export async function officers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await facultyService.listDepartmentOfficers(userId(req)));
}

/** POST /api/v1/faculties/departments/:departmentId/officers */
export async function inviteDepartmentOfficer(req: Request, res: Response): Promise<void> {
  const { departmentId } = req.params as unknown as DepartmentIdParam;
  sendCreated(
    res,
    await facultyService.inviteDepartmentOfficer(userId(req), officerName(req), departmentId, req.body as InviteeInput, facultyContext(req)),
  );
}

/** POST /api/v1/faculties/officers/:userId/resend */
export async function resendOfficerInvitation(req: Request, res: Response): Promise<void> {
  const { userId: officerUserId } = req.params as unknown as OfficerUserIdParam;
  sendSuccess(res, await facultyService.resendDepartmentOfficerInvitation(userId(req), officerName(req), officerUserId, facultyContext(req)));
}

/** POST /api/v1/faculties/officers/:userId/deactivate */
export async function deactivateOfficer(req: Request, res: Response): Promise<void> {
  const { userId: officerUserId } = req.params as unknown as OfficerUserIdParam;
  await facultyService.deactivateDepartmentOfficer(userId(req), officerUserId, facultyContext(req));
  res.status(204).end();
}

import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as departmentService from './department.service.js';
import type { AllocateLecturerInput, LecturerUserIdParam, OfferingIdParam, SetSegmentCountInput, TimekeepingQuery } from './department.schema.js';

/**
 * HTTP in and out only. The caller's department is never read from the
 * request — the service resolves it from the signed-in user id, so nothing
 * here needs to (or may) pass a department along.
 */
function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/departments/me */
export async function me(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.getMyDepartment(userId(req)));
}

/** GET /api/v1/departments/overview */
export async function overview(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.getOverview(userId(req)));
}

/** GET /api/v1/departments/lecturers */
export async function lecturers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.listLecturers(userId(req)));
}

/** GET /api/v1/departments/lecturers/:lecturerUserId */
export async function lecturerDetail(req: Request, res: Response): Promise<void> {
  const { lecturerUserId } = req.params as unknown as LecturerUserIdParam;
  sendSuccess(res, await departmentService.getLecturerDetail(userId(req), lecturerUserId));
}

/** GET /api/v1/departments/students */
export async function students(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.listStudents(userId(req)));
}

/** GET /api/v1/departments/units */
export async function units(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.listUnits(userId(req)));
}

/** GET /api/v1/departments/timekeeping */
export async function timekeeping(req: Request, res: Response): Promise<void> {
  const { lecturerUserId, unitId, limit } = req.query as unknown as TimekeepingQuery;
  sendSuccess(res, await departmentService.listTimekeeping(userId(req), { lecturerUserId, unitId, limit }));
}

/** GET /api/v1/departments/courses */
export async function courses(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await departmentService.listCourses(userId(req)));
}

/** PATCH /api/v1/departments/courses/:offeringId */
export async function setSegmentCount(req: Request, res: Response): Promise<void> {
  const { offeringId } = req.params as unknown as OfferingIdParam;
  const { segmentsPlanned } = req.body as SetSegmentCountInput;
  await departmentService.setSegmentCount(userId(req), offeringId, segmentsPlanned);
  sendSuccess(res, { offeringId, segmentsPlanned });
}

/** POST /api/v1/departments/courses/:offeringId/segments */
export async function allocateLecturer(req: Request, res: Response): Promise<void> {
  const { offeringId } = req.params as unknown as OfferingIdParam;
  const { lecturerUserId } = req.body as AllocateLecturerInput;
  sendCreated(res, await departmentService.allocateLecturer(userId(req), offeringId, lecturerUserId));
}

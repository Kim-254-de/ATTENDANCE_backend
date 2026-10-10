import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as facultyService from './faculty.service.js';
import type { CreateDepartmentInput, DepartmentIdParam, LecturerUserIdParam, ProvideCourseInput, TimekeepingQuery } from './faculty.schema.js';

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

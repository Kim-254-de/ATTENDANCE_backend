import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import type { AdminInvitationInput, AliasIdParam, CreateFacultyInput, DepartmentIdParam, LecturerListQuery, MergeDepartmentInput, LecturerUserIdParam, MoveLecturerInput, OfficerUserIdParam } from './admin.schema.js';
import * as adminService from './admin.service.js';

/** HTTP in and out only. */

function actor(req: Request): adminService.Actor {
  const admin = req.auth?.admin;
  if (!admin) throw AppError.unauthenticated('Please sign in.');
  return { userId: admin.id, fullName: admin.fullName };
}

const context = (req: Request) => ({ ...clientFingerprint(req), requestId: req.requestId });

/** GET /api/v1/admin/faculties */
export async function faculties(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listFaculties());
}

/** POST /api/v1/admin/faculties */
export async function createFaculty(req: Request, res: Response): Promise<void> {
  const { name } = req.body as CreateFacultyInput;
  sendCreated(res, await adminService.createFaculty(name, actor(req), context(req)));
}

/** GET /api/v1/admin/officers */
export async function officers(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listAllOfficers());
}

/** POST /api/v1/admin/invitations */
export async function invite(req: Request, res: Response): Promise<void> {
  sendCreated(res, await adminService.invite(req.body as AdminInvitationInput, actor(req), context(req)));
}

/** POST /api/v1/admin/officers/:userId/resend */
export async function resend(req: Request, res: Response): Promise<void> {
  const { userId } = req.params as unknown as OfficerUserIdParam;
  sendSuccess(res, await adminService.resendInvitation(userId, actor(req), context(req)));
}

/** POST /api/v1/admin/officers/:userId/deactivate */
export async function deactivate(req: Request, res: Response): Promise<void> {
  const { userId } = req.params as unknown as OfficerUserIdParam;
  await adminService.deactivate(userId, actor(req), context(req));
  res.status(204).end();
}

/** GET /api/v1/admin/departments */
export async function departments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listDepartments());
}

/** GET /api/v1/admin/lecturers */
export async function lecturers(req: Request, res: Response): Promise<void> {
  const { q, unassigned } = req.query as unknown as LecturerListQuery;
  sendSuccess(res, await adminService.listLecturers({ search: q, unassignedOnly: unassigned }));
}

/** PATCH /api/v1/admin/lecturers/:lecturerUserId/department */
export async function moveLecturer(req: Request, res: Response): Promise<void> {
  const { lecturerUserId } = req.params as unknown as LecturerUserIdParam;
  const { departmentId } = req.body as MoveLecturerInput;
  sendSuccess(res, await adminService.moveLecturer(lecturerUserId, departmentId, actor(req), context(req)));
}

/** GET /api/v1/admin/department-aliases */
export async function departmentAliases(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listDepartmentAliases());
}

/** DELETE /api/v1/admin/department-aliases/:aliasId */
export async function deleteDepartmentAlias(req: Request, res: Response): Promise<void> {
  const { aliasId } = req.params as unknown as AliasIdParam;
  await adminService.deleteDepartmentAlias(aliasId, actor(req), context(req));
  res.status(204).end();
}

/** GET /api/v1/admin/department-duplicates */
export async function duplicateDepartments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listDuplicateDepartments());
}

/** POST /api/v1/admin/departments/:departmentId/merge */
export async function mergeDepartment(req: Request, res: Response): Promise<void> {
  const { departmentId } = req.params as unknown as DepartmentIdParam;
  const { intoDepartmentId } = req.body as MergeDepartmentInput;
  sendSuccess(res, await adminService.mergeDepartment(departmentId, intoDepartmentId, actor(req), context(req)));
}

import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import type { AdminInvitationInput, CreateFacultyInput, OfficerUserIdParam, UnitIdParam } from './admin.schema.js';
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

/** GET /api/v1/admin/units/pending */
export async function pendingUnits(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await adminService.listPendingUnits());
}

/** POST /api/v1/admin/units/:unitId/verify */
export async function verifyUnit(req: Request, res: Response): Promise<void> {
  const { unitId } = req.params as unknown as UnitIdParam;
  sendSuccess(res, await adminService.verifyUnit(unitId, actor(req), context(req)));
}

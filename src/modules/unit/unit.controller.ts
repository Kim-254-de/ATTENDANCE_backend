import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as unitService from './unit.service.js';
import type { CreateUnitInput, UnitIdParam } from './unit.schema.js';

/** HTTP in, HTTP out. Allocation rules live in the service. */

/** Who the signed-in lecturer is, for the SMARTTT sync (staff number and name). */
function lecturerIdentity(req: Request): unitService.LecturerIdentity | undefined {
  const lecturer = req.auth?.lecturer;
  return lecturer ? { name: lecturer.fullName, staffNumber: lecturer.staffNumber } : undefined;
}

function contextFrom(req: Request): unitService.RequestContext {
  return { ...clientFingerprint(req), requestId: req.requestId };
}

/** The authenticated user id, guaranteed present by requireAuth. */
function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/units */
export async function listUnits(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await unitService.listUnits(userId(req), lecturerIdentity(req)));
}

/** GET /api/v1/units/current — the unit ActivateClass may open a session for right now, or null. */
export async function getCurrentUnit(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await unitService.getCurrentUnit(userId(req), lecturerIdentity(req)));
}

/** POST /api/v1/units */
export async function createUnit(req: Request, res: Response): Promise<void> {
  const unit = await unitService.createUnit(
    req.body as CreateUnitInput,
    userId(req),
    { name: req.auth?.lecturer?.fullName ?? 'A lecturer', staffNumber: req.auth?.lecturer?.staffNumber ?? null },
    contextFrom(req),
  );
  sendCreated(res, unit);
}

/** GET /api/v1/units/:unitId/students — the roster, synced from SMARTTT (or the ERP when SMARTTT is off). */
export async function listStudents(req: Request, res: Response): Promise<void> {
  const { unitId } = req.params as unknown as UnitIdParam;
  sendSuccess(res, await unitService.listStudents(unitId, userId(req), lecturerIdentity(req)));
}

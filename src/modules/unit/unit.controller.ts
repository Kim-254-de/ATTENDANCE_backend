import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as unitService from './unit.service.js';
import type {
  AddStudentsInput,
  AllocationParam,
  CreateUnitInput,
  EnrolInput,
  UnitIdParam,
  UpdateAllocationInput,
} from './unit.schema.js';

/** HTTP in, HTTP out. Allocation rules live in the service. */

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
  sendSuccess(res, await unitService.listUnits(userId(req)));
}

/** GET /api/v1/units/current — the unit ActivateClass may open a session for right now, or null. */
export async function getCurrentUnit(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await unitService.getCurrentUnit(userId(req)));
}

/** POST /api/v1/units */
export async function createUnit(req: Request, res: Response): Promise<void> {
  const unit = await unitService.createUnit(
    req.body as CreateUnitInput,
    userId(req),
    contextFrom(req),
  );
  sendCreated(res, unit);
}

/** GET /api/v1/units/:unitId/students */
export async function listStudents(req: Request, res: Response): Promise<void> {
  const { unitId } = req.params as unknown as UnitIdParam;
  sendSuccess(res, await unitService.listStudents(unitId, userId(req)));
}

/** POST /api/v1/units/:unitId/students */
export async function addStudents(req: Request, res: Response): Promise<void> {
  const { unitId } = req.params as unknown as UnitIdParam;
  const results = await unitService.addStudents(
    unitId,
    req.body as AddStudentsInput,
    userId(req),
    contextFrom(req),
  );
  sendSuccess(res, results);
}

/** PATCH /api/v1/units/:unitId/students/:allocationId */
export async function updateAllocation(req: Request, res: Response): Promise<void> {
  const { unitId, allocationId } = req.params as unknown as AllocationParam;
  const allocation = await unitService.updateAllocation(
    unitId,
    allocationId,
    req.body as UpdateAllocationInput,
    userId(req),
    contextFrom(req),
  );
  sendSuccess(res, allocation);
}

/** POST /api/v1/units/enrol */
export async function enrol(req: Request, res: Response): Promise<void> {
  const { code } = req.body as EnrolInput;
  sendSuccess(res, await unitService.requestEnrolment(code, userId(req), contextFrom(req)));
}

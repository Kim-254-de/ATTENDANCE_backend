import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as verificationService from './verification.service.js';
import type {
  ConfirmFaceInput,
  EnrollFaceInput,
  IdentifyFaceInput,
  SessionIdParam,
  UnitStudentParam,
} from './verification.schema.js';

/** HTTP in, HTTP out. Face check-in rules live in the service. */

function contextFrom(req: Request): verificationService.RequestContext {
  return { ...clientFingerprint(req), requestId: req.requestId };
}

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/students/me/face */
export async function myFaceStatus(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await verificationService.getMyFaceStatus(userId(req)));
}

/** PUT /api/v1/students/me/face-consent */
export async function giveConsent(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await verificationService.giveConsent(userId(req), contextFrom(req)));
}

/** DELETE /api/v1/students/me/face-consent */
export async function withdrawConsent(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await verificationService.withdrawConsent(userId(req), contextFrom(req)));
}

/** POST /api/v1/units/:unitId/students/:studentUserId/face */
export async function enrollFace(req: Request, res: Response): Promise<void> {
  const { unitId, studentUserId } = req.params as unknown as UnitStudentParam;
  const { images } = req.body as EnrollFaceInput;
  sendCreated(res, await verificationService.enrollFace(unitId, studentUserId, userId(req), images, contextFrom(req)));
}

/** DELETE /api/v1/units/:unitId/students/:studentUserId/face */
export async function removeEnrollment(req: Request, res: Response): Promise<void> {
  const { unitId, studentUserId } = req.params as unknown as UnitStudentParam;
  sendSuccess(res, await verificationService.removeEnrollment(unitId, studentUserId, userId(req), contextFrom(req)));
}

/** POST /api/v1/sessions/:sessionId/face/identify */
export async function identifyFace(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const { image } = req.body as IdentifyFaceInput;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  sendSuccess(res, await verificationService.identifyFace(sessionId, userId(req), image, contextFrom(req)));
}

/** POST /api/v1/sessions/:sessionId/face/confirm */
export async function confirmFace(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const { matchToken } = req.body as ConfirmFaceInput;
  sendCreated(res, await verificationService.confirmFace(sessionId, userId(req), matchToken, contextFrom(req)));
}

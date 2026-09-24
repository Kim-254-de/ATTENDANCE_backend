import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as attendanceService from './attendance.service.js';
import type { CheckInInput, SessionIdParam } from './attendance.schema.js';

/** HTTP in, HTTP out. */

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** POST /api/v1/attendance/check-in */
export async function checkIn(req: Request, res: Response): Promise<void> {
  const { payload } = req.body as CheckInInput;
  const result = await attendanceService.checkIn(payload, userId(req), {
    ...clientFingerprint(req),
    requestId: req.requestId,
  });
  sendCreated(res, result);
}

/** GET /api/v1/attendance/sessions/:sessionId */
export async function sessionAttendance(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  sendSuccess(res, await attendanceService.listSessionAttendance(sessionId, userId(req)));
}

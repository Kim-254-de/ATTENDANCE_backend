import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import * as studentService from './student.service.js';
import type { AttendanceHistoryQuery } from './student.schema.js';

/** HTTP in, HTTP out. */

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/students/me/units */
export async function myUnits(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await studentService.listMyUnits(userId(req)));
}

/** GET /api/v1/students/me/attendance */
export async function myAttendance(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  sendSuccess(res, await studentService.listMyAttendance(userId(req), req.query as unknown as AttendanceHistoryQuery));
}

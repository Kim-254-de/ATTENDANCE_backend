import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import * as studentService from './student.service.js';
import type { AttendanceHistoryQuery } from './student.schema.js';
import { evaluationService } from '../quality-assurance/index.js';
import type { SubmitEvaluationInput, SubmitParam } from '../quality-assurance/evaluation.schema.js';

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

/** GET /api/v1/students/me/evaluations */
export async function myEvaluations(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await evaluationService.listForStudent(userId(req)));
}

/** POST /api/v1/students/me/evaluations/:roundId/units/:unitId */
export async function submitEvaluation(req: Request, res: Response): Promise<void> {
  const { roundId, unitId } = req.params as unknown as SubmitParam;
  await evaluationService.submitForStudent(userId(req), roundId, unitId, req.body as SubmitEvaluationInput);
  res.status(204).end();
}

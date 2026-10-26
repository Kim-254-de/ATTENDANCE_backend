import type { Request, Response } from 'express';
import { Router } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { checkInLimiters } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import {
  examCheckInSchema,
  examSessionIdParamSchema,
  openExamSessionSchema,
  type ExamCheckInInput,
  type OpenExamSessionInput,
} from './exam.schema.js';
import * as examService from './exam.service.js';

/**
 * Exam sessions (exam.service.ts). An invigilator opens their own room, shows
 * its code, closes it and reads the report; a student checks in to their room.
 */
export const examRouter: Router = Router();

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated();
  return id;
}

function sessionId(req: Request): string {
  return String(req.params.sessionId);
}

/** The invigilator's exam rooms from today on. */
examRouter.get(
  '/sessions/mine',
  requireAuth('LECTURER'),
  asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await examService.myExamSessions(userId(req)))),
);

examRouter.post(
  '/sessions/:sessionId/open',
  requireAuth('LECTURER'),
  validate({ params: examSessionIdParamSchema, body: openExamSessionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as OpenExamSessionInput;
    sendSuccess(res, await examService.openExamSession(sessionId(req), userId(req), body));
  }),
);

/** The code to show in the room right now. */
examRouter.get(
  '/sessions/:sessionId/code',
  requireAuth('LECTURER'),
  validate({ params: examSessionIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await examService.currentExamCode(sessionId(req), userId(req))),
  ),
);

examRouter.post(
  '/sessions/:sessionId/close',
  requireAuth('LECTURER'),
  validate({ params: examSessionIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await examService.closeExamSession(sessionId(req), userId(req))),
  ),
);

/** Sat and absent: the room's, or every room of the paper for its main invigilator. */
examRouter.get(
  '/sessions/:sessionId/report',
  requireAuth('LECTURER'),
  validate({ params: examSessionIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await examService.report(sessionId(req), userId(req))),
  ),
);

/** A student checks in with the room's code: only to the room they were seated in. */
examRouter.post(
  '/check-in',
  requireAuth('STUDENT'),
  checkInLimiters.perStudent,
  validate({ body: examCheckInSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as ExamCheckInInput;
    sendSuccess(res, await examService.checkIn(body.payload, userId(req), body.location));
  }),
);

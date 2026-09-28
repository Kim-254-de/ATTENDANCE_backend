import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { checkInLimiters } from '../../middleware/rate-limit.js';
import * as attendanceController from './attendance.controller.js';
import { checkInSchema, sessionIdParamSchema } from './attendance.schema.js';

export const attendanceRouter: Router = Router();

/** A student submits a scanned code and, if it verifies, is recorded present. */
attendanceRouter.post(
  '/check-in',
  checkInLimiters.perIp,
  requireAuth('STUDENT'),
  checkInLimiters.perStudent,
  validate({ body: checkInSchema }),
  asyncHandler(attendanceController.checkIn),
);

/** Who has checked in to a session, for its lecturer. */
attendanceRouter.get(
  '/sessions/:sessionId',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema }),
  asyncHandler(attendanceController.sessionAttendance),
);

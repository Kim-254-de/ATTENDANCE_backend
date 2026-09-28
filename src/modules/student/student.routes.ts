import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as studentController from './student.controller.js';
import { attendanceHistoryQuerySchema } from './student.schema.js';

export const studentRouter: Router = Router();

/** The units the signed-in student is on, with their attendance rate in each. */
studentRouter.get('/me/units', requireAuth('STUDENT'), asyncHandler(studentController.myUnits));

/** The student's class sessions, newest first, each PRESENT, ABSENT or still OPEN. `?unitId=&limit=` */
studentRouter.get(
  '/me/attendance',
  requireAuth('STUDENT'),
  validate({ query: attendanceHistoryQuerySchema }),
  asyncHandler(studentController.myAttendance),
);

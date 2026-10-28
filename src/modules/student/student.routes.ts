import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as studentController from './student.controller.js';
import { attendanceHistoryQuerySchema } from './student.schema.js';
import { submitEvaluationSchema, submitParamSchema } from '../quality-assurance/evaluation.schema.js';

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

/** Open course evaluation rounds, each with the student's units and which they have already evaluated. */
studentRouter.get('/me/evaluations', requireAuth('STUDENT'), asyncHandler(studentController.myEvaluations));

/** Evaluates one unit in one round, anonymously and once. 404 if not open or not their unit; 409 if already done. */
studentRouter.post(
  '/me/evaluations/:roundId/units/:unitId',
  requireAuth('STUDENT'),
  validate({ params: submitParamSchema, body: submitEvaluationSchema }),
  asyncHandler(studentController.submitEvaluation),
);

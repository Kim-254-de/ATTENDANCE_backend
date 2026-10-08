import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { faceLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import * as verificationController from './verification.controller.js';
import {
  confirmFaceSchema,
  enrollFaceSchema,
  identifyFaceSchema,
  sessionIdParamSchema,
  unitStudentParamSchema,
} from './verification.schema.js';

/**
 * Face check-in. Mounted at the API root (src/routes.ts) because its paths
 * extend the students, units and sessions resources rather than sharing a prefix.
 *
 * Roles are split as for QR: only a student can consent for themselves, only
 * a lecturer can enroll a face or run the terminal.
 */
export const verificationRouter: Router = Router();

verificationRouter.get('/students/me/face', requireAuth('STUDENT'), asyncHandler(verificationController.myFaceStatus));

verificationRouter.put(
  '/students/me/face-consent',
  requireAuth('STUDENT'),
  asyncHandler(verificationController.giveConsent),
);

/** Withdrawing consent deletes the student's face templates. */
verificationRouter.delete(
  '/students/me/face-consent',
  requireAuth('STUDENT'),
  asyncHandler(verificationController.withdrawConsent),
);

/** The lecturer enrolls a student on their unit from three photos. */
verificationRouter.post(
  '/units/:unitId/students/:studentUserId/face',
  requireAuth('LECTURER'),
  faceLimiter,
  validate({ params: unitStudentParamSchema, body: enrollFaceSchema }),
  asyncHandler(verificationController.enrollFace),
);

verificationRouter.delete(
  '/units/:unitId/students/:studentUserId/face',
  requireAuth('LECTURER'),
  validate({ params: unitStudentParamSchema }),
  asyncHandler(verificationController.removeEnrollment),
);

/** The terminal: who is this? Records nothing. */
verificationRouter.post(
  '/sessions/:sessionId/face/identify',
  requireAuth('LECTURER'),
  faceLimiter,
  validate({ params: sessionIdParamSchema, body: identifyFaceSchema }),
  asyncHandler(verificationController.identifyFace),
);

/** The terminal: the lecturer confirmed the match. Records the student as FACE. */
verificationRouter.post(
  '/sessions/:sessionId/face/confirm',
  requireAuth('LECTURER'),
  faceLimiter,
  validate({ params: sessionIdParamSchema, body: confirmFaceSchema }),
  asyncHandler(verificationController.confirmFace),
);

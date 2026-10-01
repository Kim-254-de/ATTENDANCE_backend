import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { checkInLimiters } from '../../middleware/rate-limit.js';
import * as sessionController from './session.controller.js';
import {
  createSessionSchema,
  qrQuerySchema,
  sessionIdParamSchema,
  updateGeofenceSchema,
  verifyScanSchema,
} from './session.schema.js';

export const sessionRouter: Router = Router();

/**
 * Attendance sessions and rotating QR codes.
 *
 * Every route requires a signed-in user, and the roles are split deliberately:
 * only a lecturer can mint or view a code, only a student can present one.
 * A lecturer who could also scan could mark a hall present from their desk.
 */

/** Open a session for a unit the lecturer teaches. */
sessionRouter.post(
  '/',
  requireAuth('LECTURER'),
  validate({ body: createSessionSchema }),
  asyncHandler(sessionController.createSession),
);

/**
 * The lecturer's classes still open. Lets their phone, signed in to the same
 * account, find the class their laptop activated and send its location.
 */
sessionRouter.get('/live', requireAuth('LECTURER'), asyncHandler(sessionController.listLiveSessions));

/** The code to display right now, as JSON, with its countdown. */
sessionRouter.get(
  '/:sessionId/qr',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema }),
  asyncHandler(sessionController.getCurrentQr),
);

/** The same code rendered as an image, for display or download. */
sessionRouter.get(
  '/:sessionId/qr.image',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema, query: qrQuerySchema }),
  asyncHandler(sessionController.getQrImage),
);

/** A student submits a scanned code. */
sessionRouter.post(
  '/scan',
  checkInLimiters.perIp,
  requireAuth('STUDENT'),
  checkInLimiters.perStudent,
  validate({ body: verifyScanSchema }),
  asyncHandler(sessionController.verifyScan),
);

/** Pause, resume or close a session. */
sessionRouter.patch(
  '/:sessionId/status',
  requireAuth('LECTURER'),
  validate({
    params: sessionIdParamSchema,
    body: z.object({ status: z.enum(['OPEN', 'PAUSED', 'CLOSED']) }).strict(),
  }),
  asyncHandler(sessionController.setStatus),
);

/**
 * Switch the location check off or on, or re-centre it on the lecturer's device.
 * Also how the lecturer's phone sets the centre of a class opened AWAITING_LOCATION.
 */
sessionRouter.patch(
  '/:sessionId/geofence',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema, body: updateGeofenceSchema }),
  asyncHandler(sessionController.setGeofence),
);

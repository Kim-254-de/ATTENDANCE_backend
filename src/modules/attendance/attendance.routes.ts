import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { tokenHashesMatch } from '../../common/utils/tokens.js';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { checkInLimiters } from '../../middleware/rate-limit.js';
import * as attendanceController from './attendance.controller.js';
import {
  cardCheckInSchema,
  checkInSchema,
  fingerprintCheckInSchema,
  sessionIdParamSchema,
} from './attendance.schema.js';

export const attendanceRouter: Router = Router();

/**
 * A card terminal presents X-API-Key equal to CARD_TERMINAL_API_KEY.
 *
 * Fails closed when the key is unset: an unauthenticated endpoint that records
 * attendance for whoever a posted UID resolves to would let anyone mark a hall
 * present. Compared in constant time, as the SMARTTT key is.
 */
function requireCardTerminal(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.CARD_TERMINAL_API_KEY;
  const presented = req.get('X-API-Key');
  if (!expected || !presented || !tokenHashesMatch(presented, expected)) {
    next(new AppError(401, ErrorCode.INVALID_API_KEY, 'Invalid API key.'));
    return;
  }
  next();
}

/** A student submits a scanned code and, if it verifies, is recorded present. */
attendanceRouter.post(
  '/check-in',
  checkInLimiters.perIp,
  requireAuth('STUDENT'),
  checkInLimiters.perStudent,
  validate({ body: checkInSchema }),
  asyncHandler(attendanceController.checkIn),
);

/**
 * A student swipes their ID card at a terminal in the room and is recorded.
 *
 * perIp only, and deliberately: see CHECK_IN_PATHS in middleware/rate-limit.ts.
 */
attendanceRouter.post(
  '/card-check-in',
  requireCardTerminal,
  checkInLimiters.perIp,
  validate({ body: cardCheckInSchema }),
  asyncHandler(attendanceController.cardCheckIn),
);

/**
 * A fingerprint terminal presents X-API-Key equal to FINGERPRINT_TERMINAL_API_KEY.
 *
 * A separate key from the card terminals' so one class of device can be
 * revoked without taking the other down. Fails closed when unset.
 */
function requireFingerprintTerminal(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.FINGERPRINT_TERMINAL_API_KEY;
  const presented = req.get('X-API-Key');
  if (!expected || !presented || !tokenHashesMatch(presented, expected)) {
    next(new AppError(401, ErrorCode.INVALID_API_KEY, 'Invalid API key.'));
    return;
  }
  next();
}

/**
 * A student puts a finger on a terminal in the room and is recorded.
 *
 * perIp only, for the same reason as the card route: every presentation in a
 * hall comes from the one terminal, and perStudent keys on a signed-in user
 * that a terminal is not.
 */
attendanceRouter.post(
  '/fingerprint-check-in',
  requireFingerprintTerminal,
  checkInLimiters.perIp,
  validate({ body: fingerprintCheckInSchema }),
  asyncHandler(attendanceController.fingerprintCheckIn),
);

/** Who has checked in to a session, for its lecturer. */
attendanceRouter.get(
  '/sessions/:sessionId',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema }),
  asyncHandler(attendanceController.sessionAttendance),
);

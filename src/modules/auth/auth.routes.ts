import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { registrationLimiter } from '../../middleware/rate-limit.js';
import * as authController from './auth.controller.js';
import { emailVerificationSchema, lecturerRegistrationSchema } from './auth.schema.js';

export const authRouter: Router = Router();

/**
 * Lecturer registration.
 *
 * Rate limited before validation so a flood of malformed requests cannot be
 * used to drive outbound ERP traffic.
 *
 * 201 - account created, verification email sent
 * 400 - payload failed validation
 * 403 - staff number absent, inactive, or identity mismatched (REVOKED)
 * 409 - email or staff number already registered
 * 503 - the ERP could not be reached, so nothing was created
 */
authRouter.post(
  '/lecturer/register',
  registrationLimiter,
  validate({ body: lecturerRegistrationSchema }),
  asyncHandler(authController.registerLecturer),
);

/** Confirms the address using the token emailed at registration. */
authRouter.post(
  '/verify-email',
  registrationLimiter,
  validate({ body: emailVerificationSchema }),
  asyncHandler(authController.verifyEmail),
);

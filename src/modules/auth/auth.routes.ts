import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, registrationLimiter } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as authController from './auth.controller.js';
import { emailVerificationSchema, lecturerRegistrationSchema, loginSchema } from './auth.schema.js';

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

/**
 * Sign-in with a staff number or email plus password.
 *
 * 200 - signed in; httpOnly session cookies are set and the lecturer is returned
 * 401 - wrong credentials (same answer for an unknown account)
 * 403 - correct password but the account is pending / suspended / deactivated
 * 429 - too many attempts (per-IP limiter) or the account is temporarily locked
 */
authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

/** The signed-in lecturer, or 401. The portal calls this on load to restore the session. */
authRouter.get('/me', asyncHandler(requireAuth('LECTURER')), authController.me);

/** Rotates the refresh token and issues a new access token. */
authRouter.post('/refresh', loginLimiter, asyncHandler(authController.refresh));

/** Ends the session server-side and clears the cookies. Always 204. */
authRouter.post('/logout', asyncHandler(authController.logout));

import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, passwordResetLimiter, registrationLimiter } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as authController from './auth.controller.js';
import {
  avatarSchema,
  changePasswordSchema,
  emailVerificationSchema,
  forgotPasswordSchema,
  lecturerRegistrationSchema,
  loginSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from './auth.schema.js';

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
authRouter.get('/me', asyncHandler(requireAuth('LECTURER')), asyncHandler(authController.me));

/** Updates title/department only — see updateProfileSchema for why name and email are excluded. */
authRouter.patch(
  '/me',
  asyncHandler(requireAuth('LECTURER')),
  validate({ body: updateProfileSchema }),
  asyncHandler(authController.updateProfile),
);

/** Sets or replaces the profile photo. Body-size limit for this path is raised in app.ts. */
authRouter.post(
  '/me/avatar',
  asyncHandler(requireAuth('LECTURER')),
  validate({ body: avatarSchema }),
  asyncHandler(authController.setAvatar),
);

/** Removes the profile photo, reverting to initials. */
authRouter.delete('/me/avatar', asyncHandler(requireAuth('LECTURER')), asyncHandler(authController.removeAvatar));

/**
 * Changes a password from inside the app (as opposed to the emailed-token
 * reset flow below). Signs out every other device, not this one.
 *
 * 200 - password changed
 * 400 - current password wrong, or new password same as current
 * 429 - too many attempts
 */
authRouter.post(
  '/change-password',
  passwordResetLimiter,
  asyncHandler(requireAuth('LECTURER')),
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

/** Rotates the refresh token and issues a new access token. */
authRouter.post('/refresh', loginLimiter, asyncHandler(authController.refresh));

/** Ends the session server-side and clears the cookies. Always 204. */
authRouter.post('/logout', asyncHandler(authController.logout));

/**
 * Requests a password reset link (README section 4.1).
 *
 * Always 200, with identical wording whether or not the address has an
 * account: a different answer for a real address would make this endpoint a
 * directory of everyone at the institution.
 *
 * 200 - request accepted (says nothing about whether an account exists)
 * 400 - not a valid email address
 * 429 - too many requests from this device
 */
authRouter.post(
  '/forgot-password',
  passwordResetLimiter,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(authController.forgotPassword),
);

/**
 * Completes the reset using the token from the emailed link.
 *
 * On success every session is revoked, so an attacker who prompted the reset
 * is signed out too.
 *
 * 200 - password changed; all sessions revoked
 * 400 - link invalid, expired, already used, or the password was rejected
 * 429 - too many attempts
 */
authRouter.post(
  '/reset-password',
  passwordResetLimiter,
  validate({ body: resetPasswordSchema }),
  asyncHandler(authController.resetPassword),
);

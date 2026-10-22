import { Router, type RequestHandler } from 'express';
import type { AppError } from '../../common/errors/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { loginLimiter, passwordResetLimiter, registrationLimiter } from '../../middleware/rate-limit.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as authController from './auth.controller.js';
import { managedBySmarttt } from './auth.password.service.js';
import { registrationClosed } from './auth.service.js';
import { smartttAccountsEnabled } from './auth.smarttt.js';
import {
  acceptInvitationSchema,
  avatarSchema,
  changePasswordSchema,
  deleteAccountSchema,
  emailVerificationSchema,
  forgotPasswordSchema,
  invitationLookupSchema,
  lecturerRegistrationSchema,
  loginSchema,
  resetPasswordSchema,
  studentRegistrationSchema,
  updateProfileSchema,
} from './auth.schema.js';

export const authRouter: Router = Router();

/**
 * With SMARTTT accounts on (docs/smarttt-accounts.md), routes that only make
 * sense for attendance-held student and lecturer accounts are refused before
 * the body is validated: nothing it says would matter.
 */
const unlessSmartttAccounts =
  (refusal: () => AppError): RequestHandler =>
  (_req, _res, next) => {
    next(smartttAccountsEnabled() ? refusal() : undefined);
  };

/**
 * Lecturer registration.
 *
 * Rate limited before validation so a flood of malformed requests cannot be
 * used to drive outbound ERP traffic.
 *
 * 201 - account created and ACTIVE; the lecturer signs in next
 * 410 - SMARTTT accounts are on: lecturers sign in with their SMARTTT account instead
 * 400 - payload failed validation
 * 403 - staff number absent, inactive, or identity mismatched (REVOKED)
 * 409 - email or staff number already registered
 * 503 - the ERP could not be reached, so nothing was created
 */
authRouter.post(
  '/lecturer/register',
  registrationLimiter,
  unlessSmartttAccounts(registrationClosed),
  validate({ body: lecturerRegistrationSchema }),
  asyncHandler(authController.registerLecturer),
);

/**
 * Student registration.
 *
 * 201 - account created and ACTIVE; the student signs in next
 * 400 - payload failed validation
 * 403 - registration number not in the student records, not a current student, or name/email don't match
 * 410 - SMARTTT accounts are on: students sign in with their SMARTTT account instead
 * 409 - email or registration number already registered
 * 503 - the student records system (SMARTTT, or the ERP) could not be reached, so nothing was created
 */
authRouter.post(
  '/student/register',
  registrationLimiter,
  unlessSmartttAccounts(registrationClosed),
  validate({ body: studentRegistrationSchema }),
  asyncHandler(authController.registerStudent),
);

/** Confirms the address using the token emailed at registration. A student becomes ACTIVE here. */
authRouter.post(
  '/verify-email',
  registrationLimiter,
  validate({ body: emailVerificationSchema }),
  asyncHandler(authController.verifyEmail),
);

/**
 * Sign-in with a staff number (lecturers), registration number (students) or email, plus password.
 * With SMARTTT accounts on, students and lecturers use their SMARTTT login and password
 * (auth.smarttt.ts): the attendance account is created or linked at first sign-in.
 *
 * 200 - signed in; httpOnly session cookies are set and the account is returned (`role` is lecturer or student)
 * 401 - wrong credentials (same answer for an unknown account)
 * 403 - correct password but the account is pending / suspended / deactivated
 * 429 - too many attempts (per-IP limiter) or the account is temporarily locked
 * 503 - SMARTTT accounts are on and SMARTTT could not be asked
 */
authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));

/** The signed-in lecturer, student, department officer, faculty officer, administrator or QA officer, or 401. The portal calls this on load to restore the session. */
authRouter.get(
  '/me',
  asyncHandler(requireAuth('LECTURER', 'STUDENT', 'DEPARTMENT', 'FACULTY', 'ADMIN', 'QA')),
  asyncHandler(authController.me),
);

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
  asyncHandler(requireAuth('LECTURER', 'STUDENT')),
  validate({ body: avatarSchema }),
  asyncHandler(authController.setAvatar),
);

/** Removes the profile photo, reverting to initials. */
authRouter.delete('/me/avatar', asyncHandler(requireAuth('LECTURER', 'STUDENT')), asyncHandler(authController.removeAvatar));

/**
 * Changes a password from inside the app (as opposed to the emailed-token
 * reset flow below). Signs out every other device, not this one.
 *
 * 200 - password changed
 * 400 - current password wrong, or new password same as current
 * 409 - SMARTTT accounts are on and the caller is a student or lecturer: that password is changed in SMARTTT
 * 429 - too many attempts
 */
authRouter.post(
  '/change-password',
  passwordResetLimiter,
  // Every role: officers' passwords stay attendance's own even with SMARTTT accounts on.
  asyncHandler(requireAuth()),
  (req, _res, next) => {
    const role = req.auth?.role;
    next(smartttAccountsEnabled() && (role === 'STUDENT' || role === 'LECTURER') ? managedBySmarttt() : undefined);
  },
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

/**
 * Deletes the signed-in student's or lecturer's own account (auth.deletion.ts):
 * anonymised, signed out everywhere, passkeys and biometrics removed.
 * Attendance history stays, without their name on it.
 *
 * 204 - deleted; the session cookies are cleared
 * 400 - password missing or wrong
 * 429 - too many attempts
 * 503 - SMARTTT accounts are on and SMARTTT could not check the password; nothing was deleted
 */
authRouter.delete(
  '/me',
  passwordResetLimiter,
  asyncHandler(requireAuth('LECTURER', 'STUDENT')),
  validate({ body: deleteAccountSchema }),
  asyncHandler(authController.deleteAccount),
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

/**
 * Who an invitation link is for (auth.invitation.ts), so the page can greet
 * the invitee before they choose a password. POST so the token stays out of
 * URLs and access logs.
 *
 * 200 - { fullName, email, role, scopeName, expiresAt }
 * 400 - link invalid, expired, already used or withdrawn (one message for all)
 */
authRouter.post(
  '/invitations/lookup',
  passwordResetLimiter,
  validate({ body: invitationLookupSchema }),
  asyncHandler(authController.lookupInvitation),
);

/**
 * Accepts an invitation: the invitee chooses their password and the account
 * becomes ACTIVE. They then sign in at the staff sign-in page.
 *
 * 200 - accepted
 * 400 - link invalid/expired/used, or the password was rejected
 */
authRouter.post(
  '/invitations/accept',
  passwordResetLimiter,
  validate({ body: acceptInvitationSchema }),
  asyncHandler(authController.acceptInvitation),
);

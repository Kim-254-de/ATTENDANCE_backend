import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as loginService from './auth.login.service.js';
import * as sessions from './auth.session.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as authService from './auth.service.js';
import * as passwordService from './auth.password.service.js';
import { findAvatarUrl } from './auth.repository.js';
import type {
  AvatarInput,
  ChangePasswordInput,
  EmailVerificationInput,
  ForgotPasswordInput,
  LecturerRegistrationInput,
  LoginInput,
  ResetPasswordInput,
  UpdateProfileInput,
} from './auth.schema.js';

/**
 * Controllers translate HTTP to service calls and back. No business rules
 * live here — that keeps the registration policy testable without Express.
 */

function contextFrom(req: Request): authService.RegistrationContext {
  return { ...clientFingerprint(req), requestId: req.requestId };
}

/** POST /api/v1/auth/lecturer/register */
export async function registerLecturer(req: Request, res: Response): Promise<void> {
  const input = req.body as LecturerRegistrationInput;
  const result = await authService.registerLecturer(input, contextFrom(req));

  sendCreated(res, {
    id: result.userId,
    fullName: result.fullName,
    email: result.email,
    staffNumber: result.staffNumber,
    status: result.status,
    nextStep: result.nextStep,
    createdAt: result.createdAt.toISOString(),
    message:
      'Your staff number was verified successfully. Check your email to confirm your address.',
  });
}

/** POST /api/v1/auth/verify-email */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { token } = req.body as EmailVerificationInput;
  const result = await authService.verifyEmail(token, contextFrom(req));

  sendSuccess(res, {
    status: result.status,
    nextStep: result.nextStep,
    message:
      result.nextStep === 'AWAIT_APPROVAL'
        ? 'Email confirmed. An administrator will review and approve your account.'
        : 'Email confirmed. You can now sign in.',
  });
}

/** POST /api/v1/auth/login */
export async function login(req: Request, res: Response): Promise<void> {
  const issued = await loginService.loginLecturer(req.body as LoginInput, contextFrom(req));
  sessions.setAuthCookies(res, { access: issued.access, refresh: issued.refresh, sessionExpiresAt: issued.sessionExpiresAt });
  sendSuccess(res, issued.lecturer);
}

/**
 * GET /api/v1/auth/me
 *
 * The avatar is deliberately NOT part of `req.auth.lecturer` (that comes from
 * the session lookup `requireAuth` runs on every authenticated request) — it
 * is fetched here, once, only for the endpoint that actually needs it.
 */
export async function me(req: Request, res: Response): Promise<void> {
  const lecturer = req.auth?.lecturer ?? null;
  if (!lecturer) {
    sendSuccess(res, null);
    return;
  }
  const avatarUrl = await findAvatarUrl(lecturer.id);
  sendSuccess(res, { ...lecturer, avatarUrl });
}

/** PATCH /api/v1/auth/me — title and department only; see updateProfileSchema. */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) throw AppError.unauthenticated('Please sign in.');
  const updated = await authService.updateProfile(userId, req.body as UpdateProfileInput, contextFrom(req));
  sendSuccess(res, updated);
}

/** POST /api/v1/auth/change-password */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  const sessionId = req.auth?.sessionId;
  if (!userId || !sessionId) throw AppError.unauthenticated('Please sign in.');
  const result = await authService.changePassword(userId, sessionId, req.body as ChangePasswordInput, contextFrom(req));
  sendSuccess(res, result);
}

/** POST /api/v1/auth/me/avatar */
export async function setAvatar(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) throw AppError.unauthenticated('Please sign in.');
  const result = await authService.setAvatar(userId, req.body as AvatarInput, contextFrom(req));
  sendSuccess(res, result);
}

/** DELETE /api/v1/auth/me/avatar */
export async function removeAvatar(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) throw AppError.unauthenticated('Please sign in.');
  const result = await authService.removeAvatar(userId, contextFrom(req));
  sendSuccess(res, result);
}

/** POST /api/v1/auth/refresh */
export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const issued = await loginService.refreshSession(sessions.readRefreshToken(req), contextFrom(req));
    sessions.setAuthCookies(res, { access: issued.access, refresh: issued.refresh, sessionExpiresAt: issued.sessionExpiresAt });
    res.status(204).end();
  } catch (error) {
    sessions.clearAuthCookies(res); // a dead session must not leave stale cookies behind
    throw error;
  }
}

/** POST /api/v1/auth/logout */
export async function logout(req: Request, res: Response): Promise<void> {
  await loginService.logout(
    { access: sessions.readAccessToken(req), refresh: sessions.readRefreshToken(req) },
    contextFrom(req),
  );
  sessions.clearAuthCookies(res);
  res.status(204).end();
}

/**
 * POST /api/v1/auth/forgot-password
 *
 * Always 200 with the same body, whether or not the address has an account.
 * Anything else would turn this into an account directory.
 */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const input = req.body as ForgotPasswordInput;
  const result = await passwordService.requestPasswordReset(input, contextFrom(req));
  sendSuccess(res, result);
}

/** POST /api/v1/auth/reset-password */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  const input = req.body as ResetPasswordInput;
  const result = await passwordService.resetPassword(input, contextFrom(req));

  // Every session was revoked, so any cookies this browser still holds are
  // dead. Clearing them avoids a confusing "signed in but unauthorised" state.
  sessions.clearAuthCookies(res);
  sendSuccess(res, result);
}

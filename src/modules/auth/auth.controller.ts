import type { Request, Response } from 'express';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as loginService from './auth.login.service.js';
import * as sessions from './auth.session.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as authService from './auth.service.js';
import type { EmailVerificationInput, LecturerRegistrationInput, LoginInput } from './auth.schema.js';

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

/** GET /api/v1/auth/me */
export function me(req: Request, res: Response): void {
  sendSuccess(res, req.auth?.lecturer ?? null);
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

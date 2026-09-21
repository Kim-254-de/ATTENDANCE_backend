import type { Request, Response } from 'express';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as authService from './auth.service.js';
import type { EmailVerificationInput, LecturerRegistrationInput } from './auth.schema.js';

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

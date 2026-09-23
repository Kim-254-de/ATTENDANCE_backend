import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env, isTest } from '../config/env.js';
import { ErrorCode } from '../common/errors/index.js';
import type { ErrorEnvelope } from '../common/http/index.js';

/**
 * Throttling (README section 4.1). Registration and sign-in get their own,
 * much tighter buckets than general traffic: registration because each attempt
 * costs an outbound ERP call, sign-in to blunt credential stuffing.
 *
 * Each limiter has its own store, so the buckets are already independent —
 * no custom key generator is needed, and the built-in one handles IPv6
 * correctly (a hand-rolled `req.ip` key would let an attacker rotate through
 * a /64 to sidestep the limit).
 */

function buildLimiter(max: number, windowMs: number, message: string) {
  return rateLimit({
    windowMs,
    limit: max,
    // Tests skip limiting so they stay deterministic. (In express-rate-limit v7 a limit of 0
    // does NOT disable the limiter - it rejects every request - hence `skip`.)
    skip: () => isTest,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      const body: ErrorEnvelope = {
        success: false,
        error: { code: ErrorCode.RATE_LIMITED, message },
        requestId: req.requestId,
      };
      res.status(429).json(body);
    },
  });
}

export const globalLimiter = buildLimiter(
  env.RATE_LIMIT_MAX_REQUESTS,
  env.RATE_LIMIT_WINDOW_MS,
  'Too many requests. Please slow down and try again shortly.',
);

export const registrationLimiter = buildLimiter(
  env.REGISTER_RATE_LIMIT_MAX,
  env.RATE_LIMIT_WINDOW_MS,
  'Too many registration attempts from this device. Please try again later.',
);

export const loginLimiter = buildLimiter(
  env.LOGIN_RATE_LIMIT_MAX,
  env.RATE_LIMIT_WINDOW_MS,
  'Too many sign-in attempts. Please wait before trying again.',
);

/**
 * Password reset requests. Tighter than sign-in because each accepted request
 * sends an email: without this, the endpoint is a way to flood a colleague's
 * inbox from any browser.
 */
export const passwordResetLimiter = buildLimiter(
  env.PASSWORD_RESET_RATE_LIMIT_MAX,
  env.RATE_LIMIT_WINDOW_MS,
  'Too many password reset requests. Please wait before trying again.',
);

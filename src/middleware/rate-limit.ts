import rateLimit, { type Options } from 'express-rate-limit';
import type { Request, RequestHandler, Response } from 'express';
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

function buildLimiter(
  max: number,
  windowMs: number,
  message: string,
  options: Pick<Partial<Options>, 'keyGenerator' | 'skip'> = {},
) {
  return rateLimit({
    windowMs,
    limit: max,
    // Tests skip limiting so they stay deterministic. (In express-rate-limit v7 a limit of 0
    // does NOT disable the limiter - it rejects every request - hence `skip`.)
    skip: options.skip ?? (() => isTest),
    ...(options.keyGenerator ? { keyGenerator: options.keyGenerator } : {}),
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

/**
 * The routes a check-in arrives on. Mounted at /api, so paths are relative to it.
 * They have their own limiters (checkInLimiters) and must not also count
 * against the per-IP global bucket, or a class sharing campus Wi-Fi would.
 *
 * card-check-in is here for the same reason, more sharply: every swipe in a
 * hall comes from the one terminal, so the global bucket would stop a class
 * part-way through. It takes the perIp backstop only — perStudent is keyed by
 * the signed-in user, and a terminal is not one, so it would put the whole
 * room on a single student's allowance.
 */
const CHECK_IN_PATHS = new Set([
  '/v1/attendance/check-in',
  '/v1/attendance/card-check-in',
  '/v1/sessions/scan',
]);
/** The face terminal and face enrollment. They have faceLimiter, per lecturer, instead. */
const FACE_PATH = /^\/v1\/(sessions\/[^/]+\/face\/(identify|confirm)|units\/[^/]+\/students\/[^/]+\/face)$/;
export const isCheckInRequest = (req: Request): boolean =>
  req.method === 'POST' && (CHECK_IN_PATHS.has(req.path) || FACE_PATH.test(req.path));

export const globalLimiter = buildLimiter(
  env.RATE_LIMIT_MAX_REQUESTS,
  env.RATE_LIMIT_WINDOW_MS,
  'Too many requests. Please slow down and try again shortly.',
  { skip: (req) => isTest || isCheckInRequest(req) },
);

/**
 * Check-in limits, in the order the route applies them:
 *   perIp      - before sign-in is checked, a high backstop against floods from one address
 *   perStudent - after requireAuth, keyed by the signed-in user, so each student in a
 *                hall gets their own allowance however many share an IP
 *
 * A factory so tests can build enforcing instances; the routes use the shared ones below.
 * Both check-in routes share one pair of stores: /sessions/scan must not give a
 * student a second allowance.
 */
export function createCheckInLimiters(
  options: { perStudent?: number; perIp?: number; windowMs?: number; enforceInTests?: boolean } = {},
): { perIp: RequestHandler; perStudent: RequestHandler } {
  const windowMs = options.windowMs ?? env.CHECKIN_RATE_LIMIT_WINDOW_MS;
  const skip = () => isTest && !options.enforceInTests;
  return {
    perIp: buildLimiter(
      options.perIp ?? env.CHECKIN_RATE_LIMIT_PER_IP,
      windowMs,
      'Too many check-ins from this network right now. Wait a moment and scan again.',
      { skip },
    ),
    perStudent: buildLimiter(
      options.perStudent ?? env.CHECKIN_RATE_LIMIT_PER_STUDENT,
      windowMs,
      'Too many check-in attempts. Wait a few minutes before scanning again.',
      {
        skip,
        // requireAuth runs first, so auth is always set here; the IP fallback
        // only guards against the limiter being mounted in the wrong place.
        keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`),
      },
    ),
  };
}

export const checkInLimiters = createCheckInLimiters();

/**
 * Face terminal and enrollment, per signed-in lecturer (mounted after requireAuth).
 * One phone checks in a whole class, so the per-IP global bucket, sized for one
 * person, would stop it partway through a lecture.
 */
export const faceLimiter = buildLimiter(
  env.FACE_RATE_LIMIT_PER_LECTURER,
  env.CHECKIN_RATE_LIMIT_WINDOW_MS,
  'Too many face check-in requests. Wait a moment and try again.',
  { keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip ?? 'unknown'}`) },
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

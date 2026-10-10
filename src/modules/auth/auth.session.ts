import { randomUUID } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { env, isProduction } from '../../config/env.js';
import { durationToSeconds } from '../../common/utils/duration.js';
import { hashToken } from '../../common/utils/tokens.js';

/**
 * Session tokens.
 *
 *  - ACCESS token: short-lived JWT (JWT_ACCESS_TTL) carrying the session id. Sent as an
 *    httpOnly cookie for the web portal, or as `Authorization: Bearer` for native clients.
 *  - REFRESH token: longer-lived JWT bound to the session. Only its SHA-256 hash is stored,
 *    and it is rotated on every use, so a replayed (stolen) token is detectable.
 *
 * Both live in httpOnly cookies, so page scripts (and any XSS) can never read them.
 */

export const ACCESS_COOKIE = 'sa_access';
export const REFRESH_COOKIE = 'sa_refresh';
/** The refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

const accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const refreshKey = new TextEncoder().encode(env.JWT_REFRESH_SECRET);
const ALG = 'HS256';

export const accessTtlSeconds = durationToSeconds(env.JWT_ACCESS_TTL);
export const refreshTtlSeconds = durationToSeconds(env.JWT_REFRESH_TTL);

export interface AccessClaims {
  userId: string;
  sessionId: string;
  role: string;
}

export const newSessionId = (): string => randomUUID();

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId, role: claims.role })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience('access')
    .setIssuedAt()
    .setExpirationTime(`${accessTtlSeconds}s`)
    .sign(accessKey);
}

/** Returns null for anything wrong — bad signature, wrong type, expired, malformed. */
export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, accessKey, {
      issuer: env.JWT_ISSUER,
      audience: 'access',
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { userId: payload.sub, sessionId: payload.sid, role: typeof payload.role === 'string' ? payload.role : '' };
  } catch {
    return null;
  }
}

/** `expiresAt` is the session's absolute end, so refreshing never extends a session's life. */
export async function signRefreshToken(userId: string, sessionId: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience('refresh')
    .setJti(randomUUID()) // makes every rotation produce a different token
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(refreshKey);
}

export async function verifyRefreshToken(token: string): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, refreshKey, {
      issuer: env.JWT_ISSUER,
      audience: 'refresh',
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

export const hashRefreshToken = hashToken;

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function baseCookie(): CookieOptions {
  return {
    httpOnly: true,
    // lax: the cookie is not sent on cross-site POSTs, which is what blocks CSRF here.
    sameSite: 'lax',
    secure: isProduction,
  };
}

export function setAuthCookies(res: Response, tokens: { access: string; refresh: string; sessionExpiresAt: Date }): void {
  res.cookie(ACCESS_COOKIE, tokens.access, { ...baseCookie(), path: '/', maxAge: accessTtlSeconds * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...baseCookie(),
    path: REFRESH_COOKIE_PATH,
    expires: tokens.sessionExpiresAt,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), path: REFRESH_COOKIE_PATH });
}

/** Access token from the httpOnly cookie (web) or a Bearer header (native/mobile clients). */
export function readAccessToken(req: Request): string | null {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const fromCookie = cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

export function readRefreshToken(req: Request): string | null {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_COOKIE] ?? null;
}

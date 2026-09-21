import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../common/errors/index.js';
import type { UserRole } from '../db/types.js';
import { readAccessToken, verifyAccessToken } from '../modules/auth/auth.session.js';
import { findSession, type LecturerPublic } from '../modules/auth/auth.session.repository.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
  lecturer: LecturerPublic | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Requires a signed-in user. The token alone is not trusted: the session is looked up on every
 * request, so signing out, suspending an account or a detected token theft takes effect at once
 * instead of when the 15-minute access token happens to expire.
 */
export function requireAuth(...roles: UserRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readAccessToken(req);
      const claims = token ? await verifyAccessToken(token) : null;
      if (!claims) throw AppError.unauthenticated('Please sign in.');

      const session = await findSession(claims.sessionId);
      if (!session || session.userId !== claims.userId || session.revokedAt || session.expiresAt <= new Date()) {
        throw AppError.unauthenticated('Your session has ended. Please sign in again.');
      }
      if (session.status !== 'ACTIVE') throw AppError.forbidden('This account is not active.');
      if (roles.length > 0 && !roles.includes(session.role)) throw AppError.forbidden();

      req.auth = { userId: session.userId, sessionId: session.sessionId, role: session.role, lecturer: session.lecturer };
      next();
    } catch (error) {
      next(error);
    }
  };
}

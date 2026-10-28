import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Attaches a correlation id to every request so a single registration attempt
 * can be traced across the API log, the ERP call and the audit trail.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const HEADER = 'x-request-id';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  // Only trust an inbound id if it looks like one; otherwise it is attacker
  // controlled text heading straight into the logs.
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();

  req.requestId = requestId;
  res.setHeader(HEADER, requestId);
  next();
}

/** Client IP and user agent, recorded on audit entries. */
export function clientFingerprint(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 512) ?? null,
  };
}

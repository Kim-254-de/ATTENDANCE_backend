import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as sessionService from './session.service.js';
import { renderPng, renderSvg } from './qr.render.js';
import type {
  CreateSessionInput,
  QrQuery,
  SessionIdParam,
  VerifyScanInput,
} from './session.schema.js';

/** HTTP in, HTTP out. Attendance rules live in the service. */

function contextFrom(req: Request): sessionService.RequestContext {
  return { ...clientFingerprint(req), requestId: req.requestId };
}

/** The authenticated user id, guaranteed present by requireAuth. */
function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** POST /api/v1/sessions */
export async function createSession(req: Request, res: Response): Promise<void> {
  const input = req.body as CreateSessionInput;
  const session = await sessionService.createSession(input, userId(req), contextFrom(req));
  sendCreated(res, session);
}

/** GET /api/v1/sessions/:sessionId/qr — the code to display right now. */
export async function getCurrentQr(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const current = await sessionService.getCurrentQr(sessionId, userId(req));

  // The token changes every rotation period, so any cached copy is wrong
  // almost immediately.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  sendSuccess(res, current);
}

/** GET /api/v1/sessions/:sessionId/qr.png|svg — the rendered image. */
export async function getQrImage(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const { format, size } = req.query as unknown as QrQuery;

  const { payload, expiresInSeconds } = await sessionService.getCurrentPayload(
    sessionId,
    userId(req),
  );

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // Lets a lecturer's browser refresh exactly on the rotation boundary.
  res.setHeader('X-QR-Expires-In', String(expiresInSeconds));

  if (format === 'svg') {
    res.type('image/svg+xml').send(await renderSvg(payload, size));
    return;
  }
  res.type('image/png').send(await renderPng(payload, size));
}

/** POST /api/v1/sessions/scan — a student submits a scanned code. */
export async function verifyScan(req: Request, res: Response): Promise<void> {
  const { payload } = req.body as VerifyScanInput;
  const verdict = await sessionService.verifyScan(payload, userId(req), contextFrom(req));
  sendSuccess(res, verdict);
}

/** PATCH /api/v1/sessions/:sessionId/status */
export async function setStatus(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const { status } = req.body as { status: 'OPEN' | 'PAUSED' | 'CLOSED' };
  const session = await sessionService.setSessionStatus(
    sessionId,
    userId(req),
    status,
    contextFrom(req),
  );
  sendSuccess(res, session);
}

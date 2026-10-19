import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import type { Terminal } from './terminal.repository.js';
import * as enrolmentService from './enrolment.service.js';
import type {
  CommandIdParam,
  CompleteCommandInput,
  CoverageQuery,
  CreateTerminalInput,
  FailCommandInput,
  FingerprintIdParam,
  RequestEnrolmentInput,
  HeartbeatInput,
  LinkInput,
  PairInput,
  SessionIdParam,
  TerminalCheckInInput,
  TerminalIdParam,
  UpdateTerminalInput,
} from './terminal.schema.js';
import * as terminalService from './terminal.service.js';

/** HTTP in, HTTP out. */

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

function device(req: Request): Terminal {
  if (!req.terminal) throw AppError.unauthenticated('This terminal is not paired.');
  return req.terminal;
}

const context = (req: Request) => ({ ...clientFingerprint(req), requestId: req.requestId });

// --- Department officers ----------------------------------------------------

/** GET /api/v1/departments/terminals */
export async function list(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await terminalService.listTerminals(userId(req)));
}

/** POST /api/v1/departments/terminals */
export async function create(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  sendCreated(res, await terminalService.createTerminal(userId(req), req.body as CreateTerminalInput, context(req)));
}

/** POST /api/v1/departments/terminals/:terminalId/pairing */
export async function reissuePairing(req: Request, res: Response): Promise<void> {
  const { terminalId } = req.params as unknown as TerminalIdParam;
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await terminalService.reissuePairing(userId(req), terminalId, context(req)));
}

/** PATCH /api/v1/departments/terminals/:terminalId */
export async function update(req: Request, res: Response): Promise<void> {
  const { terminalId } = req.params as unknown as TerminalIdParam;
  sendSuccess(res, await terminalService.updateTerminal(userId(req), terminalId, req.body as UpdateTerminalInput, context(req)));
}

/** POST /api/v1/departments/terminals/:terminalId/lost */
export async function markLost(req: Request, res: Response): Promise<void> {
  const { terminalId } = req.params as unknown as TerminalIdParam;
  sendSuccess(res, await terminalService.decommission(userId(req), terminalId, 'LOST', context(req)));
}

/** POST /api/v1/departments/terminals/:terminalId/retire */
export async function retire(req: Request, res: Response): Promise<void> {
  const { terminalId } = req.params as unknown as TerminalIdParam;
  sendSuccess(res, await terminalService.decommission(userId(req), terminalId, 'RETIRED', context(req)));
}

// --- Lecturers --------------------------------------------------------------

/** GET /api/v1/sessions/:sessionId/terminal-link */
export async function linkCode(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  sendSuccess(res, await terminalService.getLinkCode(sessionId, userId(req)));
}

// --- Devices ----------------------------------------------------------------

/** POST /api/v1/terminals/pair */
export async function pair(req: Request, res: Response): Promise<void> {
  const { pairingCode } = req.body as PairInput;
  res.setHeader('Cache-Control', 'no-store');
  sendSuccess(res, await terminalService.pair(pairingCode, context(req)));
}

/** POST /api/v1/terminals/heartbeat */
export async function heartbeat(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await terminalService.heartbeat(device(req), req.body as HeartbeatInput, context(req)));
}

/** POST /api/v1/terminals/link */
export async function link(req: Request, res: Response): Promise<void> {
  const { linkCode } = req.body as LinkInput;
  sendSuccess(res, await terminalService.link(device(req), linkCode, context(req)));
}

/** POST /api/v1/terminals/unlink */
export async function unlink(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await terminalService.unlink(device(req), context(req)));
}

/** POST /api/v1/terminals/check-in */
export async function checkIn(req: Request, res: Response): Promise<void> {
  sendCreated(res, await terminalService.checkIn(device(req), req.body as TerminalCheckInInput, context(req)));
}

// --- Fingerprint enrolment (enrolment.service.ts) ----------------------------

/** GET /api/v1/departments/enrolment/students */
export async function coverage(req: Request, res: Response): Promise<void> {
  const { q, limit } = req.query as unknown as CoverageQuery;
  sendSuccess(res, await enrolmentService.listCoverage(userId(req), q, limit));
}

/** POST /api/v1/departments/terminals/:terminalId/enrolments */
export async function requestEnrolment(req: Request, res: Response): Promise<void> {
  const { terminalId } = req.params as unknown as TerminalIdParam;
  sendCreated(res, await enrolmentService.requestEnrolment(userId(req), terminalId, req.body as RequestEnrolmentInput, context(req)));
}

/** POST /api/v1/departments/enrolment/commands/:commandId/cancel */
export async function cancelCommand(req: Request, res: Response): Promise<void> {
  const { commandId } = req.params as unknown as CommandIdParam;
  await enrolmentService.cancelCommand(userId(req), commandId, context(req));
  sendSuccess(res, { cancelled: true });
}

/** DELETE /api/v1/departments/enrolment/fingerprints/:fingerprintId */
export async function revokeFingerprint(req: Request, res: Response): Promise<void> {
  const { fingerprintId } = req.params as unknown as FingerprintIdParam;
  await enrolmentService.revokeFingerprint(userId(req), fingerprintId, context(req));
  sendSuccess(res, { revoked: true });
}

/** GET /api/v1/terminals/commands */
export async function commands(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await enrolmentService.listCommands(device(req)));
}

/** POST /api/v1/terminals/commands/:commandId/complete */
export async function completeCommand(req: Request, res: Response): Promise<void> {
  const { commandId } = req.params as unknown as CommandIdParam;
  const { fingerRef } = req.body as CompleteCommandInput;
  sendSuccess(res, await enrolmentService.completeCommand(device(req), commandId, fingerRef, context(req)));
}

/** POST /api/v1/terminals/commands/:commandId/fail */
export async function failCommand(req: Request, res: Response): Promise<void> {
  const { commandId } = req.params as unknown as CommandIdParam;
  const { reason } = req.body as FailCommandInput;
  await enrolmentService.failCommand(device(req), commandId, reason, context(req));
  sendSuccess(res, { failed: true });
}

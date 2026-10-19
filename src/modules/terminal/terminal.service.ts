import { randomBytes } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { generateToken, hashToken } from '../../common/utils/tokens.js';
import { env } from '../../config/env.js';
import { isUniqueViolation } from '../../db/database.js';
import type { VerificationMethod } from '../../db/types.js';
import { attendanceService } from '../attendance/index.js';
import { auditService } from '../audit/index.js';
import { departmentService } from '../department/index.js';
import { findSessionById, type SessionForQr } from '../session/index.js';
import { checkLinkCode, issueLinkCode, parseLinkCode } from './terminal.link.js';
import * as enrolmentRepository from './enrolment.repository.js';
import * as terminalRepository from './terminal.repository.js';
import type { Terminal, TerminalCapability, TerminalNetwork } from './terminal.repository.js';
import type { CreateTerminalInput, TerminalCheckInInput, UpdateTerminalInput } from './terminal.schema.js';

/**
 * Portable check-in terminals (docs/hardware-specs.md section 6.2).
 *
 * Three callers, three kinds of authority:
 *  - a department officer registers, pairs and decommissions their own
 *    department's devices;
 *  - a lecturer shows a link code for their own class;
 *  - a device, holding its own key, pairs, reports in, links to a class and
 *    records check-ins for it.
 *
 * The rule tying them together: a terminal records only for a class taught by
 * a lecturer in the department that owns it.
 */

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

const PAIRING_TTL_MINUTES = 30;
/** Crockford base32: no I, L, O or U, so a code read aloud or typed is hard to get wrong. */
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function newPairingCode(): { code: string; display: string; hash: string; expiresAt: Date } {
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (b) => PAIRING_ALPHABET[b % 32]).join('');
  return {
    code,
    display: `${code.slice(0, 5)}-${code.slice(5)}`,
    hash: hashToken(code),
    expiresAt: new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000),
  };
}

/** Which session method each kind of reader records under. Barcode and NFC are both the ID card. */
const METHOD_FOR: Record<TerminalCapability, VerificationMethod> = {
  BARCODE: 'CARD',
  CARD: 'CARD',
  FINGERPRINT: 'FINGERPRINT',
};

// --- What callers see -------------------------------------------------------

export interface TerminalDto {
  id: string;
  code: string;
  label: string | null;
  capabilities: TerminalCapability[];
  status: Terminal['status'];
  pairingExpiresAt: string | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  batteryPercent: number | null;
  network: TerminalNetwork | null;
  appVersion: string | null;
  linkedSession: { sessionId: string; unitCode: string | null; linkedAt: string | null } | null;
  createdAt: string;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

function toDto(t: Terminal): TerminalDto {
  return {
    id: t.id,
    code: t.code,
    label: t.label,
    capabilities: t.capabilities,
    status: t.status,
    pairingExpiresAt: iso(t.pairingExpiresAt),
    pairedAt: iso(t.pairedAt),
    lastSeenAt: iso(t.lastSeenAt),
    batteryPercent: t.batteryPercent,
    network: t.network,
    appVersion: t.appVersion,
    linkedSession: t.linkedSessionId
      ? { sessionId: t.linkedSessionId, unitCode: t.linkedUnitCode, linkedAt: iso(t.linkedAt) }
      : null,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Handed to the officer once, to show as a QR code (and as text) for the device to pair with. */
export interface PairingDto {
  terminal: TerminalDto;
  pairingCode: string;
  expiresAt: string;
}

// --- Department officers ----------------------------------------------------

async function departmentOf(userId: string): Promise<string> {
  return (await departmentService.getMyDepartment(userId)).departmentId;
}

async function ownTerminal(terminalId: string, departmentId: string): Promise<Terminal> {
  const terminal = await terminalRepository.findInDepartment(terminalId, departmentId);
  if (!terminal) throw AppError.notFound('Terminal not found.');
  return terminal;
}

/** GET /departments/terminals */
export async function listTerminals(officerUserId: string): Promise<TerminalDto[]> {
  return (await terminalRepository.listForDepartment(await departmentOf(officerUserId))).map(toDto);
}

/** POST /departments/terminals */
export async function createTerminal(officerUserId: string, input: CreateTerminalInput, context: RequestContext): Promise<PairingDto> {
  const departmentId = await departmentOf(officerUserId);
  const pairing = newPairingCode();
  let id: string;
  try {
    id = await terminalRepository.create({
      code: input.code,
      departmentId,
      label: input.label || null,
      capabilities: input.capabilities,
      pairingCodeHash: pairing.hash,
      pairingExpiresAt: pairing.expiresAt,
      createdByUserId: officerUserId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(`A terminal called ${input.code} already exists. Pick another name.`);
    throw error;
  }
  await auditService.record({
    action: 'TERMINAL_CREATED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    ...context,
    metadata: { terminalId: id, code: input.code, departmentId, capabilities: input.capabilities },
  });
  const terminal = await ownTerminal(id, departmentId);
  return { terminal: toDto(terminal), pairingCode: pairing.display, expiresAt: pairing.expiresAt.toISOString() };
}

/**
 * POST /departments/terminals/:terminalId/pairing
 *
 * For pairing a new device under the same name, or when the first code ran
 * out. The old key stops working the moment this is issued.
 */
export async function reissuePairing(officerUserId: string, terminalId: string, context: RequestContext): Promise<PairingDto> {
  const departmentId = await departmentOf(officerUserId);
  const terminal = await ownTerminal(terminalId, departmentId);
  if (terminal.status === 'RETIRED') throw AppError.conflict('This terminal is retired. Add a new one instead.');

  const pairing = newPairingCode();
  await terminalRepository.issuePairing(terminal.id, pairing.hash, pairing.expiresAt);
  await auditService.record({
    action: 'TERMINAL_PAIRING_ISSUED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    ...context,
    metadata: { terminalId: terminal.id, code: terminal.code, previousStatus: terminal.status },
  });
  return {
    terminal: toDto(await ownTerminal(terminal.id, departmentId)),
    pairingCode: pairing.display,
    expiresAt: pairing.expiresAt.toISOString(),
  };
}

/** PATCH /departments/terminals/:terminalId */
export async function updateTerminal(
  officerUserId: string,
  terminalId: string,
  input: UpdateTerminalInput,
  context: RequestContext,
): Promise<TerminalDto> {
  const departmentId = await departmentOf(officerUserId);
  const terminal = await ownTerminal(terminalId, departmentId);
  await terminalRepository.update(terminal.id, {
    ...(input.label !== undefined ? { label: input.label || null } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  await auditService.record({
    action: 'TERMINAL_UPDATED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    ...context,
    metadata: { terminalId: terminal.id, code: terminal.code, ...input },
  });
  return toDto(await ownTerminal(terminal.id, departmentId));
}

/**
 * POST /departments/terminals/:terminalId/lost | /retire
 *
 * Takes effect on the device's next request: its key no longer matches
 * anything. A lost device that turns up again is re-paired.
 */
export async function decommission(
  officerUserId: string,
  terminalId: string,
  status: 'LOST' | 'RETIRED',
  context: RequestContext,
): Promise<TerminalDto> {
  const departmentId = await departmentOf(officerUserId);
  const terminal = await ownTerminal(terminalId, departmentId);
  if (terminal.status === 'RETIRED') throw AppError.conflict('This terminal is already retired.');
  await terminalRepository.decommission(terminal.id, status);
  await auditService.record({
    action: 'TERMINAL_STATUS_CHANGED',
    outcome: 'SUCCESS',
    userId: officerUserId,
    ...context,
    metadata: { terminalId: terminal.id, code: terminal.code, from: terminal.status, to: status },
  });
  return toDto(await ownTerminal(terminal.id, departmentId));
}

// --- Lecturers --------------------------------------------------------------

/**
 * GET /sessions/:sessionId/terminal-link
 *
 * The code the lecturer's screen shows for terminals to scan. Only the
 * session's own lecturer gets one, and only while the class can still record.
 */
export async function getLinkCode(sessionId: string, lecturerUserId: string): Promise<{ linkCode: string; expiresAt: string }> {
  const session = await findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) throw AppError.forbidden('This session belongs to another lecturer.');
  assertNotOver(session);
  const { code, expiresAt } = issueLinkCode(session.id, session.secret);
  return { linkCode: code, expiresAt: expiresAt.toISOString() };
}

function assertNotOver(session: SessionForQr): void {
  if (session.status === 'CLOSED' || session.closesAt < new Date()) {
    throw new AppError(409, ErrorCode.CONFLICT, 'This class session has ended.');
  }
}

// --- Devices ----------------------------------------------------------------

/** What a device is told about itself and the class it is linked to. */
export interface DeviceStateDto {
  terminal: { code: string; label: string | null; capabilities: TerminalCapability[] };
  session: {
    sessionId: string;
    unitCode: string;
    unitName: string | null;
    status: SessionForQr['status'];
    opensAt: string;
    closesAt: string;
    /** The device's readers this class accepts right now. */
    accepts: TerminalCapability[];
  } | null;
}

function accepted(terminal: Terminal, session: SessionForQr): TerminalCapability[] {
  return terminal.capabilities.filter((c) => session.verificationMethods.includes(METHOD_FOR[c]));
}

/**
 * The linked session, if it is still running. A class that has closed or run
 * out of time lets go of the terminal here, so nothing else has to.
 */
async function currentSession(terminal: Terminal): Promise<SessionForQr | null> {
  if (!terminal.linkedSessionId) return null;
  const session = await findSessionById(terminal.linkedSessionId);
  if (!session || session.status === 'CLOSED' || session.closesAt < new Date()) {
    await terminalRepository.setLinkedSession(terminal.id, null);
    return null;
  }
  return session;
}

function deviceState(terminal: Terminal, session: SessionForQr | null): DeviceStateDto {
  return {
    terminal: { code: terminal.code, label: terminal.label, capabilities: terminal.capabilities },
    session: session
      ? {
          sessionId: session.id,
          unitCode: session.unitCode,
          unitName: session.unitName,
          status: session.status,
          opensAt: session.opensAt.toISOString(),
          closesAt: session.closesAt.toISOString(),
          accepts: accepted(terminal, session),
        }
      : null,
  };
}

/** POST /terminals/pair - unauthenticated; the pairing code is the credential. */
export async function pair(pairingCode: string, context: RequestContext): Promise<{ key: string } & DeviceStateDto> {
  const key = generateToken(32);
  const terminal = await terminalRepository.completePairing(hashToken(pairingCode), key.tokenHash);
  if (!terminal) {
    throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'This pairing code is not valid or has expired. Ask your department for a new one.');
  }
  await auditService.record({
    action: 'TERMINAL_PAIRED',
    outcome: 'SUCCESS',
    ...context,
    metadata: { terminalId: terminal.id, code: terminal.code },
  });
  // The only time the key is ever sent. The device keeps it; the server keeps its hash.
  return { key: key.token, ...deviceState(terminal, null) };
}

/** POST /terminals/heartbeat */
export async function heartbeat(
  terminal: Terminal,
  report: { batteryPercent?: number; network?: TerminalNetwork; appVersion?: string },
  context: RequestContext,
): Promise<DeviceStateDto & { pendingCommands: number }> {
  await terminalRepository.recordHeartbeat(terminal.id, { ipAddress: context.ipAddress, ...report });
  // Tells the device to fetch GET /terminals/commands when the department has queued work.
  return { ...deviceState(terminal, await currentSession(terminal)), pendingCommands: await enrolmentRepository.countPending(terminal.id) };
}

/** POST /terminals/link - the device scanned the code on the lecturer's screen. */
export async function link(terminal: Terminal, linkCode: string, context: RequestContext): Promise<DeviceStateDto> {
  const notALinkCode = () =>
    new AppError(400, ErrorCode.VALIDATION_FAILED, "That is not a class link code. Scan the code on the lecturer's screen.");

  const parsed = parseLinkCode(linkCode);
  if (!parsed) throw notALinkCode();
  const session = await findSessionById(parsed.sessionId);
  if (!session) throw notALinkCode();
  const check = checkLinkCode(parsed, session.secret);
  if (check === 'INVALID') throw notALinkCode();
  if (check === 'EXPIRED') throw new AppError(410, ErrorCode.VALIDATION_FAILED, 'This code has expired. Ask the lecturer to show it again.');
  assertNotOver(session);

  const refuse = async (reason: string, error: AppError): Promise<never> => {
    await auditService.record({
      action: 'TERMINAL_LINK_REFUSED',
      outcome: 'FAILURE',
      reason,
      ...context,
      metadata: { terminalId: terminal.id, code: terminal.code, sessionId: session.id, unitCode: session.unitCode },
    });
    throw error;
  };

  const lecturerDepartment = await terminalRepository.lecturerDepartmentId(session.lecturerUserId);
  if (lecturerDepartment !== terminal.departmentId) {
    return refuse(
      'class taught outside the terminal’s department',
      AppError.forbidden("This terminal belongs to another department and can't record for this class."),
    );
  }
  if (accepted(terminal, session).length === 0) {
    return refuse(
      'class accepts none of the terminal’s readers',
      new AppError(409, ErrorCode.CONFLICT, 'This class is not taking ID card or fingerprint check-ins.'),
    );
  }

  await terminalRepository.setLinkedSession(terminal.id, session.id);
  await auditService.record({
    action: 'TERMINAL_LINKED',
    outcome: 'SUCCESS',
    ...context,
    metadata: { terminalId: terminal.id, code: terminal.code, sessionId: session.id, unitCode: session.unitCode },
  });
  return deviceState(terminal, session);
}

/** POST /terminals/unlink */
export async function unlink(terminal: Terminal, context: RequestContext): Promise<DeviceStateDto> {
  if (terminal.linkedSessionId) {
    await terminalRepository.setLinkedSession(terminal.id, null);
    await auditService.record({
      action: 'TERMINAL_UNLINKED',
      outcome: 'SUCCESS',
      ...context,
      metadata: { terminalId: terminal.id, code: terminal.code, sessionId: terminal.linkedSessionId },
    });
  }
  return deviceState(terminal, null);
}

/**
 * POST /terminals/check-in
 *
 * One read, recorded against the class the terminal is linked to. Who the
 * student is and whether they count is the attendance module's existing
 * card, barcode and fingerprint paths, unchanged; this only adds which class
 * and which readers this device may use.
 */
export async function checkIn(terminal: Terminal, input: TerminalCheckInInput, context: RequestContext) {
  const session = await currentSession(terminal);
  if (!session) {
    throw new AppError(409, ErrorCode.CONFLICT, "This terminal is not linked to a class. Scan the code on the lecturer's screen.");
  }

  const reader: TerminalCapability = input.barcode !== undefined ? 'BARCODE' : input.cardUid !== undefined ? 'CARD' : 'FINGERPRINT';
  if (!terminal.capabilities.includes(reader)) {
    throw AppError.forbidden(`This terminal is not set up to read ${reader === 'FINGERPRINT' ? 'fingerprints' : 'ID cards'}.`);
  }

  if (input.barcode !== undefined) return attendanceService.checkInByBarcode(session.id, input.barcode, context);
  if (input.cardUid !== undefined) {
    if (!env.CARD_UID_SECRET) throw new AppError(409, ErrorCode.CONFLICT, 'NFC cards are not set up on this server.');
    return attendanceService.checkInByCard(session.id, input.cardUid, context);
  }
  if (!env.FINGERPRINT_REF_SECRET) throw new AppError(409, ErrorCode.CONFLICT, 'Fingerprints are not set up on this server.');
  // Slots are numbered per reader, and this reader's enrolments are filed under its code.
  return attendanceService.checkInByFingerprint(session.id, terminal.code, input.fingerRef!, context);
}

/** For the authentication middleware: the device presenting this key, or null. */
export async function authenticate(key: string): Promise<Terminal | null> {
  return terminalRepository.findByKeyHash(hashToken(key));
}

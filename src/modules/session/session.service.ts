import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { auditService } from '../audit/index.js';
import * as sessionRepository from './session.repository.js';
import type { SessionForQr } from './session.repository.js';
import {
  VERIFICATION_MESSAGES,
  generateSessionSecret,
  issueToken,
  verifyToken,
  type QrToken,
  type QrVerificationFailure,
} from './session.token.js';
import type { CreateSessionInput } from './session.schema.js';

/**
 * Attendance session and rotating QR policy.
 *
 * The QR code shown to a hall is derived, not stored: see session.token.ts.
 * This layer decides *when* a code may be issued or accepted — which is where
 * the real attendance rules live.
 */

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface SessionSummary {
  id: string;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  title: string | null;
  status: SessionForQr['status'];
  opensAt: string;
  closesAt: string;
  rotationSeconds: number;
}

const toSummary = (session: SessionForQr): SessionSummary => ({
  id: session.id,
  unitId: session.unitId,
  unitCode: session.unitCode,
  unitName: session.unitName,
  title: session.title,
  status: session.status,
  opensAt: session.opensAt.toISOString(),
  closesAt: session.closesAt.toISOString(),
  rotationSeconds: session.rotationSeconds,
});

/**
 * Opens a session for a unit the lecturer actually teaches.
 *
 * The secret minted here is the anchor for every code this session will ever
 * show. It is per-session rather than per-unit on purpose: both resist replay,
 * but a leaked per-unit secret would mint valid codes for COSC 100 forever,
 * whereas this one dies with the class meeting.
 */
export async function createSession(
  input: CreateSessionInput,
  lecturerUserId: string,
  context: RequestContext,
): Promise<SessionSummary> {
  const owns = await sessionRepository.lecturerOwnsUnit(input.unitId, lecturerUserId);
  if (!owns) {
    throw AppError.forbidden('You are not assigned to teach this unit.');
  }

  const session = await sessionRepository.createSession({
    unitId: input.unitId,
    lecturerUserId,
    secret: generateSessionSecret(),
    title: input.title ?? null,
    opensAt: input.opensAt ?? new Date(),
    closesAt: input.closesAt,
    rotationSeconds: input.rotationSeconds ?? env.QR_ROTATION_SECONDS,
  });

  await auditService.record({
    action: 'ATTENDANCE_SESSION_OPENED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId: session.id, unitCode: session.unitCode },
  });

  logger.info({ sessionId: session.id, unitCode: session.unitCode }, 'attendance session opened');
  return toSummary(session);
}

export interface CurrentQr {
  session: SessionSummary;
  payload: string;
  /** Seconds until the code changes — what the lecturer's screen counts down. */
  expiresInSeconds: number;
  rotatesAt: string;
  /** Students recorded present so far. */
  checkedIn: number;
  /** Students ACTIVE on the unit, i.e. who could check in. */
  enrolled: number;
}

/**
 * The code to display right now. The lecturer's screen re-requests this every
 * `expiresInSeconds`; nothing is written, so polling is cheap.
 */
export async function getCurrentQr(sessionId: string, lecturerUserId: string): Promise<CurrentQr> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');

  // Ownership is checked BEFORE the session's state, so a lecturer probing
  // another lecturer's session cannot learn whether it is open, paused or
  // closed. Only the owner may see the code at all: anyone who can fetch it
  // can forward it, which is the attack rotation exists to limit.
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }

  assertSessionAcceptingScans(session);

  const token = issueTokenFor(session);
  const { checkedIn, enrolled } = await sessionRepository.countAttendance(session.id, session.unitId);
  return {
    session: toSummary(session),
    payload: token.payload,
    expiresInSeconds: token.expiresInSeconds,
    rotatesAt: token.rotatesAt.toISOString(),
    checkedIn,
    enrolled,
  };
}

/**
 * The session, for its own lecturer only — whatever its state. Used by the
 * attendance module to guard the attendee list.
 */
export async function getOwnedSession(sessionId: string, lecturerUserId: string): Promise<SessionSummary> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }
  return toSummary(session);
}

/** Raw payload for the image endpoints, without the JSON envelope. */
export async function getCurrentPayload(
  sessionId: string,
  lecturerUserId: string,
): Promise<{ payload: string; expiresInSeconds: number }> {
  const { payload, expiresInSeconds } = await getCurrentQr(sessionId, lecturerUserId);
  return { payload, expiresInSeconds };
}

function issueTokenFor(session: SessionForQr, at: Date = new Date()): QrToken {
  return issueToken(session.id, session.secret, at, session.rotationSeconds);
}

export interface ScanVerdict {
  sessionId: string;
  unitId: string;
  unitCode: string;
  /** True when the student may now be recorded present. */
  eligible: boolean;
  /** Seconds between the code being minted and the scan arriving. */
  ageSeconds: number;
}

/**
 * Validates a scanned code on behalf of a student.
 *
 * Deliberately does NOT write an attendance record — persisting that belongs
 * to the attendance module. This returns the verdict it acts on.
 *
 * Order matters. The signature is checked before the allocation lookup so a
 * forged code never causes a database read, and every rejection returns the
 * same shape so the endpoint cannot be used to enumerate sessions.
 */
export async function verifyScan(
  payload: string,
  studentUserId: string,
  context: RequestContext,
): Promise<ScanVerdict> {
  // The session id inside the payload is untrusted until the signature over it
  // verifies, so it is only used to look up the candidate session.
  const claimedSessionId = payload.trim().split('.')[1];
  if (!claimedSessionId) {
    throw scanRejected('MALFORMED');
  }

  const session = await sessionRepository.findSessionById(claimedSessionId);
  if (!session) {
    // Same message as a bad signature: a scanner should not learn which
    // session ids exist.
    throw scanRejected('BAD_SIGNATURE');
  }

  const result = verifyToken(payload, { sessionId: session.id, secret: session.secret }, new Date(), {
    rotationSeconds: session.rotationSeconds,
  });

  if (!result.valid) {
    await recordFailure(session, studentUserId, result.reason, context);
    throw scanRejected(result.reason);
  }

  assertSessionAcceptingScans(session);

  const allocated = await sessionRepository.studentAllocatedToUnit(session.unitId, studentUserId);
  if (!allocated) {
    // This is what makes a forwarded screenshot near-useless: the friend is
    // not on the unit, so a structurally valid code still gets them nowhere.
    await recordFailure(session, studentUserId, 'NOT_ALLOCATED', context);
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      `You are not registered for ${session.unitCode}. Contact your department if this is wrong.`,
    );
  }

  if (await sessionRepository.hasAlreadyCheckedIn(session.id, studentUserId)) {
    throw AppError.conflict(
      'Your attendance for this class has already been recorded.',
      ErrorCode.CONFLICT,
    );
  }

  await auditService.record({
    action: 'ATTENDANCE_SCAN_ACCEPTED',
    outcome: 'SUCCESS',
    userId: studentUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId: session.id, unitCode: session.unitCode, ageSeconds: result.ageSeconds },
  });

  return {
    sessionId: session.id,
    unitId: session.unitId,
    unitCode: session.unitCode,
    eligible: true,
    ageSeconds: result.ageSeconds,
  };
}

/** Pauses, resumes or closes a session. Closing invalidates every future code. */
export async function setSessionStatus(
  sessionId: string,
  lecturerUserId: string,
  status: 'OPEN' | 'PAUSED' | 'CLOSED',
  context: RequestContext,
): Promise<SessionSummary> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }
  // Reopening a closed session would revive codes students already saw.
  if (session.status === 'CLOSED' && status !== 'CLOSED') {
    throw AppError.conflict('A closed session cannot be reopened. Create a new session instead.');
  }

  await sessionRepository.updateSessionStatus(sessionId, lecturerUserId, status);

  await auditService.record({
    action: status === 'CLOSED' ? 'ATTENDANCE_SESSION_CLOSED' : 'ATTENDANCE_SESSION_STATUS_CHANGED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId, status },
  });

  return toSummary({ ...session, status });
}

/**
 * A session must be OPEN *and* inside its time window. The window is checked
 * independently of status so a session nobody remembered to close still stops
 * accepting scans on its own.
 */
function assertSessionAcceptingScans(session: SessionForQr): void {
  const now = new Date();

  if (session.status === 'CLOSED') {
    throw new AppError(409, ErrorCode.CONFLICT, 'This class session has been closed.');
  }
  if (session.status === 'PAUSED') {
    throw new AppError(409, ErrorCode.CONFLICT, 'This class session is paused.');
  }
  if (now < session.opensAt) {
    throw new AppError(409, ErrorCode.CONFLICT, 'This class session has not started yet.');
  }
  if (now > session.closesAt) {
    throw new AppError(409, ErrorCode.CONFLICT, 'This class session has ended.');
  }
}

function scanRejected(reason: QrVerificationFailure): AppError {
  // 410 Gone for a code that was real but is past its window, so the client can
  // tell "scan the new code" apart from "this is not an attendance code".
  const expired = reason === 'EXPIRED' || reason === 'NOT_YET_VALID';
  return new AppError(expired ? 410 : 400, ErrorCode.VALIDATION_FAILED, VERIFICATION_MESSAGES[reason]);
}

/**
 * Failed scans are audited, not just rejected. A burst of EXPIRED codes from
 * one student is the signature of a screenshot doing the rounds, and that is
 * only visible if the misses are recorded.
 */
async function recordFailure(
  session: SessionForQr,
  studentUserId: string,
  reason: string,
  context: RequestContext,
): Promise<void> {
  await auditService.record({
    action: 'ATTENDANCE_SCAN_REJECTED',
    outcome: 'FAILURE',
    userId: studentUserId,
    reason,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId: session.id, unitCode: session.unitCode },
  });
}

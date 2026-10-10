import { AppError, ErrorCode } from '../../common/errors/index.js';
import { hashCardUid } from '../../common/utils/card-uid.js';
import { env } from '../../config/env.js';
import { isUniqueViolation } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { sessionService, type SessionForQr, type StudentLocationInput } from '../session/index.js';
import * as attendanceRepository from './attendance.repository.js';
import * as cardRepository from './card.repository.js';
import * as fingerprintRepository from './fingerprint.repository.js';

/**
 * Check-in: turns a verified scan into an attendance record.
 *
 * Every rule about whether a scan counts — signature, rotation window, session
 * state, allocation, one check-in per session — lives in
 * sessionService.verifyScan. This module only persists the verdict, so there is
 * one place those rules can be wrong.
 */

export type RequestContext = sessionService.RequestContext;

export interface CheckInResult {
  recordId: string;
  sessionId: string;
  unitCode: string;
  recordedAt: string;
  /** How far from the room's centre the check-in was; null when the session's geofence was off. */
  distanceMetres: number | null;
}

const ALREADY_RECORDED = 'Your attendance for this class has already been recorded.';

export async function checkIn(
  payload: string,
  studentUserId: string,
  context: RequestContext,
  location?: StudentLocationInput,
): Promise<CheckInResult> {
  const verdict = await sessionService.verifyScan(payload, studentUserId, context, location);
  const fence = verdict.geofence;

  let record: { id: string; recordedAt: Date };
  try {
    record = await attendanceRepository.insertRecord({
      sessionId: verdict.sessionId,
      unitId: verdict.unitId,
      studentUserId,
      qrAgeSeconds: verdict.ageSeconds,
      verificationMethod: 'QR',
      // The distance and accuracy only; the student's coordinates are never stored.
      geofenceResult: fence.result,
      distanceMetres: fence.result === 'INSIDE' ? fence.distanceMetres : null,
      locationAccuracyMetres: fence.result === 'INSIDE' ? fence.accuracyMetres : null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  } catch (error) {
    // Two scans raced past verifyScan's advisory check; the constraint caught the second.
    if (isUniqueViolation(error)) throw AppError.conflict(ALREADY_RECORDED, ErrorCode.CONFLICT);
    throw error;
  }

  await auditService.record({
    action: 'ATTENDANCE_RECORDED',
    outcome: 'SUCCESS',
    userId: studentUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId: verdict.sessionId, unitCode: verdict.unitCode, recordId: record.id },
  });

  return {
    recordId: record.id,
    sessionId: verdict.sessionId,
    unitCode: verdict.unitCode,
    recordedAt: record.recordedAt.toISOString(),
    distanceMetres: fence.result === 'INSIDE' ? fence.distanceMetres : null,
  };
}

export interface CardCheckInResult {
  recordId: string;
  sessionId: string;
  unitCode: string;
  recordedAt: string;
  /** Shown on the terminal so the student can see who was recorded. */
  student: { fullName: string; registrationNumber: string | null };
}

/** Said for an unknown, revoked, or not-yet-enrolled card. The three are indistinguishable on purpose. */
const CARD_NOT_RECOGNISED = 'This card is not recognised. See your department to have it registered.';

/**
 * Check-in by student ID card, presented at a terminal in the room.
 *
 * The terminal is authenticated by a shared key, not as a student, so this is
 * the one path where the subject of a check-in is not the caller. Two things
 * follow, and both matter:
 *
 *  - The card is the only evidence of identity, so a UID that resolves to
 *    nobody is refused outright rather than guessed at.
 *  - Everything else — the class is open and inside its window, the method was
 *    enabled, the student is ACTIVE on the roster, one check-in each — is
 *    decided by sessionService.verifyCardSwipe, the same place the QR rules
 *    live, so the two paths cannot drift apart.
 */
export async function checkInByCard(
  sessionId: string,
  cardUid: string,
  context: RequestContext,
): Promise<CardCheckInResult> {
  if (!env.CARD_UID_SECRET) {
    // env.ts refuses this combination at boot; this is the type-level guard.
    throw new Error('CARD_UID_SECRET is not set, so no card can be matched.');
  }

  const holder = await cardRepository.findCardHolder(hashCardUid(cardUid, env.CARD_UID_SECRET));
  if (!holder) {
    // Audited without a user id: nobody is known to have presented it, and a
    // run of these from one terminal is how a cloned or faulty card shows up.
    await auditService.record({
      action: 'ATTENDANCE_CARD_REJECTED',
      outcome: 'FAILURE',
      reason: 'card not enrolled or revoked',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { sessionId },
    });
    throw AppError.notFound(CARD_NOT_RECOGNISED);
  }

  const verdict = await sessionService.verifyTerminalCheckIn(
    sessionId,
    holder.studentUserId,
    'CARD',
    context,
  );

  let record: { id: string; recordedAt: Date };
  try {
    record = await attendanceRepository.insertRecord({
      sessionId: verdict.sessionId,
      unitId: verdict.unitId,
      studentUserId: holder.studentUserId,
      // No rotating code was involved, and no reading to fence against: the
      // student was at the terminal, which is in the room.
      qrAgeSeconds: null,
      verificationMethod: 'CARD',
      geofenceResult: 'NOT_CHECKED',
      distanceMetres: null,
      locationAccuracyMetres: null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  } catch (error) {
    // Two swipes raced past verifyCardSwipe's advisory check.
    if (isUniqueViolation(error)) throw AppError.conflict(ALREADY_RECORDED, ErrorCode.CONFLICT);
    throw error;
  }

  await auditService.record({
    action: 'ATTENDANCE_RECORDED',
    outcome: 'SUCCESS',
    userId: holder.studentUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      sessionId: verdict.sessionId,
      unitCode: verdict.unitCode,
      recordId: record.id,
      method: 'CARD',
      cardId: holder.cardId,
    },
  });

  return {
    recordId: record.id,
    sessionId: verdict.sessionId,
    unitCode: verdict.unitCode,
    recordedAt: record.recordedAt.toISOString(),
    student: { fullName: holder.fullName, registrationNumber: holder.registrationNumber },
  };
}

/** Said for a finger the reader matched to a slot this service does not know. */
const FINGER_NOT_RECOGNISED =
  'This fingerprint is not registered on this terminal. See your department to enrol it.';

/**
 * Check-in by fingerprint, presented at a terminal in the room.
 *
 * The reader has already done the biometric work: it holds the templates, it
 * ran the 1:N match, and it reports which of its own enrolment slots matched.
 * This service never sees a fingerprint. So the only question left here is
 * whose slot that is, and the answer is scoped to the terminal — slot 37 on
 * one reader and slot 37 on another are different people.
 *
 * Everything after that is the shared terminal path: the class is open and
 * inside its window, the method was enabled, the student is ACTIVE on the
 * roster, one check-in each. Decided by sessionService.verifyTerminalCheckIn,
 * the same function the card swipe uses, so the two cannot drift apart.
 */
export async function checkInByFingerprint(
  sessionId: string,
  terminalId: string,
  fingerRef: string,
  context: RequestContext,
): Promise<CardCheckInResult> {
  if (!env.FINGERPRINT_REF_SECRET) {
    // env.ts refuses this combination at boot; this is the type-level guard.
    throw new Error('FINGERPRINT_REF_SECRET is not set, so no enrolment can be matched.');
  }

  const holder = await fingerprintRepository.findFingerprintHolder(
    terminalId,
    hashCardUid(fingerRef, env.FINGERPRINT_REF_SECRET),
  );
  if (!holder) {
    // No user id: nobody is known to have presented it. A run of these from one
    // terminal is how a reader whose templates were wiped shows up.
    await auditService.record({
      action: 'ATTENDANCE_FINGERPRINT_REJECTED',
      outcome: 'FAILURE',
      reason: 'enrolment not found or revoked',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { sessionId, terminalId },
    });
    throw AppError.notFound(FINGER_NOT_RECOGNISED);
  }

  const verdict = await sessionService.verifyTerminalCheckIn(
    sessionId,
    holder.studentUserId,
    'FINGERPRINT',
    context,
  );

  let record: { id: string; recordedAt: Date };
  try {
    record = await attendanceRepository.insertRecord({
      sessionId: verdict.sessionId,
      unitId: verdict.unitId,
      studentUserId: holder.studentUserId,
      // No rotating code, and no reading to fence against: the student was at
      // the terminal, which is in the room.
      qrAgeSeconds: null,
      verificationMethod: 'FINGERPRINT',
      geofenceResult: 'NOT_CHECKED',
      distanceMetres: null,
      locationAccuracyMetres: null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
  } catch (error) {
    // Two presentations raced past verifyTerminalCheckIn's advisory check.
    if (isUniqueViolation(error)) throw AppError.conflict(ALREADY_RECORDED, ErrorCode.CONFLICT);
    throw error;
  }

  await auditService.record({
    action: 'ATTENDANCE_RECORDED',
    outcome: 'SUCCESS',
    userId: holder.studentUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      sessionId: verdict.sessionId,
      unitCode: verdict.unitCode,
      recordId: record.id,
      method: 'FINGERPRINT',
      terminalId,
      enrolmentId: holder.enrolmentId,
    },
  });

  return {
    recordId: record.id,
    sessionId: verdict.sessionId,
    unitCode: verdict.unitCode,
    recordedAt: record.recordedAt.toISOString(),
    student: { fullName: holder.fullName, registrationNumber: holder.registrationNumber },
  };
}

export interface FaceCheckInResult {
  recordId: string;
  sessionId: string;
  unitCode: string;
  studentUserId: string;
  recordedAt: string;
}

/**
 * Records a student the lecturer confirmed on the face terminal. Whether the
 * match counts is decided in src/modules/verification, like verifyScan for
 * QR; this only persists it. The same one-record-per-session constraint
 * applies, so a student who already scanned the QR code gets the same 409.
 */
export async function recordFaceCheckIn(args: {
  session: SessionForQr;
  studentUserId: string;
  score: number;
  lecturerUserId: string;
  context: RequestContext;
}): Promise<FaceCheckInResult> {
  const { session, studentUserId, context } = args;
  let record: { id: string; recordedAt: Date };
  try {
    record = await attendanceRepository.insertRecord({
      sessionId: session.id,
      unitId: session.unitId,
      studentUserId,
      qrAgeSeconds: null,
      // The terminal is in the lecturer's hand, in the room: there is no student reading to check.
      geofenceResult: 'NOT_CHECKED',
      distanceMetres: null,
      locationAccuracyMetres: null,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      verificationMethod: 'FACE',
      faceScore: args.score,
      confirmedByUserId: args.lecturerUserId,
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict(ALREADY_RECORDED, ErrorCode.CONFLICT);
    throw error;
  }

  await auditService.record({
    action: 'ATTENDANCE_RECORDED',
    outcome: 'SUCCESS',
    userId: studentUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      sessionId: session.id,
      unitCode: session.unitCode,
      recordId: record.id,
      method: 'FACE',
      faceScore: args.score,
      confirmedBy: args.lecturerUserId,
    },
  });

  return {
    recordId: record.id,
    sessionId: session.id,
    unitCode: session.unitCode,
    studentUserId,
    recordedAt: record.recordedAt.toISOString(),
  };
}

export interface SessionAttendance {
  sessionId: string;
  checkedIn: number;
  attendees: Array<{
    id: string;
    studentUserId: string;
    fullName: string;
    registrationNumber: string | null;
    recordedAt: string;
    /** Null when the session's geofence was off at check-in. */
    distanceMetres: number | null;
    geofenceResult: 'INSIDE' | 'NOT_CHECKED';
    /** What proved they were present: a scanned code, a face the lecturer confirmed, a swiped card. */
    verificationMethod: 'QR' | 'FINGERPRINT' | 'FACE' | 'CARD';
  }>;
}

/** Who has checked in to a session. Only the session's own lecturer may see it. */
export async function listSessionAttendance(
  sessionId: string,
  lecturerUserId: string,
): Promise<SessionAttendance> {
  await sessionService.getOwnedSession(sessionId, lecturerUserId);
  const rows = await attendanceRepository.listRecords(sessionId);
  return {
    sessionId,
    checkedIn: rows.length,
    attendees: rows.map((r) => ({ ...r, recordedAt: r.recordedAt.toISOString() })),
  };
}

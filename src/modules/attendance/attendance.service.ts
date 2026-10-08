import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { sessionService, type SessionForQr, type StudentLocationInput } from '../session/index.js';
import * as attendanceRepository from './attendance.repository.js';

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
      method: 'FACE',
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
    /** Scanned the QR code, or recognised on the lecturer's terminal. */
    method: 'QR' | 'FACE';
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

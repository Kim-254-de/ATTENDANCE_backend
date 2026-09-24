import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { sessionService } from '../session/index.js';
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
}

const ALREADY_RECORDED = 'Your attendance for this class has already been recorded.';

export async function checkIn(
  payload: string,
  studentUserId: string,
  context: RequestContext,
): Promise<CheckInResult> {
  const verdict = await sessionService.verifyScan(payload, studentUserId, context);

  let record: { id: string; recordedAt: Date };
  try {
    record = await attendanceRepository.insertRecord({
      sessionId: verdict.sessionId,
      unitId: verdict.unitId,
      studentUserId,
      qrAgeSeconds: verdict.ageSeconds,
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

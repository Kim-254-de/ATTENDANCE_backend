import { AppError, ErrorCode } from '../../common/errors/index.js';
import { atCampusTime } from '../../common/utils/campus-time.js';
import { env } from '../../config/env.js';
import { transaction } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import { findRoom } from '../session/session.repository.js';
import {
  type AnchorReading,
  type StudentReading,
  checkReading,
  chooseCentre,
  rejectionMessage,
} from '../session/session.geofence.js';
import { generateSessionSecret, issueToken, verifyToken, VERIFICATION_MESSAGES } from '../session/session.token.js';
import * as repo from './exam.repository.js';
import type { ExamSessionRow, IncomingExamSession } from './exam.repository.js';

/**
 * Exam sessions: one per paper per room, pushed by SMARTTT with who sits
 * there and its invigilator (main or extra). The invigilator opens their own
 * room in its time slot; it then shows a rotating code and is fenced like a
 * class (the session module's token and geofence). A student checks in only
 * to the room SMARTTT seated them in; anywhere else is refused with their
 * room. The report is a sat/absent list per room; the main invigilator sees
 * every room of the paper, as they collect the scripts.
 *
 * While SMARTTT says the term is in exam mode, teaching classes can't be
 * opened (session.service.createSession).
 */

/** An invigilator may open the room this long before the paper starts. */
export const OPEN_EARLY_MINUTES = 30;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExamPushSession {
  key: string;
  paper_key: string;
  unit_codes: string[];
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string;
  candidates: unknown[];
  registration_numbers: string[];
  invigilator_staff_number: string;
  role: 'main' | 'extra';
  main_invigilator_staff_number?: string | null;
}

/** "2026-11-23" + "08:30" on campus, as an instant. */
export function campusInstant(date: string, hhmm: string): Date {
  // Noon UTC is the same calendar day on any campus within ±12 h.
  return atCampusTime(new Date(`${date}T12:00:00Z`), hhmm, env.CAMPUS_TIMEZONE);
}

/** SMARTTT's latest exam version for a term: replaces the term's exam sessions. */
export async function receiveExamSessions(termId: string, version: number, sessions: ExamPushSession[]) {
  const incoming: IncomingExamSession[] = sessions.map((s) => ({
    key: s.key,
    termId,
    version,
    paperKey: s.paper_key,
    unitCodes: s.unit_codes,
    title: s.title,
    startsAt: campusInstant(s.date, s.start_time),
    endsAt: campusInstant(s.date, s.end_time),
    roomCode: s.room,
    candidates: s.candidates,
    registrationNumbers: [...new Set(s.registration_numbers.map((r) => r.trim().toUpperCase()))],
    invigilatorStaffNumber: s.invigilator_staff_number.trim().toUpperCase(),
    role: s.role,
    mainInvigilatorStaffNumber: s.main_invigilator_staff_number?.trim().toUpperCase() || null,
  }));
  return transaction((client) => repo.replaceTermSessions(client, termId, incoming));
}

export async function receiveTermMode(
  termId: string,
  mode: 'teaching' | 'exams',
  switchedAt: Date | null,
  closedAt: Date | null,
): Promise<{ termId: string; mode: string }> {
  await repo.setTermMode(termId, mode, switchedAt, closedAt);
  return { termId, mode };
}

/** Refuses opening a teaching class while the term is in exam mode. */
export async function assertTeachingAllowed(): Promise<void> {
  if (await repo.anyTermInExamMode()) {
    throw new AppError(
      403,
      ErrorCode.EXAM_MODE,
      'Exams are on: teaching classes can’t be opened until the exam period closes. Invigilators open their exam rooms under Exams.',
    );
  }
}

function summary(s: ExamSessionRow, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    paperKey: s.paperKey,
    codes: s.unitCodes.join('/'),
    title: s.title,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    room: s.roomCode,
    role: s.role,
    candidates: s.registrationNumbers.length,
    status: s.status ?? 'NOT_OPENED',
    geofence: s.geofenceMode,
    ...extra,
  };
}

async function staffNumber(userId: string): Promise<string> {
  const staff = await repo.staffNumberOf(userId);
  if (!staff) throw AppError.forbidden('Only lecturers with a staff number invigilate exams.');
  return staff.toUpperCase();
}

async function ownSession(sessionId: string, userId: string): Promise<ExamSessionRow> {
  const session = UUID_PATTERN.test(sessionId) ? await repo.findById(sessionId) : null;
  if (!session || session.withdrawnAt) throw AppError.notFound('No such exam session.');
  if (session.invigilatorStaffNumber !== (await staffNumber(userId))) {
    throw AppError.forbidden('Only this room’s invigilator can open it.');
  }
  return session;
}

/** The invigilator's exam rooms from today on. */
export async function myExamSessions(userId: string, now = new Date()) {
  const staff = await staffNumber(userId);
  const sessions = await repo.findForInvigilator(staff, new Date(now.getTime() - 24 * 3600 * 1000));
  return sessions.map((s) => summary(s));
}

/** The invigilator opens their own room in its slot (from OPEN_EARLY_MINUTES before the start to the end). */
export async function openExamSession(
  sessionId: string,
  userId: string,
  options: { geofence: 'ON' | 'OFF'; location?: AnchorReading },
  now = new Date(),
) {
  const session = await ownSession(sessionId, userId);
  if (session.status === 'OPEN') return summary(session);
  if (session.status === 'CLOSED') throw AppError.conflict('This exam session has been closed.');
  const earliest = new Date(session.startsAt.getTime() - OPEN_EARLY_MINUTES * 60_000);
  if (now < earliest || now > session.endsAt) {
    throw AppError.forbidden(
      `You can open this room from ${OPEN_EARLY_MINUTES} minutes before the paper until it ends.`,
    );
  }
  let fence: { mode: 'ROOM' | 'LECTURER_DEVICE' | 'OFF'; latitude: number | null; longitude: number | null } = {
    mode: 'OFF',
    latitude: null,
    longitude: null,
  };
  if (options.geofence === 'ON') {
    const choice = chooseCentre(await findRoom(session.roomCode), options.location);
    if (!choice.ok) {
      throw new AppError(
        422,
        ErrorCode.GEOFENCE_ANCHOR_UNAVAILABLE,
        'This room isn’t surveyed and your location isn’t precise enough: open it from your phone, or with the fence off.',
      );
    }
    fence = { mode: choice.mode, latitude: choice.latitude, longitude: choice.longitude };
  }
  const opened = await repo.open(session.id, {
    userId,
    secret: generateSessionSecret(),
    openedAt: now,
    closesAt: session.endsAt,
    rotationSeconds: env.QR_ROTATION_SECONDS,
    geofenceMode: fence.mode,
    latitude: fence.latitude,
    longitude: fence.longitude,
    radiusMetres: fence.mode === 'OFF' ? null : env.GEOFENCE_RADIUS_METRES,
  });
  const result = opened ?? (await repo.findById(session.id))!;
  await auditService.record({
    action: 'EXAM_SESSION_OPENED',
    outcome: 'SUCCESS',
    userId,
    metadata: { examSessionId: session.id, paperKey: session.paperKey, room: session.roomCode, geofence: fence.mode },
  });
  return summary(result);
}

/** The code to show in the room right now. */
export async function currentExamCode(sessionId: string, userId: string, now = new Date()) {
  const session = await ownSession(sessionId, userId);
  if (session.status !== 'OPEN' || !session.secret || !session.closesAt || now > session.closesAt) {
    throw AppError.conflict('Open this exam room first.');
  }
  const token = issueToken(session.id, session.secret, now, session.rotationSeconds ?? env.QR_ROTATION_SECONDS);
  return {
    session: summary(session),
    payload: token.payload,
    expiresInSeconds: token.expiresInSeconds,
    rotatesAt: token.rotatesAt.toISOString(),
  };
}

export async function closeExamSession(sessionId: string, userId: string) {
  const session = await ownSession(sessionId, userId);
  await repo.close(session.id);
  return summary({ ...session, status: 'CLOSED' });
}

/** A student checks in with the room's code: only to the room SMARTTT seated them in. */
export async function checkIn(payload: string, studentUserId: string, location: StudentReading | undefined, now = new Date()) {
  const claimed = payload.trim().split('.')[1];
  const session = claimed && UUID_PATTERN.test(claimed) ? await repo.findById(claimed) : null;
  if (!session || !session.secret) throw new AppError(400, ErrorCode.VALIDATION_FAILED, VERIFICATION_MESSAGES.BAD_SIGNATURE);
  const verdict = verifyToken(payload, { sessionId: session.id, secret: session.secret }, now, {
    rotationSeconds: session.rotationSeconds ?? env.QR_ROTATION_SECONDS,
  });
  if (!verdict.valid) throw new AppError(400, ErrorCode.VALIDATION_FAILED, VERIFICATION_MESSAGES[verdict.reason]);
  if (session.status !== 'OPEN' || session.withdrawnAt || !session.closesAt || now > session.closesAt) {
    throw AppError.conflict('This exam room isn’t taking check-ins.');
  }
  if (session.geofenceMode && session.geofenceMode !== 'OFF' && session.latitude !== null && session.longitude !== null) {
    const check = checkReading(
      { latitude: session.latitude, longitude: session.longitude, radiusMetres: session.radiusMetres ?? env.GEOFENCE_RADIUS_METRES },
      location,
      now,
    );
    if (!check.accepted) {
      throw new AppError(403, ErrorCode[check.reason], rejectionMessage(check, session.roomCode));
    }
  }
  const reg = (await repo.registrationNumberOf(studentUserId))?.toUpperCase();
  if (!reg) throw AppError.forbidden('Only students sit exams.');
  if (!session.registrationNumbers.includes(reg)) {
    const rooms = await repo.findPaperSessions(session.termId, session.paperKey);
    const mine = rooms.find((r) => r.registrationNumbers.includes(reg));
    if (mine) {
      throw new AppError(403, ErrorCode.EXAM_WRONG_ROOM, `You sit ${session.unitCodes.join('/')} in ${mine.roomCode}, not here.`, {
        details: { room: mine.roomCode },
      });
    }
    throw new AppError(403, ErrorCode.EXAM_NOT_CANDIDATE, `You aren’t listed for ${session.unitCodes.join('/')}.`);
  }
  if (!(await repo.recordCheckIn(session.id, studentUserId, reg))) {
    throw AppError.conflict('You have already checked in to this exam.');
  }
  return { examSessionId: session.id, codes: session.unitCodes.join('/'), room: session.roomCode, checkedIn: true };
}

/**
 * Sat and absent per room. The room's invigilator sees their room; the
 * paper's main invigilator sees every room of the paper (they collect the scripts).
 */
export async function report(sessionId: string, userId: string) {
  const session = UUID_PATTERN.test(sessionId) ? await repo.findById(sessionId) : null;
  if (!session) throw AppError.notFound('No such exam session.');
  const staff = await staffNumber(userId);
  const isMain = session.mainInvigilatorStaffNumber === staff;
  if (session.invigilatorStaffNumber !== staff && !isMain) {
    throw AppError.forbidden('Only the paper’s invigilators see its attendance.');
  }
  const rooms = isMain ? await repo.findPaperSessions(session.termId, session.paperKey) : [session];
  const sat = await repo.checkedIn(rooms.map((r) => r.id));
  return {
    paperKey: session.paperKey,
    codes: session.unitCodes.join('/'),
    title: session.title,
    rooms: rooms.map((r) => {
      const present = sat.get(r.id) ?? new Set<string>();
      return {
        room: r.roomCode,
        role: r.role,
        sat: r.registrationNumbers.filter((n) => present.has(n)),
        absent: r.registrationNumbers.filter((n) => !present.has(n)),
      };
    }),
  };
}

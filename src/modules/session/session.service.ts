import { AppError, ErrorCode } from '../../common/errors/index.js';
import { atCampusTime, campusClock } from '../../common/utils/campus-time.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import type { VerificationMethod } from '../../db/types.js';
import { auditService } from '../audit/index.js';
import { findUnitSlots, type UnitSlot } from '../unit/index.js';
import * as sessionRepository from './session.repository.js';
import type { SessionForQr, SessionGeofence, UnitRoom } from './session.repository.js';
import {
  centreRefusalMessage,
  checkReading,
  chooseCentre,
  rejectionMessage,
  roundDistanceForDisplay,
  type AnchorReading,
  type CentreChoice,
  type GeofenceRejection,
  type ReadingCheck,
  type StudentReading,
} from './session.geofence.js';
import {
  VERIFICATION_MESSAGES,
  generateSessionSecret,
  issueToken,
  verifyToken,
  type QrToken,
  type QrVerificationFailure,
} from './session.token.js';
import type { CreateSessionInput, UpdateGeofenceInput } from './session.schema.js';

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
  geofence: GeofenceStatus;
  /** The methods this class accepts, as the lecturer ticked them. Never empty. */
  verificationMethods: VerificationMethod[];
}

/**
 * What the lecturer's screen shows about the fence. The centre's coordinates
 * are left out: the screen has no use for them, and a lecturer-device centre
 * is where the lecturer was standing.
 */
export interface GeofenceStatus {
  mode: SessionGeofence['mode'];
  /** Null while OFF with no centre ever set. */
  radiusMetres: number | null;
  /** The room the unit's slot is in, per SMARTTT. Null when unknown. */
  roomCode: string | null;
  /** How precise the centre is: the room survey, or the lecturer's device reading. */
  anchorAccuracyMetres: number | null;
  /** Whether switching it back ON can reuse the stored centre without a new reading. */
  hasCentre: boolean;
}

const toGeofenceStatus = (session: SessionForQr): GeofenceStatus => ({
  mode: session.geofence.mode,
  radiusMetres: session.geofence.radiusMetres,
  roomCode: session.roomCode,
  anchorAccuracyMetres: session.geofence.anchorAccuracyMetres,
  hasCentre: session.geofence.latitude !== null && session.geofence.longitude !== null,
});

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
  geofence: toGeofenceStatus(session),
  verificationMethods: session.verificationMethods,
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
  const unit = await sessionRepository.findLecturerUnit(input.unitId, lecturerUserId);
  if (!unit) {
    throw AppError.forbidden('You are not assigned to teach this unit.');
  }
  if (!unit.verified) {
    throw AppError.forbidden(
      'This unit is awaiting admin verification against the timetable. It cannot be used to activate a class yet.',
    );
  }

  const opensAt = input.opensAt ?? new Date();
  const { closesAt, roomCode, scheduledStartAt } = await resolveWindow(input.unitId, opensAt, input.closesAt);
  const room = await sessionRepository.findRoom(roomCode);
  const geofence = resolveInitialGeofence(input.geofence, room, input.location);

  const session = await sessionRepository.createSession({
    unitId: input.unitId,
    lecturerUserId,
    secret: generateSessionSecret(),
    title: input.title ?? null,
    opensAt,
    closesAt,
    rotationSeconds: input.rotationSeconds ?? env.QR_ROTATION_SECONDS,
    roomCode,
    scheduledStartAt,
    geofence,
    verificationMethods: input.verificationMethods,
  });

  await auditService.record({
    action: 'ATTENDANCE_SESSION_OPENED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      sessionId: session.id,
      unitCode: session.unitCode,
      geofence: { mode: geofence.mode, roomCode: session.roomCode, anchorAccuracyMetres: geofence.anchorAccuracyMetres },
    },
  });

  logger.info(
    { sessionId: session.id, unitCode: session.unitCode, geofence: geofence.mode },
    'attendance session opened',
  );
  return toSummary(session);
}

/**
 * The fence a new session starts with. See chooseCentre for which point wins.
 *
 * ON with no reading at all (activated from a laptop, which has no GPS) in an
 * unsurveyed room opens AWAITING_LOCATION: the laptop shows the class, and
 * the lecturer sends the room's position from their phone, signed in to the
 * same account (setSessionGeofence). Scans are held until then, so this is
 * never a quietly unfenced class.
 *
 * ON with a reading that is too vague still refuses the activation: the
 * lecturer sent a location and should know it was not good enough.
 *
 * OFF still records a centre when one is available, so switching the fence
 * on partway through the class needs no fresh reading.
 */
function resolveInitialGeofence(
  requested: 'ON' | 'OFF',
  room: UnitRoom | null,
  lecturerReading: AnchorReading | undefined,
): SessionGeofence {
  const choice = chooseCentre(room, lecturerReading);

  if (requested === 'OFF') {
    return choice.ok
      ? { ...fenceAt(choice), mode: 'OFF' }
      : { mode: 'OFF', latitude: null, longitude: null, radiusMetres: null, anchorAccuracyMetres: null };
  }

  if (!choice.ok) {
    if (choice.reason === 'NO_READING') {
      return { mode: 'AWAITING_LOCATION', latitude: null, longitude: null, radiusMetres: null, anchorAccuracyMetres: null };
    }
    throw anchorUnavailable(choice);
  }
  return fenceAt(choice);
}

function fenceAt(choice: Extract<CentreChoice, { ok: true }>, radiusMetres = env.GEOFENCE_RADIUS_METRES): SessionGeofence {
  return {
    mode: choice.mode,
    latitude: choice.latitude,
    longitude: choice.longitude,
    radiusMetres,
    anchorAccuracyMetres: choice.anchorAccuracyMetres,
  };
}

/** 422: the request is well-formed, but there is nothing precise enough to fence the class around. */
function anchorUnavailable(choice: Extract<CentreChoice, { ok: false }>): AppError {
  return new AppError(422, ErrorCode.GEOFENCE_ANCHOR_UNAVAILABLE, centreRefusalMessage(choice), {
    details: {
      reason: choice.reason,
      accuracyMetres: choice.accuracyMetres ?? null,
      maxAccuracyMetres: env.GEOFENCE_MAX_ANCHOR_ACCURACY_METRES,
    },
  });
}

/**
 * A class may only be activated during one of its weekly meetings on the
 * timetable — the server-side enforcement of "the activate button is only
 * active within the time allocated on the timetable" (the frontend's own
 * gating is just a convenience; this is what actually stops it).
 *
 * Any of the unit's meetings counts (unit_slots): most units meet more than
 * once a week, and a class rescheduled for one programme sharing it but not
 * another sits at two times. The session closes at the end of the meeting it
 * was activated in, rather than at a time trusted from the client, and is
 * fenced to that meeting's room.
 *
 * Slot times are campus time (CAMPUS_TIMEZONE); the server's clock is usually UTC.
 *
 * A unit with no slots at all (legacy data, before schedules existed) falls
 * back to the client-supplied `closesAt` — there is no window to derive one from.
 *
 * `scheduledStartAt` is the matched meeting's own start, kept so a department
 * can see how late a class actually began (`opensAt - scheduledStartAt`). It is
 * null on the fallback path on purpose: with no schedule there is nothing to be
 * late against, and a zero there would read as "started exactly on time".
 */
export async function resolveWindow(
  unitId: string,
  opensAt: Date,
  clientClosesAt: Date | undefined,
): Promise<{ closesAt: Date; roomCode: string | null; scheduledStartAt: Date | null }> {
  const slots = await findUnitSlots(unitId);
  if (slots.length === 0) {
    if (!clientClosesAt) {
      throw AppError.badRequest('This unit has no issued schedule; closesAt is required.');
    }
    return { closesAt: clientClosesAt, roomCode: null, scheduledStartAt: null };
  }

  const { dayOfWeek } = campusClock(opensAt, env.CAMPUS_TIMEZONE);
  const today = slots.filter((slot) => slot.dayOfWeek === dayOfWeek);
  const now = today.find((slot) => {
    const start = atCampusTime(opensAt, slot.startTime, env.CAMPUS_TIMEZONE);
    const end = atCampusTime(opensAt, slot.endTime, env.CAMPUS_TIMEZONE);
    return opensAt >= start && opensAt <= end;
  });
  if (now) {
    return {
      closesAt: atCampusTime(opensAt, now.endTime, env.CAMPUS_TIMEZONE),
      roomCode: now.roomCode,
      scheduledStartAt: atCampusTime(opensAt, now.startTime, env.CAMPUS_TIMEZONE),
    };
  }

  if (today.length === 0) {
    throw AppError.forbidden(`This class is not scheduled for today (${describeSlots(slots)}).`);
  }
  throw AppError.forbidden(`You can only activate this class during its scheduled time (${describeSlots(today)}).`);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon 08:00–10:00, Thu 14:00–16:00", for telling a lecturer when they can activate. */
function describeSlots(slots: UnitSlot[]): string {
  return slots.map((slot) => `${DAY_NAMES[slot.dayOfWeek]} ${slot.startTime}–${slot.endTime}`).join(', ');
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
  /** Students refused for being outside the fence who have not since checked in. */
  refusedOutsideFence: number;
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
  const { checkedIn, enrolled, refusedOutsideFence } = await sessionRepository.countAttendance(
    session.id,
    session.unitId,
  );
  return {
    session: toSummary(session),
    payload: token.payload,
    expiresInSeconds: token.expiresInSeconds,
    rotatesAt: token.rotatesAt.toISOString(),
    checkedIn,
    enrolled,
    refusedOutsideFence,
  };
}

/**
 * The lecturer's classes still open for check-in, newest first. A phone
 * signed in to the same account uses this to find the class a laptop opened,
 * and send its location if the class is AWAITING_LOCATION.
 */
export async function listLiveSessions(lecturerUserId: string): Promise<SessionSummary[]> {
  return (await sessionRepository.findLiveSessionsForLecturer(lecturerUserId)).map(toSummary);
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

/**
 * The session, for its own lecturer, only while it is taking check-ins by
 * `method`. For the terminal methods that run on the lecturer's own device
 * (face check-in, src/modules/verification), which sign their match tokens
 * with the session's secret, so this returns the full row. Never send it to a client.
 */
export async function getLiveOwnedSession(
  sessionId: string,
  lecturerUserId: string,
  method: VerificationMethod,
): Promise<SessionForQr> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }
  assertSessionAcceptingScans(session);
  assertMethodEnabled(session, method);
  return session;
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
  /** What the location check found; attendance.service.ts stores it on the record. */
  geofence: ScanGeofence;
}

/** Never the student's coordinates: only how far they were, which is all attendance needs. */
export type ScanGeofence =
  | { result: 'INSIDE'; distanceMetres: number; accuracyMetres: number }
  | { result: 'NOT_CHECKED' };

/** Session ids are UUIDs; the column is one, so anything else must never reach a query. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Said to whoever presented the wrong kind of proof for this class. */
const METHOD_REFUSED: Record<VerificationMethod, string> = {
  QR: 'This class is not taking QR code check-ins.',
  CARD: 'This class is not taking ID card check-ins.',
  FINGERPRINT: 'This class is not taking fingerprint check-ins.',
  FACE: 'This class is not taking face check-ins.',
};

/**
 * A class accepts only the methods its lecturer ticked when activating it.
 *
 * Checked on every path, including QR: a lecturer who runs a card-only class
 * has said that a code on screen is not how attendance is taken, and a stale
 * code from an earlier class must not slip through on that basis.
 */
function assertMethodEnabled(session: SessionForQr, method: VerificationMethod): void {
  if (session.verificationMethods.includes(method)) return;
  throw new AppError(409, ErrorCode.CONFLICT, METHOD_REFUSED[method]);
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
 *
 * The location check comes after the code and session-time checks (a student
 * holding a dead code should be told to rescan, not to move) and before the
 * class-list check, so a friend at home with a forwarded code is refused for
 * where they are, and the lecturer's refused-outside counter sees them.
 */
export async function verifyScan(
  payload: string,
  studentUserId: string,
  context: RequestContext,
  location?: StudentReading,
): Promise<ScanVerdict> {
  // The session id inside the payload is untrusted until the signature over it
  // verifies, so it is only used to look up the candidate session. Its SHAPE is
  // checked before it is used at all: a student pointing the camera at a poster
  // or a Wi-Fi code submits something whose second part is not a UUID, and that
  // would reach Postgres as a malformed uuid and come back a 500 instead of
  // "this is not an attendance code".
  const claimedSessionId = payload.trim().split('.')[1];
  if (!claimedSessionId || !UUID_PATTERN.test(claimedSessionId)) {
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
  assertMethodEnabled(session, 'QR');

  const geofence = checkGeofence(session, location);
  if (!geofence.accepted) {
    await recordFailure(session, studentUserId, geofence.reason, context, {
      geofenceMode: session.geofence.mode,
      distanceMetres: roundForAudit(geofence.distanceMetres),
      accuracyMetres: roundForAudit(geofence.accuracyMetres),
      isMocked: location?.isMocked ?? null,
    });
    throw geofenceRejected(geofence, session);
  }

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
    metadata: {
      sessionId: session.id,
      unitCode: session.unitCode,
      ageSeconds: result.ageSeconds,
      geofenceMode: session.geofence.mode,
      distanceMetres: geofence.checked ? roundForAudit(geofence.distanceMetres) : null,
      accuracyMetres: geofence.checked ? roundForAudit(geofence.accuracyMetres) : null,
    },
  });

  return {
    sessionId: session.id,
    unitId: session.unitId,
    unitCode: session.unitCode,
    eligible: true,
    ageSeconds: result.ageSeconds,
    geofence: geofence.checked
      ? {
          result: 'INSIDE',
          distanceMetres: roundForAudit(geofence.distanceMetres)!,
          accuracyMetres: roundForAudit(geofence.accuracyMetres)!,
        }
      : { result: 'NOT_CHECKED' },
  };
}

export interface CardSwipeVerdict {
  sessionId: string;
  unitId: string;
  unitCode: string;
}

/**
 * Validates a card swipe for a student the terminal has already identified.
 *
 * Takes a student id, not a card: resolving a UID to its holder belongs to the
 * attendance module, which owns the card table. This keeps every rule about
 * whether a check-in counts in one place alongside verifyScan.
 *
 * Two rules from the QR path deliberately do not apply:
 *
 *  - There is no rotating token. The card itself is the credential, and what
 *    stops a borrowed card is that it names one student who can only be
 *    recorded once (below), not a short expiry.
 *  - The geofence is not evaluated. It exists to check that a *phone* claiming
 *    to be in the room really is; a student at the terminal is in the room by
 *    construction, and we have no reading from them to judge. The record is
 *    stored NOT_CHECKED, which is honest: the fence was not the thing that
 *    proved this one.
 */
export async function verifyCardSwipe(
  sessionId: string,
  studentUserId: string,
  context: RequestContext,
): Promise<CardSwipeVerdict> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');

  assertSessionAcceptingScans(session);
  assertMethodEnabled(session, 'CARD');

  const allocated = await sessionRepository.studentAllocatedToUnit(session.unitId, studentUserId);
  if (!allocated) {
    await recordFailure(session, studentUserId, 'NOT_ALLOCATED', context);
    throw new AppError(
      403,
      ErrorCode.FORBIDDEN,
      `This student is not registered for ${session.unitCode}.`,
    );
  }

  if (await sessionRepository.hasAlreadyCheckedIn(session.id, studentUserId)) {
    // The terminal shows this as "already recorded" rather than an error: a
    // student swiping twice has done nothing wrong.
    throw AppError.conflict(
      'This student is already recorded present for this class.',
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
    metadata: { sessionId: session.id, unitCode: session.unitCode, method: 'CARD' },
  });

  return { sessionId: session.id, unitId: session.unitId, unitCode: session.unitCode };
}

type GeofenceOutcome =
  | ({ checked: true } & Extract<ReadingCheck, { accepted: true }>)
  | { checked: false; accepted: true }
  | Extract<ReadingCheck, { accepted: false }>;

/** The session's fence applied to a scan. An OFF fence accepts anything, including no reading. */
function checkGeofence(session: SessionForQr, location: StudentReading | undefined): GeofenceOutcome {
  const { mode, latitude, longitude, radiusMetres } = session.geofence;
  if (mode === 'OFF') return { checked: false, accepted: true };
  if (mode === 'AWAITING_LOCATION') throw awaitingLocation();
  // The CHECK constraint guarantees these when the mode is not OFF.
  if (latitude === null || longitude === null || radiusMetres === null) {
    throw new Error(`session ${session.id} is geofenced (${mode}) but has no centre`);
  }
  const check = checkReading({ latitude, longitude, radiusMetres }, location);
  return check.accepted ? { checked: true, ...check } : check;
}

/**
 * The status tells the app what to do next:
 *   422 - fixable on the phone (allow location, wait for a fresh or better fix)
 *   403 - not fixable by retrying (outside the room, or a faked location)
 * `details` lets the app show the distance without parsing the message.
 */
function geofenceRejected(check: Extract<ReadingCheck, { accepted: false }>, session: SessionForQr): AppError {
  const status: Record<GeofenceRejection, number> = {
    LOCATION_REQUIRED: 422,
    LOCATION_STALE: 422,
    LOCATION_TOO_IMPRECISE: 422,
    LOCATION_MOCKED: 403,
    OUTSIDE_GEOFENCE: 403,
  };
  return new AppError(status[check.reason], ErrorCode[check.reason], rejectionMessage(check, session.roomCode), {
    details: {
      reason: check.reason,
      roomCode: session.roomCode,
      radiusMetres: session.geofence.radiusMetres,
      maxAccuracyMetres: env.GEOFENCE_MAX_STUDENT_ACCURACY_METRES,
      maxFixAgeSeconds: env.GEOFENCE_MAX_FIX_AGE_SECONDS,
      // Rounded like the message: a student has no use for centimetres, and
      // exact figures would only help someone calibrate a fake position.
      distanceMetres: check.distanceMetres === undefined ? null : roundDistanceForDisplay(check.distanceMetres),
      accuracyMetres: check.accuracyMetres === undefined ? null : Math.round(check.accuracyMetres),
    },
  });
}

/**
 * 409: the class is live, but the lecturer has not sent its location from
 * their phone yet. Nothing the student can fix; scanning again shortly works.
 * Not audited as a refusal: the student did nothing wrong.
 */
function awaitingLocation(): AppError {
  return new AppError(
    409,
    ErrorCode.GEOFENCE_AWAITING_LOCATION,
    "Your lecturer hasn't shared the class location yet. Scan again in a moment.",
  );
}

/** One decimal place: finer than GPS can measure, coarse enough to read. */
function roundForAudit(metres: number | undefined): number | null {
  return metres === undefined ? null : Math.round(metres * 10) / 10;
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
 * Switches a running session's fence off or on, or re-centres it.
 *
 * Switching ON picks the centre the same way activation does (a surveyed room
 * always wins, so a lecturer cannot drag the fence off a surveyed room), with
 * one addition: with no room and no new reading, the centre the session
 * already had is reused. Sending a location is how a lecturer re-captures
 * their position, e.g. after activating from the corridor, and how their phone
 * sets the centre of a class a laptop opened AWAITING_LOCATION.
 *
 * Every change is audited with the lecturer, because switching the fence off
 * is exactly what a lecturer covering for absent students would do.
 */
export async function setSessionGeofence(
  sessionId: string,
  lecturerUserId: string,
  input: UpdateGeofenceInput,
  context: RequestContext,
): Promise<SessionSummary> {
  const session = await sessionRepository.findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }
  if (session.status === 'CLOSED') {
    throw AppError.conflict('This class session has been closed.');
  }

  const previous = session.geofence;
  let next: SessionGeofence;

  if (input.mode === 'OFF') {
    if (previous.mode === 'OFF') return toSummary(session);
    next = { ...previous, mode: 'OFF' };
  } else {
    const room = await sessionRepository.findRoom(session.roomCode);
    const choice = chooseCentre(room, input.location);
    const radiusMetres = previous.radiusMetres ?? env.GEOFENCE_RADIUS_METRES;

    if (choice.ok) {
      next = fenceAt(choice, radiusMetres);
    } else if (!input.location && previous.latitude !== null && previous.longitude !== null) {
      // Reuse the centre captured earlier. With no surveyed room behind it any
      // more, it is the lecturer's device reading (or a room point SMARTTT has
      // since moved the class away from) and is labelled as such.
      next = { ...previous, mode: 'LECTURER_DEVICE', radiusMetres };
    } else {
      throw anchorUnavailable(choice);
    }
  }

  if (sameFence(previous, next)) return toSummary(session);

  await sessionRepository.updateSessionGeofence(sessionId, lecturerUserId, next);

  await auditService.record({
    action: 'ATTENDANCE_SESSION_GEOFENCE_CHANGED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      sessionId,
      unitCode: session.unitCode,
      from: previous.mode,
      to: next.mode,
      recaptured: input.mode === 'ON' && input.location !== undefined,
      anchorAccuracyMetres: next.anchorAccuracyMetres,
    },
  });

  return toSummary({ ...session, geofence: next });
}

function sameFence(a: SessionGeofence, b: SessionGeofence): boolean {
  return (
    a.mode === b.mode &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.radiusMetres === b.radiusMetres &&
    a.anchorAccuracyMetres === b.anchorAccuracyMetres
  );
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
  extra: Record<string, unknown> = {},
): Promise<void> {
  await auditService.record({
    action: 'ATTENDANCE_SCAN_REJECTED',
    outcome: 'FAILURE',
    userId: studentUserId,
    reason,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { sessionId: session.id, unitCode: session.unitCode, ...extra },
  });
}

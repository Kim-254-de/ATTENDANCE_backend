import { query, queryOne } from '../../db/database.js';
import type { AttendanceSessionStatus, GeofenceMode, VerificationMethod } from '../../db/types.js';

/**
 * All SQL for the session module. Every query is parameterised.
 *
 * These tables are NOT created by this service — the database is owned
 * separately. `docs/expected-schema.md` documents the exact columns each query
 * below depends on.
 */

export interface SessionForQr {
  id: string;
  unitId: string;
  /** e.g. "COSC 100" — the stable, human-readable key for the unit. */
  unitCode: string;
  unitName: string | null;
  lecturerUserId: string;
  /** HMAC key for this session's codes. Never leaves the server. */
  secret: string;
  status: AttendanceSessionStatus;
  title: string | null;
  opensAt: Date;
  closesAt: Date;
  rotationSeconds: number;
  /** The room of the meeting this session was activated for (unit_slots.room_code), fixed at activation. Null when unknown. */
  roomCode: string | null;
  geofence: SessionGeofence;
  /** Which of the four the lecturer ticked when activating. Never empty. */
  verificationMethods: VerificationMethod[];
}

/**
 * The fence stored on the session. The centre is kept when the mode is OFF,
 * so switching the fence back on can reuse it.
 */
export interface SessionGeofence {
  mode: GeofenceMode;
  latitude: number | null;
  longitude: number | null;
  radiusMetres: number | null;
  anchorAccuracyMetres: number | null;
}

interface SessionRow {
  id: string;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_user_id: string;
  qr_secret: string;
  status: AttendanceSessionStatus;
  title: string | null;
  opens_at: Date;
  closes_at: Date;
  rotation_seconds: number;
  room_code: string | null;
  geofence_mode: GeofenceMode;
  geofence_lat: number | null;
  geofence_lng: number | null;
  geofence_radius_m: number | null;
  geofence_anchor_accuracy_m: number | null;
  verification_methods: VerificationMethod[];
}

const toSession = (row: SessionRow): SessionForQr => ({
  id: row.id,
  unitId: row.unit_id,
  unitCode: row.unit_code,
  unitName: row.unit_name,
  lecturerUserId: row.lecturer_user_id,
  secret: row.qr_secret,
  status: row.status,
  title: row.title,
  opensAt: row.opens_at,
  closesAt: row.closes_at,
  rotationSeconds: row.rotation_seconds,
  roomCode: row.room_code,
  geofence: {
    mode: row.geofence_mode,
    latitude: row.geofence_lat,
    longitude: row.geofence_lng,
    radiusMetres: row.geofence_radius_m,
    anchorAccuracyMetres: row.geofence_anchor_accuracy_m,
  },
  verificationMethods: row.verification_methods,
});

const SELECT_SESSION = `
  SELECT s.id, s.unit_id, s.lecturer_user_id, s.qr_secret, s.status, s.title,
         s.opens_at, s.closes_at, s.rotation_seconds, s.room_code,
         s.geofence_mode, s.geofence_lat, s.geofence_lng, s.geofence_radius_m, s.geofence_anchor_accuracy_m,
         s.verification_methods,
         u.code AS unit_code, u.name AS unit_name
    FROM attendance_sessions s
    JOIN units u ON u.id = s.unit_id
`;

export async function findSessionById(sessionId: string): Promise<SessionForQr | null> {
  const row = await queryOne<SessionRow>(`${SELECT_SESSION} WHERE s.id = $1`, [sessionId]);
  return row ? toSession(row) : null;
}

/**
 * The lecturer's sessions still able to take check-ins: not closed and not
 * past their end. This is what lets a second device signed in to the same
 * account (the lecturer's phone) find the class their laptop opened.
 */
export async function findLiveSessionsForLecturer(lecturerUserId: string): Promise<SessionForQr[]> {
  const { rows } = await query<SessionRow>(
    `${SELECT_SESSION}
      WHERE s.lecturer_user_id = $1 AND s.status <> 'CLOSED' AND s.closes_at > NOW()
      ORDER BY s.opens_at DESC`,
    [lecturerUserId],
  );
  return rows.map(toSession);
}

export interface CreateSessionArgs {
  unitId: string;
  lecturerUserId: string;
  secret: string;
  title: string | null;
  opensAt: Date;
  closesAt: Date;
  rotationSeconds: number;
  /** The room of the meeting being activated; null when the timetable names none. */
  roomCode: string | null;
  geofence: SessionGeofence;
  /** The methods the lecturer ticked. Validated non-empty by the schema. */
  verificationMethods: VerificationMethod[];
}

export async function createSession(args: CreateSessionArgs): Promise<SessionForQr> {
  const created = await queryOne<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, title, opens_at, closes_at, rotation_seconds, status,
        geofence_mode, geofence_lat, geofence_lng, geofence_radius_m, geofence_anchor_accuracy_m, room_code,
        verification_methods)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $11, $12, $13, $14::text[])
     RETURNING id`,
    [
      args.unitId,
      args.lecturerUserId,
      args.secret,
      args.title,
      args.opensAt,
      args.closesAt,
      args.rotationSeconds,
      args.geofence.mode,
      args.geofence.latitude,
      args.geofence.longitude,
      args.geofence.radiusMetres,
      args.geofence.anchorAccuracyMetres,
      args.roomCode,
      args.verificationMethods,
    ],
  );

  if (!created) throw new Error('attendance_sessions insert returned no row');

  const session = await findSessionById(created.id);
  if (!session) throw new Error('attendance_sessions row vanished immediately after insert');
  return session;
}

/**
 * Moves a session between states.
 *
 * The `status <> $3` guard makes this idempotent-safe: closing an already
 * closed session reports no change rather than rewriting the row and its
 * timestamp.
 */
export async function updateSessionStatus(
  sessionId: string,
  lecturerUserId: string,
  status: AttendanceSessionStatus,
): Promise<boolean> {
  const result = await query(
    `UPDATE attendance_sessions
        SET status = $3, updated_at = NOW()
      WHERE id = $1 AND lecturer_user_id = $2 AND status <> $3`,
    [sessionId, lecturerUserId, status],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Replaces a session's fence. Owner-scoped like updateSessionStatus; false when nothing matched. */
export async function updateSessionGeofence(
  sessionId: string,
  lecturerUserId: string,
  geofence: SessionGeofence,
): Promise<boolean> {
  const result = await query(
    `UPDATE attendance_sessions
        SET geofence_mode = $3, geofence_lat = $4, geofence_lng = $5,
            geofence_radius_m = $6, geofence_anchor_accuracy_m = $7, updated_at = NOW()
      WHERE id = $1 AND lecturer_user_id = $2`,
    [sessionId, lecturerUserId, geofence.mode, geofence.latitude, geofence.longitude,
     geofence.radiusMetres, geofence.anchorAccuracyMetres],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface UnitRoom {
  /** Null when SMARTTT names no room for the unit's slot. */
  roomCode: string | null;
  latitude: number | null;
  longitude: number | null;
  surveyedAccuracyMetres: number | null;
}

/**
 * A room and, if someone has surveyed it, its centre. With no room code (the
 * timetable names none) or an unsurveyed room, the coordinates are null and
 * the fence falls back to the lecturer's device (chooseCentre).
 */
export async function findRoom(roomCode: string | null): Promise<UnitRoom> {
  if (!roomCode) return { roomCode: null, latitude: null, longitude: null, surveyedAccuracyMetres: null };
  const row = await queryOne<{ latitude: number | null; longitude: number | null; surveyed_accuracy_m: number | null }>(
    `SELECT latitude, longitude, surveyed_accuracy_m FROM rooms WHERE code = $1`,
    [roomCode],
  );
  return {
    roomCode,
    latitude: row?.latitude ?? null,
    longitude: row?.longitude ?? null,
    surveyedAccuracyMetres: row?.surveyed_accuracy_m ?? null,
  };
}

export interface LecturerUnit {
  /** False while a unit awaits admin verification — createSession refuses those. */
  verified: boolean;
}

/** The unit this session would belong to, if the lecturer teaches it — null otherwise. */
export async function findLecturerUnit(
  unitId: string,
  lecturerUserId: string,
): Promise<LecturerUnit | null> {
  const row = await queryOne<{ status: string }>(
    `SELECT status FROM units WHERE id = $1 AND lecturer_user_id = $2`,
    [unitId, lecturerUserId],
  );
  return row ? { verified: row.status === 'VERIFIED' } : null;
}

/**
 * True when the student is allocated to the unit.
 *
 * This is the check that makes a shared screenshot near-useless: even inside
 * the rotation window, a student who is not on the unit cannot check in.
 */
export async function studentAllocatedToUnit(
  unitId: string,
  studentUserId: string,
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM unit_allocations
        WHERE unit_id = $1
          AND student_user_id = $2
          AND status = 'ACTIVE'
     ) AS ok`,
    [unitId, studentUserId],
  );
  return row?.ok ?? false;
}

/**
 * Whether this student has already been recorded for this session.
 *
 * Advisory only — the authoritative guarantee is the
 * UNIQUE (session_id, student_user_id) index on attendance_records, which is
 * what stops two simultaneous scans both being written.
 */
export async function hasAlreadyCheckedIn(
  sessionId: string,
  studentUserId: string,
): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM attendance_records
        WHERE session_id = $1 AND student_user_id = $2
     ) AS ok`,
    [sessionId, studentUserId],
  );
  return row?.ok ?? false;
}

/**
 * The lecturer's live counters: check-ins so far, how many students could
 * check in, and how many were refused for being outside the fence and have
 * not checked in since (a student who moved closer and rescanned no longer
 * counts). Refusals are only recorded in audit_logs, so that is read here;
 * audit_logs_action_idx narrows it to rejected scans first.
 */
export async function countAttendance(
  sessionId: string,
  unitId: string,
): Promise<{ checkedIn: number; enrolled: number; refusedOutsideFence: number }> {
  const row = await queryOne<{ checked_in: number; enrolled: number; refused_outside: number }>(
    `SELECT (SELECT COUNT(*) FROM attendance_records WHERE session_id = $1)::int AS checked_in,
            (SELECT COUNT(*) FROM unit_allocations
              WHERE unit_id = $2 AND status = 'ACTIVE')::int                AS enrolled,
            (SELECT COUNT(DISTINCT l.user_id) FROM audit_logs l
              WHERE l.action = 'ATTENDANCE_SCAN_REJECTED'
                AND l.reason = 'OUTSIDE_GEOFENCE'
                AND l.metadata->>'sessionId' = $1::text
                AND NOT EXISTS (SELECT 1 FROM attendance_records r
                                 WHERE r.session_id = $1 AND r.student_user_id = l.user_id))::int AS refused_outside`,
    [sessionId, unitId],
  );
  return {
    checkedIn: row?.checked_in ?? 0,
    enrolled: row?.enrolled ?? 0,
    refusedOutsideFence: row?.refused_outside ?? 0,
  };
}

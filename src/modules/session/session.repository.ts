import { query, queryOne } from '../../db/database.js';
import type { AttendanceSessionStatus } from '../../db/types.js';

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
});

const SELECT_SESSION = `
  SELECT s.id, s.unit_id, s.lecturer_user_id, s.qr_secret, s.status, s.title,
         s.opens_at, s.closes_at, s.rotation_seconds,
         u.code AS unit_code, u.name AS unit_name
    FROM attendance_sessions s
    JOIN units u ON u.id = s.unit_id
`;

export async function findSessionById(sessionId: string): Promise<SessionForQr | null> {
  const row = await queryOne<SessionRow>(`${SELECT_SESSION} WHERE s.id = $1`, [sessionId]);
  return row ? toSession(row) : null;
}

export interface CreateSessionArgs {
  unitId: string;
  lecturerUserId: string;
  secret: string;
  title: string | null;
  opensAt: Date;
  closesAt: Date;
  rotationSeconds: number;
}

export async function createSession(args: CreateSessionArgs): Promise<SessionForQr> {
  const created = await queryOne<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, title, opens_at, closes_at, rotation_seconds, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')
     RETURNING id`,
    [
      args.unitId,
      args.lecturerUserId,
      args.secret,
      args.title,
      args.opensAt,
      args.closesAt,
      args.rotationSeconds,
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

/** Check-ins recorded so far, and how many students could check in — the lecturer's live counter. */
export async function countAttendance(
  sessionId: string,
  unitId: string,
): Promise<{ checkedIn: number; enrolled: number }> {
  const row = await queryOne<{ checked_in: number; enrolled: number }>(
    `SELECT (SELECT COUNT(*) FROM attendance_records WHERE session_id = $1)::int AS checked_in,
            (SELECT COUNT(*) FROM unit_allocations
              WHERE unit_id = $2 AND status = 'ACTIVE')::int                AS enrolled`,
    [sessionId, unitId],
  );
  return { checkedIn: row?.checked_in ?? 0, enrolled: row?.enrolled ?? 0 };
}

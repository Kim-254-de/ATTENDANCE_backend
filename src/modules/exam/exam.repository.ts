import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/database.js';

/** All SQL for exam sessions (db/migrations/043_exam_sessions.sql). Every query is parameterised. */

export interface ExamSessionRow {
  id: string;
  key: string;
  termId: string;
  paperKey: string;
  unitCodes: string[];
  title: string;
  startsAt: Date;
  endsAt: Date;
  roomCode: string;
  candidates: unknown[];
  registrationNumbers: string[];
  invigilatorStaffNumber: string;
  role: 'main' | 'extra';
  mainInvigilatorStaffNumber: string | null;
  withdrawnAt: Date | null;
  openedByUserId: string | null;
  secret: string | null;
  status: 'OPEN' | 'CLOSED' | null;
  openedAt: Date | null;
  closesAt: Date | null;
  rotationSeconds: number | null;
  geofenceMode: 'ROOM' | 'LECTURER_DEVICE' | 'OFF' | null;
  latitude: number | null;
  longitude: number | null;
  radiusMetres: number | null;
}

const COLUMNS = `
  id, key, term_id AS "termId", paper_key AS "paperKey", unit_codes AS "unitCodes", title,
  starts_at AS "startsAt", ends_at AS "endsAt", room_code AS "roomCode", candidates,
  registration_numbers AS "registrationNumbers", invigilator_staff_number AS "invigilatorStaffNumber", role,
  main_invigilator_staff_number AS "mainInvigilatorStaffNumber", withdrawn_at AS "withdrawnAt",
  opened_by_user_id AS "openedByUserId", qr_secret AS secret, status, opened_at AS "openedAt",
  closes_at AS "closesAt", rotation_seconds AS "rotationSeconds", geofence_mode AS "geofenceMode",
  latitude, longitude, radius_metres AS "radiusMetres"`;

export interface IncomingExamSession {
  key: string;
  termId: string;
  version: number;
  paperKey: string;
  unitCodes: string[];
  title: string;
  startsAt: Date;
  endsAt: Date;
  roomCode: string;
  candidates: unknown[];
  registrationNumbers: string[];
  invigilatorStaffNumber: string;
  role: 'main' | 'extra';
  mainInvigilatorStaffNumber: string | null;
}

/**
 * Replaces a term's exam sessions with SMARTTT's latest version: each is
 * created or updated by key (an open session keeps its code and records), and
 * the term's sessions not in it are withdrawn, not deleted, so who sat them stays.
 */
export async function replaceTermSessions(
  client: PoolClient,
  termId: string,
  sessions: IncomingExamSession[],
): Promise<{ upserted: number; withdrawn: number }> {
  for (const s of sessions) {
    await client.query(
      `INSERT INTO exam_sessions
         (key, term_id, version, paper_key, unit_codes, title, starts_at, ends_at, room_code, candidates,
          registration_numbers, invigilator_staff_number, role, main_invigilator_staff_number, withdrawn_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, NULL)
       ON CONFLICT (key) DO UPDATE SET
         term_id = EXCLUDED.term_id, version = EXCLUDED.version, paper_key = EXCLUDED.paper_key,
         unit_codes = EXCLUDED.unit_codes, title = EXCLUDED.title, starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at, room_code = EXCLUDED.room_code, candidates = EXCLUDED.candidates,
         registration_numbers = EXCLUDED.registration_numbers,
         invigilator_staff_number = EXCLUDED.invigilator_staff_number, role = EXCLUDED.role,
         main_invigilator_staff_number = EXCLUDED.main_invigilator_staff_number,
         withdrawn_at = NULL, updated_at = NOW()`,
      [
        s.key,
        s.termId,
        s.version,
        s.paperKey,
        JSON.stringify(s.unitCodes),
        s.title,
        s.startsAt,
        s.endsAt,
        s.roomCode,
        JSON.stringify(s.candidates),
        s.registrationNumbers,
        s.invigilatorStaffNumber,
        s.role,
        s.mainInvigilatorStaffNumber,
      ],
    );
  }
  const withdrawn = await client.query(
    `UPDATE exam_sessions SET withdrawn_at = NOW(), updated_at = NOW()
      WHERE term_id = $1 AND withdrawn_at IS NULL AND NOT (key = ANY($2::text[]))`,
    [termId, sessions.map((s) => s.key)],
  );
  return { upserted: sessions.length, withdrawn: withdrawn.rowCount ?? 0 };
}

export async function setTermMode(
  termId: string,
  mode: 'teaching' | 'exams',
  switchedAt: Date | null,
  closedAt: Date | null,
): Promise<void> {
  await query(
    `INSERT INTO term_modes (term_id, mode, switched_at, closed_at, updated_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (term_id) DO UPDATE SET mode = EXCLUDED.mode, switched_at = EXCLUDED.switched_at,
       closed_at = EXCLUDED.closed_at, updated_at = NOW()`,
    [termId, mode, switchedAt, closedAt],
  );
}

/** True while any term is in exam mode (in practice, the current one). */
export async function anyTermInExamMode(): Promise<boolean> {
  const row = await queryOne<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM term_modes WHERE mode = 'exams') AS on`);
  return row?.on ?? false;
}

export async function findById(id: string): Promise<ExamSessionRow | null> {
  return queryOne<ExamSessionRow>(`SELECT ${COLUMNS} FROM exam_sessions WHERE id = $1`, [id]);
}

/** The invigilator's exam sessions from `from` on, earliest first. */
export async function findForInvigilator(staffNumber: string, from: Date): Promise<ExamSessionRow[]> {
  const result = await query<ExamSessionRow>(
    `SELECT ${COLUMNS} FROM exam_sessions
      WHERE invigilator_staff_number = $1 AND withdrawn_at IS NULL AND ends_at >= $2
      ORDER BY starts_at, room_code`,
    [staffNumber, from],
  );
  return result.rows;
}

/** Every room of a paper (its live sessions), for the main invigilator and for a student in the wrong room. */
export async function findPaperSessions(termId: string, paperKey: string): Promise<ExamSessionRow[]> {
  const result = await query<ExamSessionRow>(
    `SELECT ${COLUMNS} FROM exam_sessions WHERE term_id = $1 AND paper_key = $2 AND withdrawn_at IS NULL ORDER BY room_code`,
    [termId, paperKey],
  );
  return result.rows;
}

export async function open(
  id: string,
  args: {
    userId: string;
    secret: string;
    openedAt: Date;
    closesAt: Date;
    rotationSeconds: number;
    geofenceMode: 'ROOM' | 'LECTURER_DEVICE' | 'OFF';
    latitude: number | null;
    longitude: number | null;
    radiusMetres: number | null;
  },
): Promise<ExamSessionRow | null> {
  return queryOne<ExamSessionRow>(
    `UPDATE exam_sessions SET opened_by_user_id = $2, qr_secret = $3, status = 'OPEN', opened_at = $4, closes_at = $5,
            rotation_seconds = $6, geofence_mode = $7, latitude = $8, longitude = $9, radius_metres = $10, updated_at = NOW()
      WHERE id = $1 AND status IS NULL
      RETURNING ${COLUMNS}`,
    [
      id,
      args.userId,
      args.secret,
      args.openedAt,
      args.closesAt,
      args.rotationSeconds,
      args.geofenceMode,
      args.latitude,
      args.longitude,
      args.radiusMetres,
    ],
  );
}

export async function close(id: string): Promise<void> {
  await query(`UPDATE exam_sessions SET status = 'CLOSED', updated_at = NOW() WHERE id = $1`, [id]);
}

/** Records the check-in; null when the student had already checked in. */
export async function recordCheckIn(
  sessionId: string,
  studentUserId: string,
  registrationNumber: string,
): Promise<{ id: string; checkedInAt: Date } | null> {
  return queryOne<{ id: string; checkedInAt: Date }>(
    `INSERT INTO exam_attendance_records (exam_session_id, student_user_id, registration_number)
     VALUES ($1, $2, $3) ON CONFLICT (exam_session_id, student_user_id) DO NOTHING
     RETURNING id, checked_in_at AS "checkedInAt"`,
    [sessionId, studentUserId, registrationNumber],
  );
}

/** True when the id is an exam session's (not a class's). */
export async function exists(id: string): Promise<boolean> {
  const row = await queryOne<{ found: boolean }>(`SELECT EXISTS (SELECT 1 FROM exam_sessions WHERE id = $1) AS found`, [id]);
  return row?.found ?? false;
}

export async function checkedIn(sessionIds: string[]): Promise<Map<string, Set<string>>> {
  const result = await query<{ sessionId: string; registrationNumber: string }>(
    `SELECT exam_session_id AS "sessionId", registration_number AS "registrationNumber"
       FROM exam_attendance_records WHERE exam_session_id = ANY($1::uuid[])`,
    [sessionIds],
  );
  const out = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (!out.has(row.sessionId)) out.set(row.sessionId, new Set());
    out.get(row.sessionId)!.add(row.registrationNumber);
  }
  return out;
}

export async function staffNumberOf(userId: string): Promise<string | null> {
  const row = await queryOne<{ staffNumber: string }>(
    `SELECT staff_number AS "staffNumber" FROM lecturer_profiles WHERE user_id = $1`,
    [userId],
  );
  return row?.staffNumber ?? null;
}

export async function registrationNumberOf(userId: string): Promise<string | null> {
  const row = await queryOne<{ registrationNumber: string }>(
    `SELECT registration_number AS "registrationNumber" FROM student_profiles WHERE user_id = $1`,
    [userId],
  );
  return row?.registrationNumber ?? null;
}

import type { PoolClient } from 'pg';
import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for department fingerprint enrolment and the commands queued for
 * terminals (db/migrations/028_terminal_commands.sql). Every query is
 * parameterised.
 *
 * A department's students are those with an ACTIVE place on a unit taught by
 * one of its lecturers: the same rule as GET /departments/students, since
 * students are not otherwise linked to a department here.
 */

const DEPT_UNITS = `SELECT u.id FROM units u JOIN lecturer_profiles lp ON lp.user_id = u.lecturer_user_id WHERE lp.department_id = $1`;

export type CommandKind = 'ENROL_FINGERPRINT' | 'DELETE_FINGERPRINT';
export type CommandStatus = 'PENDING' | 'DONE' | 'FAILED' | 'CANCELLED';

// --- The department's students ----------------------------------------------

export interface DepartmentStudent {
  registrationNumber: string;
  studentUserId: string | null;
  fullName: string | null;
}

/** The student with this number, if they are on one of the department's class lists. */
export async function findDepartmentStudent(departmentId: string, registrationNumber: string): Promise<DepartmentStudent | null> {
  const row = await queryOne<{ registration_number: string; student_user_id: string | null; full_name: string | null }>(
    `SELECT a.registration_number,
            COALESCE(a.student_user_id, p.user_id) AS student_user_id,
            COALESCE(su.full_name, a.full_name) AS full_name
       FROM unit_allocations a
  LEFT JOIN student_profiles p ON p.registration_number = a.registration_number
  LEFT JOIN users su ON su.id = COALESCE(a.student_user_id, p.user_id) AND su.deleted_at IS NULL
      WHERE a.unit_id IN (${DEPT_UNITS})
        AND a.status = 'ACTIVE'
        AND a.registration_number = $2
      ORDER BY a.student_user_id IS NULL
      LIMIT 1`,
    [departmentId, registrationNumber],
  );
  if (!row) return null;
  return { registrationNumber: row.registration_number, studentUserId: row.student_user_id, fullName: row.full_name };
}

export interface CoverageRow {
  registrationNumber: string;
  studentUserId: string | null;
  fullName: string | null;
  unitCodes: string[];
  fingerprints: Array<{ id: string; terminalCode: string; label: string | null; enrolledAt: string }>;
  pending: Array<{ id: string; kind: CommandKind; terminalCode: string; label: string | null; createdAt: string }>;
}

/**
 * One row per student on the department's class lists, with where they are
 * enrolled and what is still waiting on a device. Only enrolments on this
 * department's own terminals are shown.
 */
export async function listCoverage(departmentId: string, search: string | null, limit: number): Promise<CoverageRow[]> {
  const { rows } = await query<{
    registration_number: string;
    student_user_id: string | null;
    full_name: string | null;
    unit_codes: string[];
    fingerprints: CoverageRow['fingerprints'];
    pending: CoverageRow['pending'];
  }>(
    `WITH roster AS (
       SELECT a.registration_number,
              MAX(COALESCE(a.student_user_id, p.user_id)::text)::uuid AS student_user_id,
              MAX(COALESCE(su.full_name, a.full_name)) AS full_name,
              ARRAY_AGG(DISTINCT u.code ORDER BY u.code) AS unit_codes
         FROM unit_allocations a
         JOIN units u ON u.id = a.unit_id
    LEFT JOIN student_profiles p ON p.registration_number = a.registration_number
    LEFT JOIN users su ON su.id = COALESCE(a.student_user_id, p.user_id)
        WHERE a.unit_id IN (${DEPT_UNITS}) AND a.status = 'ACTIVE'
        GROUP BY a.registration_number
     )
     SELECT r.registration_number, r.student_user_id, r.full_name, r.unit_codes,
            COALESCE((
              SELECT JSON_AGG(JSON_BUILD_OBJECT('id', f.id, 'terminalCode', f.terminal_id, 'label', f.label,
                                                'enrolledAt', f.enrolled_at) ORDER BY f.enrolled_at)
                FROM student_fingerprints f
                JOIN terminals t ON t.code = f.terminal_id AND t.department_id = $1
               WHERE f.student_user_id = r.student_user_id AND f.status = 'ACTIVE'
            ), '[]'::json) AS fingerprints,
            COALESCE((
              SELECT JSON_AGG(JSON_BUILD_OBJECT('id', c.id, 'kind', c.kind, 'terminalCode', t.code, 'label', c.label,
                                                'createdAt', c.created_at) ORDER BY c.created_at)
                FROM terminal_commands c
                JOIN terminals t ON t.id = c.terminal_id AND t.department_id = $1
               WHERE c.student_user_id = r.student_user_id AND c.status = 'PENDING'
            ), '[]'::json) AS pending
       FROM roster r
      WHERE $2::text IS NULL
         OR r.registration_number ILIKE '%' || $2 || '%'
         OR r.full_name ILIKE '%' || $2 || '%'
      ORDER BY r.full_name NULLS LAST, r.registration_number
      LIMIT $3`,
    [departmentId, search, limit],
  );
  return rows.map((r) => ({
    registrationNumber: r.registration_number,
    studentUserId: r.student_user_id,
    fullName: r.full_name,
    unitCodes: r.unit_codes,
    fingerprints: r.fingerprints,
    pending: r.pending,
  }));
}

// --- Commands ----------------------------------------------------------------

export interface Command {
  id: string;
  terminalId: string;
  kind: CommandKind;
  studentUserId: string;
  fingerprintId: string | null;
  label: string | null;
  status: CommandStatus;
  createdAt: Date;
  /** For the device's screen, so the operator knows whose finger to take. */
  studentName: string | null;
  registrationNumber: string | null;
}

const SELECT_COMMAND = `
  SELECT c.id, c.terminal_id, c.kind, c.student_user_id, c.fingerprint_id, c.label, c.status, c.created_at,
         u.full_name AS student_name, p.registration_number
    FROM terminal_commands c
    JOIN users u ON u.id = c.student_user_id
    LEFT JOIN student_profiles p ON p.user_id = c.student_user_id`;

interface CommandRow {
  id: string;
  terminal_id: string;
  kind: CommandKind;
  student_user_id: string;
  fingerprint_id: string | null;
  label: string | null;
  status: CommandStatus;
  created_at: Date;
  student_name: string | null;
  registration_number: string | null;
}

const toCommand = (r: CommandRow): Command => ({
  id: r.id,
  terminalId: r.terminal_id,
  kind: r.kind,
  studentUserId: r.student_user_id,
  fingerprintId: r.fingerprint_id,
  label: r.label,
  status: r.status,
  createdAt: r.created_at,
  studentName: r.student_name,
  registrationNumber: r.registration_number,
});

export async function createCommand(
  args: { terminalId: string; kind: CommandKind; studentUserId: string; fingerprintId: string | null; label: string | null; requestedByUserId: string | null },
  client?: PoolClient,
): Promise<string> {
  const sql = `INSERT INTO terminal_commands (terminal_id, kind, student_user_id, fingerprint_id, label, requested_by_user_id)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`;
  const params = [args.terminalId, args.kind, args.studentUserId, args.fingerprintId, args.label, args.requestedByUserId];
  const { rows: [row] } = client ? await client.query<{ id: string }>(sql, params) : await query<{ id: string }>(sql, params);
  return row!.id;
}

/** Oldest first, so the device works through them in the order the department asked. */
export async function listPending(terminalId: string): Promise<Command[]> {
  const { rows } = await query<CommandRow>(`${SELECT_COMMAND} WHERE c.terminal_id = $1 AND c.status = 'PENDING' ORDER BY c.created_at`, [terminalId]);
  return rows.map(toCommand);
}

export async function countPending(terminalId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM terminal_commands WHERE terminal_id = $1 AND status = 'PENDING'`, [terminalId]);
  return row?.n ?? 0;
}

export async function findForTerminal(id: string, terminalId: string): Promise<Command | null> {
  const row = await queryOne<CommandRow>(`${SELECT_COMMAND} WHERE c.id = $1 AND c.terminal_id = $2`, [id, terminalId]);
  return row ? toCommand(row) : null;
}

/** A command on one of the department's terminals. */
export async function findInDepartment(id: string, departmentId: string): Promise<Command | null> {
  const row = await queryOne<CommandRow>(
    `${SELECT_COMMAND} JOIN terminals t ON t.id = c.terminal_id WHERE c.id = $1 AND t.department_id = $2`,
    [id, departmentId],
  );
  return row ? toCommand(row) : null;
}

/** Closes a PENDING command. False when it was not pending any more (a race, or already done). */
export async function finish(
  id: string,
  status: Exclude<CommandStatus, 'PENDING'>,
  extra: { fingerprintId?: string; failureReason?: string } = {},
  client?: PoolClient,
): Promise<boolean> {
  const sql = `UPDATE terminal_commands
                  SET status = $2, completed_at = NOW(),
                      fingerprint_id = COALESCE($3, fingerprint_id), failure_reason = $4
                WHERE id = $1 AND status = 'PENDING'`;
  const params = [id, status, extra.fingerprintId ?? null, extra.failureReason ?? null];
  const result = client ? await client.query(sql, params) : await query(sql, params);
  return (result.rowCount ?? 0) > 0;
}

// --- Enrolments ----------------------------------------------------------------

export interface DepartmentFingerprint {
  id: string;
  studentUserId: string;
  terminalId: string;
  terminalCode: string;
  terminalStatus: string;
  status: 'ACTIVE' | 'REVOKED';
}

/** An enrolment on one of the department's terminals. */
export async function findFingerprintInDepartment(id: string, departmentId: string): Promise<DepartmentFingerprint | null> {
  const row = await queryOne<{ id: string; student_user_id: string; terminal_id: string; code: string; terminal_status: string; status: 'ACTIVE' | 'REVOKED' }>(
    `SELECT f.id, f.student_user_id, t.id AS terminal_id, t.code, t.status AS terminal_status, f.status
       FROM student_fingerprints f
       JOIN terminals t ON t.code = f.terminal_id
      WHERE f.id = $1 AND t.department_id = $2`,
    [id, departmentId],
  );
  if (!row) return null;
  return {
    id: row.id,
    studentUserId: row.student_user_id,
    terminalId: row.terminal_id,
    terminalCode: row.code,
    terminalStatus: row.terminal_status,
    status: row.status,
  };
}

export async function revokeFingerprint(id: string, client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `UPDATE student_fingerprints SET status = 'REVOKED', revoked_at = NOW() WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function insertFingerprint(
  args: { studentUserId: string; terminalCode: string; fingerRefHmac: string; label: string | null; enrolledByUserId: string | null },
  client: PoolClient,
): Promise<string> {
  const { rows: [row] } = await client.query<{ id: string }>(
    `INSERT INTO student_fingerprints (student_user_id, terminal_id, finger_ref_hmac, label, status, enrolled_by_user_id)
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5) RETURNING id`,
    [args.studentUserId, args.terminalCode, args.fingerRefHmac, args.label, args.enrolledByUserId],
  );
  return row!.id;
}

export async function hasActiveFingerprint(studentUserId: string, terminalCode: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM student_fingerprints WHERE student_user_id = $1 AND terminal_id = $2 AND status = 'ACTIVE'`,
    [studentUserId, terminalCode],
  );
  return row !== null;
}

/** Who asked for an enrolment, recorded on the enrolment it produced. */
export async function requestedBy(commandId: string): Promise<string | null> {
  const row = await queryOne<{ requested_by_user_id: string | null }>(
    `SELECT requested_by_user_id FROM terminal_commands WHERE id = $1`,
    [commandId],
  );
  return row?.requested_by_user_id ?? null;
}

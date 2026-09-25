import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';
import type { AllocationStatus } from '../../db/types.js';

/** All SQL for the unit module. Every query is parameterised. */

export interface UnitSchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** A lecturer-added unit starts PENDING_VERIFICATION; an admin verifies it against the issued timetable. */
export type UnitVerificationStatus = 'PENDING_VERIFICATION' | 'VERIFIED';

export interface UnitSummary {
  id: string;
  code: string;
  name: string | null;
  /** Students who can check in. */
  studentCount: number;
  /** Self-enrolment requests waiting for the lecturer. */
  pendingCount: number;
  createdAt: Date;
  /** Every unit has exactly one issued slot; null only for rows created before schedules existed. */
  schedule: UnitSchedule | null;
  status: UnitVerificationStatus;
}

interface UnitSummaryRow {
  id: string;
  code: string;
  name: string | null;
  student_count: number;
  pending_count: number;
  created_at: Date;
  day_of_week: number | null;
  start_time: string | null;
  end_time: string | null;
  status: UnitVerificationStatus;
}

const toUnitSummary = (row: UnitSummaryRow): UnitSummary => ({
  id: row.id,
  code: row.code,
  name: row.name,
  studentCount: row.student_count,
  pendingCount: row.pending_count,
  createdAt: row.created_at,
  schedule:
    row.day_of_week === null || row.start_time === null || row.end_time === null
      ? null
      : { dayOfWeek: row.day_of_week, startTime: row.start_time.slice(0, 5), endTime: row.end_time.slice(0, 5) },
  status: row.status,
});

const SELECT_UNIT_SUMMARY = `
  SELECT u.id, u.code, u.name, u.created_at, u.status,
         COUNT(a.id) FILTER (WHERE a.status = 'ACTIVE')::int  AS student_count,
         COUNT(a.id) FILTER (WHERE a.status = 'PENDING')::int AS pending_count,
         s.day_of_week, s.start_time, s.end_time
    FROM units u
    LEFT JOIN unit_allocations a ON a.unit_id = u.id
    LEFT JOIN unit_schedule s ON s.unit_id = u.id
`;
const GROUP_BY_UNIT_SUMMARY = 'GROUP BY u.id, s.day_of_week, s.start_time, s.end_time';
// u.status is functionally dependent on u.id (the primary key already in GROUP BY), so
// Postgres allows selecting it un-aggregated without adding it to the GROUP BY list.

export async function findUnitsForLecturer(lecturerUserId: string): Promise<UnitSummary[]> {
  const result = await query<UnitSummaryRow>(
    `${SELECT_UNIT_SUMMARY} WHERE u.lecturer_user_id = $1 ${GROUP_BY_UNIT_SUMMARY} ORDER BY u.code`,
    [lecturerUserId],
  );
  return result.rows.map(toUnitSummary);
}

export async function findUnitSummary(unitId: string): Promise<UnitSummary | null> {
  const row = await queryOne<UnitSummaryRow>(
    `${SELECT_UNIT_SUMMARY} WHERE u.id = $1 ${GROUP_BY_UNIT_SUMMARY}`,
    [unitId],
  );
  return row ? toUnitSummary(row) : null;
}

/**
 * The unit whose issued slot covers this moment, for this lecturer — the one
 * `ActivateClass` shows, if any.
 *
 * Excludes a unit still `PENDING_VERIFICATION`: `session.service.ts` would
 * refuse to activate a class for it anyway, so surfacing it here would only
 * hand the lecturer a button that 403s.
 *
 * `dayOfWeek`/`timeOfDay` are computed by the caller from a JS `Date` (server
 * local time — the same convention `startTime`/`endTime` were entered in),
 * rather than cast inside SQL: `unit_schedule.start_time`/`end_time` are
 * timezone-naive `TIME` values, and casting a `timestamptz` to `time` inside
 * Postgres uses the *session's* timezone, which need not match the server's —
 * comparing two values in the same (JS) timezone up front avoids that mismatch.
 */
export async function findCurrentUnitForLecturer(
  lecturerUserId: string,
  dayOfWeek: number,
  timeOfDay: string,
): Promise<UnitSummary | null> {
  const row = await queryOne<UnitSummaryRow>(
    `${SELECT_UNIT_SUMMARY}
      WHERE u.lecturer_user_id = $1
        AND u.status = 'VERIFIED'
        AND s.day_of_week = $2
        AND $3::time BETWEEN s.start_time AND s.end_time
      ${GROUP_BY_UNIT_SUMMARY}`,
    [lecturerUserId, dayOfWeek, timeOfDay],
  );
  return row ? toUnitSummary(row) : null;
}

/** The issued slot for one unit, for the session-activation time gate. */
export async function findUnitSchedule(unitId: string): Promise<UnitSchedule | null> {
  const row = await queryOne<{ day_of_week: number; start_time: string; end_time: string }>(
    `SELECT day_of_week, start_time, end_time FROM unit_schedule WHERE unit_id = $1`,
    [unitId],
  );
  return row ? { dayOfWeek: row.day_of_week, startTime: row.start_time.slice(0, 5), endTime: row.end_time.slice(0, 5) } : null;
}

export interface UnitOwner {
  id: string;
  code: string;
  lecturerUserId: string;
}

export async function findUnitById(unitId: string): Promise<UnitOwner | null> {
  const row = await queryOne<{ id: string; code: string; lecturer_user_id: string }>(
    `SELECT id, code, lecturer_user_id FROM units WHERE id = $1`,
    [unitId],
  );
  return row ? { id: row.id, code: row.code, lecturerUserId: row.lecturer_user_id } : null;
}

/** Who to email when a unit needs verifying: every active administrator. */
export interface AdminRecipient {
  email: string;
  fullName: string;
}

export async function findAdminRecipients(): Promise<AdminRecipient[]> {
  const result = await query<{ email: string; full_name: string }>(
    `SELECT email, full_name FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND deleted_at IS NULL`,
  );
  return result.rows.map((row) => ({ email: row.email, fullName: row.full_name }));
}

export async function findUnitByCode(code: string): Promise<UnitOwner | null> {
  const row = await queryOne<{ id: string; code: string; lecturer_user_id: string }>(
    `SELECT id, code, lecturer_user_id FROM units WHERE code = $1`,
    [code],
  );
  return row ? { id: row.id, code: row.code, lecturerUserId: row.lecturer_user_id } : null;
}

/** Throws a unique violation if the code is taken; the service turns that into a 409. */
export async function createUnit(
  code: string,
  name: string,
  lecturerUserId: string,
  schedule: UnitSchedule,
  status: UnitVerificationStatus,
): Promise<string> {
  return transaction(async (client: PoolClient) => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO units (code, name, lecturer_user_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [code, name, lecturerUserId, status],
      client,
    );
    if (!row) throw new Error('units insert returned no row');
    await query(
      `INSERT INTO unit_schedule (unit_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)`,
      [row.id, schedule.dayOfWeek, schedule.startTime, schedule.endTime],
      client,
    );
    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

export interface Allocation {
  id: string;
  registrationNumber: string | null;
  studentUserId: string | null;
  fullName: string | null;
  status: AllocationStatus;
  source: 'LECTURER' | 'SELF_ENROLLED' | 'ERP';
  /** Whether the student has an account yet, i.e. can actually sign in and check in. */
  hasAccount: boolean;
  createdAt: Date;
}

interface AllocationRow {
  id: string;
  registration_number: string | null;
  student_user_id: string | null;
  full_name: string | null;
  status: AllocationStatus;
  source: 'LECTURER' | 'SELF_ENROLLED' | 'ERP';
  created_at: Date;
}

const toAllocation = (row: AllocationRow): Allocation => ({
  id: row.id,
  registrationNumber: row.registration_number,
  studentUserId: row.student_user_id,
  fullName: row.full_name,
  status: row.status,
  source: row.source,
  hasAccount: row.student_user_id !== null,
  createdAt: row.created_at,
});

const ALLOCATION_COLUMNS = `a.id, a.registration_number, a.student_user_id,
  COALESCE(a.full_name, s.full_name) AS full_name, a.status, a.source, a.created_at`;

/** ACTIVE students first, dropped ones last. Nothing sits PENDING any more — see syncAllocationsFromErp. */
export async function listAllocations(unitId: string): Promise<Allocation[]> {
  const result = await query<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS}
       FROM unit_allocations a
       LEFT JOIN users s ON s.id = a.student_user_id
      WHERE a.unit_id = $1
      ORDER BY CASE a.status WHEN 'PENDING' THEN 0 WHEN 'ACTIVE' THEN 1 ELSE 2 END,
               a.registration_number NULLS LAST, full_name`,
    [unitId],
  );
  return result.rows.map(toAllocation);
}

export interface ErpEnrollment {
  registrationNumber: string;
  fullName: string;
}

/**
 * Reconciles a unit's roster with the ERP's enrollment list — this is how
 * students get onto a unit now, in place of a lecturer adding them or a
 * student self-enrolling. Each enrolled student is upserted ACTIVE with
 * source 'ERP'; an 'ERP'-sourced row that dropped off the ERP's list is
 * marked DROPPED (kept, not deleted, so past attendance keeps its context —
 * same reasoning as a lecturer-removed student previously). Rows from
 * another source (legacy lecturer-added or self-enrolled data, from before
 * this sync existed) are left untouched either way.
 */
export async function syncAllocationsFromErp(
  unitId: string,
  enrollments: ErpEnrollment[],
): Promise<void> {
  await transaction(async (client: PoolClient) => {
    for (const enrollment of enrollments) {
      await query(
        `INSERT INTO unit_allocations (unit_id, registration_number, full_name, status, source)
         VALUES ($1, $2, $3, 'ACTIVE', 'ERP')
         ON CONFLICT (unit_id, registration_number) WHERE registration_number IS NOT NULL
         DO UPDATE SET status = 'ACTIVE', full_name = EXCLUDED.full_name, source = 'ERP', updated_at = NOW()`,
        [unitId, enrollment.registrationNumber, enrollment.fullName],
        client,
      );
    }
    await query(
      `UPDATE unit_allocations
          SET status = 'DROPPED', updated_at = NOW()
        WHERE unit_id = $1 AND source = 'ERP' AND status = 'ACTIVE'
          AND NOT (registration_number = ANY($2::text[]))`,
      [unitId, enrollments.map((e) => e.registrationNumber)],
      client,
    );
  });
}

/**
 * For student registration to call once a student's account exists: attaches
 * the allocations synced from the ERP by registration number to that
 * account, so the student can check in. Skips any unit the student is
 * already linked to, which would otherwise break the
 * one-row-per-student-per-unit index.
 */
export async function linkAllocationsToStudent(
  studentUserId: string,
  registrationNumber: string,
): Promise<number> {
  const result = await query(
    `UPDATE unit_allocations a
        SET student_user_id = $1, updated_at = NOW()
      WHERE a.registration_number = $2
        AND a.student_user_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM unit_allocations b WHERE b.unit_id = a.unit_id AND b.student_user_id = $1
        )`,
    [studentUserId, registrationNumber.trim().toUpperCase()],
  );
  return result.rowCount ?? 0;
}

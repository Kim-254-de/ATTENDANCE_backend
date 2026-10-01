import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';
import type { AllocationStatus } from '../../db/types.js';

/** All SQL for the unit module. Every query is parameterised. */

export interface UnitSchedule {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/** One weekly meeting of a unit (unit_slots), with the room it is taught in. */
export interface UnitSlot extends UnitSchedule {
  /** rooms.code, as SMARTTT names it; null when the timetable names none. */
  roomCode: string | null;
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
  /**
   * The unit's weekly slot when it has exactly one; null when it meets more than once a week (see
   * `slots`). For the current unit (findCurrentUnitForLecturer), the meeting happening now.
   */
  schedule: UnitSchedule | null;
  /** Every weekly meeting, Monday first. What activation checks against. */
  slots: UnitSlot[];
  status: UnitVerificationStatus;
  /** The unit this class belongs to ("COSC 103" for "COSC 103 GR A"). Null for units only added by code. */
  baseCode: string | null;
  /** The teaching group ("GR A") when the unit is split into groups; null otherwise. */
  group: string | null;
  /** Students registered for this class this term, per SMARTTT. Null if SMARTTT has never reported it. */
  registeredStudents: number | null;
  /** For a group: students registered for the unit with no group picked yet, so on no group's roster. */
  studentsWithoutGroup: number | null;
  /** When SMARTTT last confirmed this unit for its lecturer. Null for units only added by code. */
  timetableSyncedAt: Date | null;
  /**
   * Where the unit's slot is taught, per SMARTTT, and whether that room's centre
   * point has been surveyed. Activate Class only asks for the lecturer's location
   * when it hasn't. Null when the timetable names no room.
   */
  room: { code: string; surveyed: boolean } | null;
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
  base_code: string | null;
  class_group: string | null;
  registered_students: number | null;
  students_without_group: number | null;
  timetable_synced_at: Date | null;
  room_code: string | null;
  room_surveyed: boolean;
  slots: UnitSlot[];
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
  baseCode: row.base_code,
  group: row.class_group,
  registeredStudents: row.registered_students,
  studentsWithoutGroup: row.students_without_group,
  timetableSyncedAt: row.timetable_synced_at,
  room: row.room_code === null ? null : { code: row.room_code, surveyed: row.room_surveyed },
  slots: row.slots,
});

const SELECT_UNIT_SUMMARY = `
  SELECT u.id, u.code, u.name, u.created_at, u.status, u.base_code, u.class_group,
         u.registered_students, u.students_without_group, u.timetable_synced_at,
         COUNT(a.id) FILTER (WHERE a.status = 'ACTIVE')::int  AS student_count,
         COUNT(a.id) FILTER (WHERE a.status = 'PENDING')::int AS pending_count,
         s.day_of_week, s.start_time, s.end_time, s.room_code,
         EXISTS (SELECT 1 FROM rooms r WHERE r.code = s.room_code AND r.latitude IS NOT NULL) AS room_surveyed,
         (SELECT COALESCE(json_agg(json_build_object(
                   'dayOfWeek', us.day_of_week,
                   'startTime', to_char(us.start_time, 'HH24:MI'),
                   'endTime', to_char(us.end_time, 'HH24:MI'),
                   'roomCode', us.room_code)
                 ORDER BY (us.day_of_week + 6) % 7, us.start_time), '[]'::json)
            FROM unit_slots us WHERE us.unit_id = u.id) AS slots
    FROM units u
    LEFT JOIN unit_allocations a ON a.unit_id = u.id
    LEFT JOIN unit_schedule s ON s.unit_id = u.id
`;
const GROUP_BY_UNIT_SUMMARY = 'GROUP BY u.id, s.day_of_week, s.start_time, s.end_time, s.room_code';
// u.status (and the other u.* columns) are functionally dependent on u.id (the primary key already in GROUP BY), so
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
 * The unit with a meeting on now, for this lecturer — the one `ActivateClass`
 * shows, if any — with `schedule` (and `room`) set to that meeting.
 *
 * Any of the unit's weekly meetings counts (unit_slots), not only a unit with
 * a single slot: most units meet more than once a week, and a class SMARTTT
 * has rescheduled for one programme but not another sits at two times.
 *
 * Excludes a unit still `PENDING_VERIFICATION`: `session.service.ts` would
 * refuse to activate a class for it anyway, so surfacing it here would only
 * hand the lecturer a button that 403s.
 *
 * `dayOfWeek`/`timeOfDay` are campus time, computed by the caller
 * (campusClock): slot times are timezone-naive `TIME` values in campus time,
 * and the database session's zone is usually UTC.
 */
export async function findCurrentUnitForLecturer(
  lecturerUserId: string,
  dayOfWeek: number,
  timeOfDay: string,
): Promise<UnitSummary | null> {
  const slot = await queryOne<{ unit_id: string; start_time: string; end_time: string; room_code: string | null; room_surveyed: boolean }>(
    `SELECT us.unit_id, us.start_time, us.end_time, us.room_code,
            EXISTS (SELECT 1 FROM rooms r WHERE r.code = us.room_code AND r.latitude IS NOT NULL) AS room_surveyed
       FROM unit_slots us
       JOIN units u ON u.id = us.unit_id
      WHERE u.lecturer_user_id = $1
        AND u.status = 'VERIFIED'
        AND us.day_of_week = $2
        AND $3::time BETWEEN us.start_time AND us.end_time
      ORDER BY us.start_time, u.code
      LIMIT 1`,
    [lecturerUserId, dayOfWeek, timeOfDay],
  );
  if (!slot) return null;
  const unit = await findUnitSummary(slot.unit_id);
  if (!unit) return null;
  return {
    ...unit,
    schedule: { dayOfWeek, startTime: slot.start_time.slice(0, 5), endTime: slot.end_time.slice(0, 5) },
    room: slot.room_code === null ? null : { code: slot.room_code, surveyed: slot.room_surveyed },
  };
}

/** Every weekly meeting of one unit, for the session-activation time gate. Empty for a unit with none. */
export async function findUnitSlots(unitId: string): Promise<UnitSlot[]> {
  const { rows } = await query<{ day_of_week: number; start_time: string; end_time: string; room_code: string | null }>(
    `SELECT day_of_week, start_time, end_time, room_code FROM unit_slots
      WHERE unit_id = $1 ORDER BY (day_of_week + 6) % 7, start_time`,
    [unitId],
  );
  return rows.map((r) => ({
    dayOfWeek: r.day_of_week,
    startTime: r.start_time.slice(0, 5),
    endTime: r.end_time.slice(0, 5),
    roomCode: r.room_code,
  }));
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
    await query(
      `INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time) VALUES ($1, $2, $3, $4)`,
      [row.id, schedule.dayOfWeek, schedule.startTime, schedule.endTime],
      client,
    );
    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Sync from SMARTTT (the university timetable)
// ---------------------------------------------------------------------------

export interface TimetableLecturer {
  userId: string;
  staffNumber: string;
  fullName: string;
}

/**
 * Who to re-sync when SMARTTT reports a class moved: the lecturer with that
 * staff number, plus whoever holds any of the named classes here (which
 * covers a unit tied to its lecturer only by name in SMARTTT). Active
 * lecturers with a staff number only, since the sync is keyed on it.
 */
export async function findLecturersForTimetableChange(
  staffNumber: string | null,
  unitCodes: string[],
): Promise<TimetableLecturer[]> {
  const { rows } = await query<{ id: string; staff_number: string; full_name: string }>(
    `SELECT DISTINCT u.id, p.staff_number, u.full_name
       FROM users u
       JOIN lecturer_profiles p ON p.user_id = u.id
      WHERE u.role = 'LECTURER' AND u.status = 'ACTIVE' AND p.staff_number IS NOT NULL
        AND (UPPER(p.staff_number) = UPPER($1)
             OR u.id IN (SELECT lecturer_user_id FROM units WHERE code = ANY($2::text[])))`,
    [staffNumber, unitCodes],
  );
  return rows.map((r) => ({ userId: r.id, staffNumber: r.staff_number, fullName: r.full_name }));
}

export interface TimetableUnit {
  /** The class: "COSC 103 GR A", or "COSC 103" when not split into groups. */
  code: string;
  baseCode: string;
  group: string | null;
  name: string;
  registeredStudents: number;
  studentsWithoutGroup: number;
  /** VERIFIED when SMARTTT links the unit to the lecturer's account; otherwise it waits for an admin. */
  status: UnitVerificationStatus;
  /** Only set when SMARTTT has exactly one weekly slot for the unit: unit_schedule holds one slot per unit. */
  schedule: UnitSchedule | null;
  /** Where that slot is taught (rooms.code). Only written alongside `schedule`. */
  roomCode: string | null;
  /** Every distinct weekly meeting SMARTTT lists, each with its room. Empty = SMARTTT names no times. */
  slots: UnitSlot[];
}

export interface TimetableUpsertResult {
  id: string;
  /** A new row, as opposed to an update of one this lecturer already had. */
  inserted: boolean;
  status: UnitVerificationStatus;
  /** The status before this sync; null for a new row. */
  previousStatus: UnitVerificationStatus | null;
}

/**
 * Creates or refreshes one of the lecturer's units from SMARTTT, with its
 * schedule, in one transaction.
 *
 * - A unit whose code another lecturer already holds is left alone and null
 *   is returned: units have one owner here, and a timetable sync must never
 *   quietly take a unit (and its attendance history) off someone else.
 * - Status only ever moves up. A unit an admin already verified stays
 *   VERIFIED even if SMARTTT now only matches it by name.
 * - `slots` replace the unit's unit_slots whenever SMARTTT lists any: they are
 *   what activation checks, so a meeting SMARTTT moved or dropped must not
 *   linger at its old time. No slots at all leaves everything untouched.
 * - unit_schedule (display only) is the one slot when there is exactly one,
 *   and is removed when SMARTTT lists several, rather than left at a time the
 *   class may no longer meet.
 * - Rooms are overwritten, null included: a room SMARTTT stops naming must
 *   not keep fencing the class to where it used to be taught.
 */
export async function upsertUnitFromTimetable(
  lecturerUserId: string,
  unit: TimetableUnit,
): Promise<TimetableUpsertResult | null> {
  return transaction(async (client: PoolClient) => {
    // `previous` reads the row as it was before this statement changed it.
    const row = await queryOne<{
      id: string;
      inserted: boolean;
      status: UnitVerificationStatus;
      previous_status: UnitVerificationStatus | null;
    }>(
      `WITH previous AS (SELECT status FROM units WHERE code = $1)
       INSERT INTO units (code, name, lecturer_user_id, status, registered_students,
                          base_code, class_group, students_without_group, timetable_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (code) DO UPDATE
          SET name                   = EXCLUDED.name,
              registered_students    = EXCLUDED.registered_students,
              base_code              = EXCLUDED.base_code,
              class_group            = EXCLUDED.class_group,
              students_without_group = EXCLUDED.students_without_group,
              timetable_synced_at = NOW(),
              status              = CASE WHEN EXCLUDED.status = 'VERIFIED' THEN 'VERIFIED' ELSE units.status END,
              updated_at          = NOW()
        WHERE units.lecturer_user_id = EXCLUDED.lecturer_user_id
       RETURNING id, (xmax = 0) AS inserted, status, (SELECT status FROM previous) AS previous_status`,
      [unit.code, unit.name, lecturerUserId, unit.status, unit.registeredStudents,
       unit.baseCode, unit.group, unit.studentsWithoutGroup],
      client,
    );
    if (!row) return null;

    if (unit.slots.length > 0) {
      await query(`DELETE FROM unit_slots WHERE unit_id = $1`, [row.id], client);
      for (const slot of unit.slots) {
        await query(
          `INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time, room_code) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (unit_id, day_of_week, start_time, end_time) DO NOTHING`,
          [row.id, slot.dayOfWeek, slot.startTime, slot.endTime, slot.roomCode],
          client,
        );
      }
      if (!unit.schedule) await query(`DELETE FROM unit_schedule WHERE unit_id = $1`, [row.id], client);
    }

    if (unit.schedule) {
      await query(
        `INSERT INTO unit_schedule (unit_id, day_of_week, start_time, end_time, room_code) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (unit_id) DO UPDATE
            SET day_of_week = EXCLUDED.day_of_week, start_time = EXCLUDED.start_time,
                end_time = EXCLUDED.end_time, room_code = EXCLUDED.room_code, updated_at = NOW()`,
        [row.id, unit.schedule.dayOfWeek, unit.schedule.startTime, unit.schedule.endTime, unit.roomCode],
        client,
      );
    }

    return {
      id: row.id,
      inserted: row.inserted,
      status: row.status,
      previousStatus: row.inserted ? null : row.previous_status,
    };
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
  source: AllocationSource;
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
  source: AllocationSource;
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

/** ACTIVE students first, dropped ones last. Nothing sits PENDING any more — see syncRosterAllocations. */
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

/**
 * Where a roster row came from. 'SMARTTT' (the timetable system's
 * registrations) and 'ERP' (the registrar's records) are synced; 'LECTURER'
 * and 'SELF_ENROLLED' are legacy rows from before rosters were synced.
 */
export type AllocationSource = 'LECTURER' | 'SELF_ENROLLED' | 'ERP' | 'SMARTTT';

/** The sources a roster sync owns: rows it may re-activate, re-label or drop. */
const SYNCED_SOURCES: AllocationSource[] = ['ERP', 'SMARTTT'];

export interface RosterEntry {
  registrationNumber: string;
  /** Null keeps whatever name the row already has. */
  fullName: string | null;
}

/**
 * Reconciles a unit's roster with an authoritative list — SMARTTT's
 * registrations when it is configured, otherwise the ERP's enrollments. This
 * is how students get onto a unit, in place of a lecturer adding them or a
 * student self-enrolling.
 *
 * Each listed student is upserted ACTIVE with the given source. A synced row
 * (source 'ERP' or 'SMARTTT') that is no longer listed is marked DROPPED —
 * kept, not deleted, so past attendance keeps its context. Only one of the
 * two is ever the authority for a deployment, so a switch from the mock ERP
 * to SMARTTT drops the mock students rather than leaving them on the roster.
 * Legacy lecturer-added or self-enrolled rows are left untouched either way.
 */
export async function syncRosterAllocations(
  unitId: string,
  entries: RosterEntry[],
  source: 'ERP' | 'SMARTTT',
): Promise<void> {
  await transaction(async (client: PoolClient) => {
    for (const entry of entries) {
      await query(
        `INSERT INTO unit_allocations (unit_id, registration_number, full_name, status, source)
         VALUES ($1, $2, $3, 'ACTIVE', $4)
         ON CONFLICT (unit_id, registration_number) WHERE registration_number IS NOT NULL
         DO UPDATE SET status = 'ACTIVE',
                       full_name = COALESCE(EXCLUDED.full_name, unit_allocations.full_name),
                       source = EXCLUDED.source,
                       updated_at = NOW()`,
        [unitId, entry.registrationNumber, entry.fullName, source],
        client,
      );
    }
    await query(
      `UPDATE unit_allocations
          SET status = 'DROPPED', updated_at = NOW()
        WHERE unit_id = $1 AND source = ANY($2::text[]) AND status = 'ACTIVE'
          AND NOT (registration_number = ANY($3::text[]))`,
      [unitId, SYNCED_SOURCES, entries.map((e) => e.registrationNumber)],
      client,
    );
  });
}

/**
 * For student registration to call once a student's account exists: attaches
 * the allocations synced from SMARTTT or the ERP by registration number to that
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

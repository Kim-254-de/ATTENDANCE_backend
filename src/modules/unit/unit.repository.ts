import { query, queryOne } from '../../db/database.js';
import type { AllocationStatus } from '../../db/types.js';

/** All SQL for the unit module. Every query is parameterised. */

export interface UnitSummary {
  id: string;
  code: string;
  name: string | null;
  /** Students who can check in. */
  studentCount: number;
  /** Self-enrolment requests waiting for the lecturer. */
  pendingCount: number;
  createdAt: Date;
}

interface UnitSummaryRow {
  id: string;
  code: string;
  name: string | null;
  student_count: number;
  pending_count: number;
  created_at: Date;
}

const toUnitSummary = (row: UnitSummaryRow): UnitSummary => ({
  id: row.id,
  code: row.code,
  name: row.name,
  studentCount: row.student_count,
  pendingCount: row.pending_count,
  createdAt: row.created_at,
});

const SELECT_UNIT_SUMMARY = `
  SELECT u.id, u.code, u.name, u.created_at,
         COUNT(a.id) FILTER (WHERE a.status = 'ACTIVE')::int  AS student_count,
         COUNT(a.id) FILTER (WHERE a.status = 'PENDING')::int AS pending_count
    FROM units u
    LEFT JOIN unit_allocations a ON a.unit_id = u.id
`;

export async function findUnitsForLecturer(lecturerUserId: string): Promise<UnitSummary[]> {
  const result = await query<UnitSummaryRow>(
    `${SELECT_UNIT_SUMMARY} WHERE u.lecturer_user_id = $1 GROUP BY u.id ORDER BY u.code`,
    [lecturerUserId],
  );
  return result.rows.map(toUnitSummary);
}

export async function findUnitSummary(unitId: string): Promise<UnitSummary | null> {
  const row = await queryOne<UnitSummaryRow>(
    `${SELECT_UNIT_SUMMARY} WHERE u.id = $1 GROUP BY u.id`,
    [unitId],
  );
  return row ? toUnitSummary(row) : null;
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
): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [code, name, lecturerUserId],
  );
  if (!row) throw new Error('units insert returned no row');
  return row.id;
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
  source: 'LECTURER' | 'SELF_ENROLLED';
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
  source: 'LECTURER' | 'SELF_ENROLLED';
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

/** Pending requests first — they are the ones waiting on the lecturer. */
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

export type AllocateOutcome = 'ADDED' | 'RESTORED' | 'ALREADY_ALLOCATED';

/**
 * Puts a registration number on a unit as ACTIVE.
 *
 * The upsert is what makes two concurrent "add" requests safe; a previously
 * DROPPED student is restored rather than duplicated. `xmax = 0` is true only
 * for a freshly inserted row, which is how an insert is told apart from an update.
 */
export async function allocateByRegistrationNumber(args: {
  unitId: string;
  registrationNumber: string;
  fullName: string;
  addedByUserId: string;
}): Promise<AllocateOutcome> {
  const row = await queryOne<{ inserted: boolean }>(
    `INSERT INTO unit_allocations
       (unit_id, registration_number, full_name, status, source, added_by_user_id)
     VALUES ($1, $2, $3, 'ACTIVE', 'LECTURER', $4)
     ON CONFLICT (unit_id, registration_number) WHERE registration_number IS NOT NULL
     DO UPDATE SET status = 'ACTIVE', full_name = EXCLUDED.full_name, updated_at = NOW()
       WHERE unit_allocations.status <> 'ACTIVE'
     RETURNING (xmax = 0) AS inserted`,
    [args.unitId, args.registrationNumber, args.fullName, args.addedByUserId],
  );
  if (!row) return 'ALREADY_ALLOCATED';
  return row.inserted ? 'ADDED' : 'RESTORED';
}

export async function findAllocation(
  unitId: string,
  allocationId: string,
): Promise<Allocation | null> {
  const row = await queryOne<AllocationRow>(
    `SELECT ${ALLOCATION_COLUMNS}
       FROM unit_allocations a
       LEFT JOIN users s ON s.id = a.student_user_id
      WHERE a.unit_id = $1 AND a.id = $2`,
    [unitId, allocationId],
  );
  return row ? toAllocation(row) : null;
}

export async function setAllocationStatus(
  allocationId: string,
  status: AllocationStatus,
): Promise<void> {
  await query(`UPDATE unit_allocations SET status = $2, updated_at = NOW() WHERE id = $1`, [
    allocationId,
    status,
  ]);
}

export type EnrolOutcome = 'REQUESTED' | 'ALREADY_REQUESTED' | 'ALREADY_ACTIVE' | 'DROPPED';

/**
 * Records a student's request to join. Never upgrades an existing row: a
 * student the lecturer dropped cannot put themselves back by re-requesting.
 */
export async function requestEnrolment(
  unitId: string,
  studentUserId: string,
): Promise<EnrolOutcome> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, student_user_id, status, source, added_by_user_id)
     VALUES ($1, $2, 'PENDING', 'SELF_ENROLLED', $2)
     ON CONFLICT (unit_id, student_user_id) WHERE student_user_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [unitId, studentUserId],
  );
  if (inserted) return 'REQUESTED';

  const existing = await queryOne<{ status: AllocationStatus }>(
    `SELECT status FROM unit_allocations WHERE unit_id = $1 AND student_user_id = $2`,
    [unitId, studentUserId],
  );
  if (existing?.status === 'ACTIVE') return 'ALREADY_ACTIVE';
  if (existing?.status === 'DROPPED') return 'DROPPED';
  return 'ALREADY_REQUESTED';
}

/**
 * For student registration to call once a student's account exists: attaches
 * the allocations a lecturer made by registration number to that account, so
 * the student can check in. Skips any unit the student already self-enrolled
 * on, which would otherwise break the one-row-per-student-per-unit index.
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

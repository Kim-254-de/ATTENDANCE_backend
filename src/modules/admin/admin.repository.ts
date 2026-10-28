import { query, queryOne, transaction } from '../../db/database.js';

/** SQL for the admin module. Every value goes through a bind parameter. */

export async function findDepartmentName(departmentId: string): Promise<string | null> {
  const row = await queryOne<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [departmentId]);
  return row?.name ?? null;
}

export interface PendingUnitRow {
  unitId: string;
  code: string;
  name: string | null;
  lecturerName: string;
  staffNumber: string | null;
  departmentName: string | null;
  createdAt: string;
  /** Weekly meetings, Monday first. Empty for a unit the timetable has no slot for. */
  slots: { dayOfWeek: number; startTime: string; endTime: string; roomCode: string | null }[];
}

/** Units waiting for an administrator to confirm the lecturer is allocated to teach them, oldest first. */
export async function listPendingUnits(): Promise<PendingUnitRow[]> {
  const { rows } = await query<{
    id: string; code: string; name: string | null; lecturer_name: string; staff_number: string | null;
    department_name: string | null; created_at: Date;
    slots: { dayOfWeek: number; startTime: string; endTime: string; roomCode: string | null }[];
  }>(
    `SELECT u.id, u.code, u.name, lu.full_name AS lecturer_name, lp.staff_number,
            COALESCE(d.name, lp.department) AS department_name, u.created_at,
            COALESCE((SELECT json_agg(json_build_object(
                        'dayOfWeek', us.day_of_week,
                        'startTime', to_char(us.start_time, 'HH24:MI'),
                        'endTime', to_char(us.end_time, 'HH24:MI'),
                        'roomCode', us.room_code)
                      ORDER BY (us.day_of_week + 6) % 7, us.start_time)
                        FROM unit_slots us WHERE us.unit_id = u.id), '[]'::json) AS slots
       FROM units u
       JOIN users lu ON lu.id = u.lecturer_user_id
       LEFT JOIN lecturer_profiles lp ON lp.user_id = u.lecturer_user_id
       LEFT JOIN departments d ON d.id = lp.department_id
      WHERE u.status = 'PENDING_VERIFICATION'
      ORDER BY u.created_at, u.code`,
  );
  return rows.map((r) => ({
    unitId: r.id,
    code: r.code,
    name: r.name,
    lecturerName: r.lecturer_name,
    staffNumber: r.staff_number,
    departmentName: r.department_name,
    createdAt: r.created_at.toISOString(),
    slots: r.slots,
  }));
}

/**
 * Moves a pending unit to VERIFIED. Null when the unit doesn't exist;
 * `verified: false` when it was already verified (nothing changed).
 */
export async function verifyUnit(unitId: string): Promise<{ code: string; lecturerUserId: string; verified: boolean } | null> {
  const updated = await queryOne<{ code: string; lecturer_user_id: string }>(
    `UPDATE units SET status = 'VERIFIED' WHERE id = $1 AND status = 'PENDING_VERIFICATION' RETURNING code, lecturer_user_id`,
    [unitId],
  );
  if (updated) return { code: updated.code, lecturerUserId: updated.lecturer_user_id, verified: true };
  const existing = await queryOne<{ code: string; lecturer_user_id: string }>(
    `SELECT code, lecturer_user_id FROM units WHERE id = $1`,
    [unitId],
  );
  return existing ? { code: existing.code, lecturerUserId: existing.lecturer_user_id, verified: false } : null;
}

export interface DepartmentRow {
  departmentId: string;
  name: string;
  /** Unique across the university; null for one made before codes existed. */
  code: string | null;
  /** Linked to SMARTTT's department; false for one that only exists here. */
  inSmarttt: boolean;
  lecturerCount: number;
}

/** Every department with its code: the admin's list, and what it picks from when placing a lecturer. */
export async function listDepartments(): Promise<DepartmentRow[]> {
  const { rows } = await query<{ id: string; name: string; code: string | null; in_smarttt: boolean; lecturer_count: number }>(
    `SELECT d.id, d.name, d.code, (d.smarttt_department_id IS NOT NULL) AS in_smarttt,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.deleted_at IS NULL)::int AS lecturer_count
       FROM departments d
      ORDER BY d.name`,
  );
  return rows.map((r) => ({
    departmentId: r.id,
    name: r.name,
    code: r.code,
    inSmarttt: r.in_smarttt,
    lecturerCount: r.lecturer_count,
  }));
}

export interface DepartmentAliasRow {
  aliasId: string;
  alias: string;
  departmentId: string;
  departmentName: string;
  source: 'PLACEMENT' | 'MERGE';
  createdByName: string | null;
  createdAt: Date;
}

/** Every learned spelling, grouped by the department it means (`db/migrations/036_department_spelling.sql`). */
export async function listDepartmentAliases(): Promise<DepartmentAliasRow[]> {
  const { rows } = await query<{
    id: string; alias: string; department_id: string; department_name: string;
    source: 'PLACEMENT' | 'MERGE'; created_by_name: string | null; created_at: Date;
  }>(
    `SELECT a.id, a.alias, d.id AS department_id, d.name AS department_name,
            a.source, u.full_name AS created_by_name, a.created_at
       FROM department_aliases a
       JOIN departments d ON d.id = a.department_id
  LEFT JOIN users u ON u.id = a.created_by_user_id
      ORDER BY d.name, a.alias`,
  );
  return rows.map((r) => ({
    aliasId: r.id, alias: r.alias, departmentId: r.department_id, departmentName: r.department_name,
    source: r.source, createdByName: r.created_by_name, createdAt: r.created_at,
  }));
}

export async function deleteDepartmentAlias(aliasId: string): Promise<{ alias: string; departmentId: string } | null> {
  return queryOne<{ alias: string; departmentId: string }>(
    `DELETE FROM department_aliases WHERE id = $1 RETURNING alias, department_id AS "departmentId"`,
    [aliasId],
  );
}

export interface DuplicateDepartmentRow {
  departmentId: string;
  name: string;
  code: string | null;
  lecturerCount: number;
  unitCount: number;
}

/**
 * Departments whose names mean the same thing ("Computer Science" and
 * "Department of Computer Science"), in groups of two or more, each with
 * enough counts to decide which one to keep.
 */
export async function listDuplicateDepartments(): Promise<DuplicateDepartmentRow[][]> {
  const { rows } = await query<{
    key: string; id: string; name: string; code: string | null; lecturer_count: number; unit_count: number;
  }>(
    `SELECT department_key(d.name) AS key, d.id, d.name, d.code,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.deleted_at IS NULL)::int AS lecturer_count,
            (SELECT COUNT(*) FROM units un WHERE un.department_id = d.id)::int AS unit_count
       FROM departments d
      WHERE department_key(d.name) IN (
              SELECT department_key(name) FROM departments GROUP BY 1 HAVING COUNT(*) > 1)
      ORDER BY key, lecturer_count DESC, unit_count DESC, d.name`,
  );
  const groups = new Map<string, DuplicateDepartmentRow[]>();
  for (const r of rows) {
    groups.set(r.key, [...(groups.get(r.key) ?? []), {
      departmentId: r.id, name: r.name, code: r.code,
      lecturerCount: r.lecturer_count, unitCount: r.unit_count,
    }]);
  }
  return [...groups.values()];
}

/** Runs `merge_departments` in its own transaction. */
export async function mergeDepartments(duplicateId: string, keepId: string, actorUserId: string): Promise<void> {
  await transaction(async (client) => {
    await query(`SELECT merge_departments($1, $2, $3)`, [duplicateId, keepId, actorUserId], client);
  });
}

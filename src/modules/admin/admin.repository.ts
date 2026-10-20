import { query, queryOne, transaction } from '../../db/database.js';

/** SQL for the admin module. Every value goes through a bind parameter. */

export interface FacultyRow {
  facultyId: string;
  name: string;
  departmentCount: number;
  /** Active and invited faculty officers. */
  officerCount: number;
}

export async function listFaculties(): Promise<FacultyRow[]> {
  const { rows } = await query<{ id: string; name: string; department_count: number; officer_count: number }>(
    `SELECT f.id, f.name,
            (SELECT COUNT(*) FROM departments d WHERE d.faculty_id = f.id)::int AS department_count,
            (SELECT COUNT(*) FROM faculty_profiles fp JOIN users u ON u.id = fp.user_id
              WHERE fp.faculty_id = f.id AND u.deleted_at IS NULL AND u.status <> 'DEACTIVATED')::int AS officer_count
       FROM faculties f
      ORDER BY f.name`,
  );
  return rows.map((r) => ({ facultyId: r.id, name: r.name, departmentCount: r.department_count, officerCount: r.officer_count }));
}

export async function findFacultyName(facultyId: string): Promise<string | null> {
  const row = await queryOne<{ name: string }>(`SELECT name FROM faculties WHERE id = $1`, [facultyId]);
  return row?.name ?? null;
}

export async function createFaculty(name: string): Promise<{ id: string; name: string }> {
  const { rows: [row] } = await query<{ id: string; name: string }>(
    `INSERT INTO faculties (name) VALUES ($1) RETURNING id, name`,
    [name],
  );
  return row!;
}

export interface DepartmentRow {
  departmentId: string;
  name: string;
  facultyId: string | null;
  facultyName: string | null;
  lecturerCount: number;
}

/** Every department, with its faculty — what an administrator picks from when placing a lecturer. */
export async function listDepartments(): Promise<DepartmentRow[]> {
  const { rows } = await query<{ id: string; name: string; faculty_id: string | null; faculty_name: string | null; lecturer_count: number }>(
    `SELECT d.id, d.name, f.id AS faculty_id, f.name AS faculty_name,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.deleted_at IS NULL)::int AS lecturer_count
       FROM departments d
  LEFT JOIN faculties f ON f.id = d.faculty_id
      ORDER BY f.name NULLS LAST, d.name`,
  );
  return rows.map((r) => ({
    departmentId: r.id,
    name: r.name,
    facultyId: r.faculty_id,
    facultyName: r.faculty_name,
    lecturerCount: r.lecturer_count,
  }));
}

export interface DepartmentAliasRow {
  aliasId: string;
  alias: string;
  departmentId: string;
  departmentName: string;
  facultyName: string | null;
  source: 'PLACEMENT' | 'MERGE';
  createdByName: string | null;
  createdAt: Date;
}

/** Every learned spelling, grouped by the department it means (`db/migrations/036_department_spelling.sql`). */
export async function listDepartmentAliases(): Promise<DepartmentAliasRow[]> {
  const { rows } = await query<{
    id: string; alias: string; department_id: string; department_name: string; faculty_name: string | null;
    source: 'PLACEMENT' | 'MERGE'; created_by_name: string | null; created_at: Date;
  }>(
    `SELECT a.id, a.alias, d.id AS department_id, d.name AS department_name, f.name AS faculty_name,
            a.source, u.full_name AS created_by_name, a.created_at
       FROM department_aliases a
       JOIN departments d ON d.id = a.department_id
  LEFT JOIN faculties f ON f.id = d.faculty_id
  LEFT JOIN users u ON u.id = a.created_by_user_id
      ORDER BY d.name, a.alias`,
  );
  return rows.map((r) => ({
    aliasId: r.id, alias: r.alias, departmentId: r.department_id, departmentName: r.department_name, facultyName: r.faculty_name,
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
  facultyId: string | null;
  facultyName: string | null;
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
    key: string; id: string; name: string; faculty_id: string | null; faculty_name: string | null; lecturer_count: number; unit_count: number;
  }>(
    `SELECT department_key(d.name) AS key, d.id, d.name, f.id AS faculty_id, f.name AS faculty_name,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.deleted_at IS NULL)::int AS lecturer_count,
            (SELECT COUNT(*) FROM units un WHERE un.department_id = d.id)::int AS unit_count
       FROM departments d
  LEFT JOIN faculties f ON f.id = d.faculty_id
      WHERE department_key(d.name) IN (
              SELECT department_key(name) FROM departments GROUP BY 1 HAVING COUNT(*) > 1)
      ORDER BY key, lecturer_count DESC, unit_count DESC, d.name`,
  );
  const groups = new Map<string, DuplicateDepartmentRow[]>();
  for (const r of rows) {
    groups.set(r.key, [...(groups.get(r.key) ?? []), {
      departmentId: r.id, name: r.name, facultyId: r.faculty_id, facultyName: r.faculty_name,
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

import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';

/** SQL for attendance's copy of SMARTTT's departments (directory.service.ts). Every value is a bind parameter. */

export interface LocalDepartment {
  id: string;
  name: string;
  /** Unique across the university (case-insensitive); null for one made here before codes existed. */
  code: string | null;
  smartttId: number | null;
}

export async function listDepartments(client?: PoolClient): Promise<LocalDepartment[]> {
  const { rows } = await query<{ id: string; name: string; code: string | null; smarttt_department_id: number | null }>(
    `SELECT id, name, code, smarttt_department_id FROM departments ORDER BY name`,
    [],
    client,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, code: r.code, smartttId: r.smarttt_department_id }));
}

/** The department holding this code, if any (case-insensitive). */
export async function findByCode(code: string, client?: PoolClient): Promise<LocalDepartment | null> {
  const row = await queryOne<{ id: string; name: string; code: string | null; smarttt_department_id: number | null }>(
    `SELECT id, name, code, smarttt_department_id FROM departments WHERE upper(code) = upper($1)`,
    [code],
    client,
  );
  return row ? { id: row.id, name: row.name, code: row.code, smartttId: row.smarttt_department_id } : null;
}

/**
 * The department this name means, if any: the same canonical name or a
 * learned spelling (department_for_name, 036_department_spelling.sql), so
 * "Department of Computer Science" finds "Computer Science".
 */
export async function findForName(name: string): Promise<{ id: string; name: string } | null> {
  return queryOne<{ id: string; name: string }>(`SELECT d.id, d.name FROM departments d WHERE d.id = department_for_name($1)`, [name]);
}

/** Links a local department to SMARTTT's and takes SMARTTT's name and code. */
export async function linkDepartment(client: PoolClient, id: string, smartttId: number, name: string, code: string | null): Promise<void> {
  await query(
    `UPDATE departments
        SET smarttt_department_id = $2, name = $3, code = COALESCE($4, code), updated_at = NOW()
      WHERE id = $1`,
    [id, smartttId, name, code],
    client,
  );
}

/** A new department here (one created in or read from SMARTTT, or local while SMARTTT is off). */
export async function insertDepartment(
  client: PoolClient | undefined,
  name: string,
  code: string | null,
  smartttId: number | null,
): Promise<string> {
  if (!client) return transaction((tx) => insertDepartment(tx, name, code, smartttId));
  const { rows: [row] } = await query<{ id: string }>(
    `INSERT INTO departments (name, code, smarttt_department_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, code, smartttId],
    client,
  );
  // Unassigned lecturers whose SMARTTT department name means this one are
  // placed in it at once, the same match sign-in makes (department_for_name,
  // db/migrations/036_department_spelling.sql): they signed in before it existed.
  await query(
    `UPDATE lecturer_profiles SET department_id = $1, updated_at = NOW()
      WHERE department_id IS NULL AND department_for_name(department) = $1`,
    [row!.id],
    client,
  );
  return row!.id;
}

/** One department, by id. */
export async function findDepartment(id: string, client?: PoolClient): Promise<LocalDepartment | null> {
  const row = await queryOne<{ id: string; name: string; code: string | null; smarttt_department_id: number | null }>(
    `SELECT id, name, code, smarttt_department_id FROM departments WHERE id = $1`,
    [id],
    client,
  );
  return row ? { id: row.id, name: row.name, code: row.code, smartttId: row.smarttt_department_id } : null;
}

/** An administrator's correction of the name and code. */
export async function renameDepartment(id: string, name: string, code: string, client?: PoolClient): Promise<void> {
  await query(`UPDATE departments SET name = $2, code = $3, updated_at = NOW() WHERE id = $1`, [id, name, code], client);
}

export async function setDepartmentSmartttId(id: string, smartttId: number, code: string | null): Promise<void> {
  await query(
    `UPDATE departments SET smarttt_department_id = $2, code = COALESCE($3, code), updated_at = NOW() WHERE id = $1`,
    [id, smartttId, code],
  );
}

export interface DepartmentForTimetabling {
  id: string;
  name: string;
  code: string | null;
  smartttDepartmentId: number | null;
  /** Active lecturers placed in the department here. */
  lecturerCount: number;
}

/** Every department, for the Timetable Generator and Allocator (src/modules/integration). */
export async function listDepartmentsForTimetabling(): Promise<DepartmentForTimetabling[]> {
  const { rows } = await query<{
    id: string; name: string; code: string | null; smarttt_department_id: number | null; lecturer_count: number;
  }>(
    `SELECT d.id, d.name, d.code, d.smarttt_department_id,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL)::int AS lecturer_count
       FROM departments d
      ORDER BY d.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    smartttDepartmentId: r.smarttt_department_id,
    lecturerCount: r.lecturer_count,
  }));
}

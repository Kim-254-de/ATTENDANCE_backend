import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../../db/database.js';

/** SQL for attendance's copy of SMARTTT's faculties and departments (directory.service.ts). Every value is a bind parameter. */

export interface LocalFaculty {
  id: string;
  name: string;
  smartttId: number | null;
}

export interface LocalDepartment {
  id: string;
  name: string;
  facultyId: string | null;
  smartttId: number | null;
}

export async function listFaculties(client?: PoolClient): Promise<LocalFaculty[]> {
  const { rows } = await query<{ id: string; name: string; smarttt_faculty_id: number | null }>(
    `SELECT id, name, smarttt_faculty_id FROM faculties ORDER BY name`,
    [],
    client,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, smartttId: r.smarttt_faculty_id }));
}

export async function listDepartments(client?: PoolClient): Promise<LocalDepartment[]> {
  const { rows } = await query<{ id: string; name: string; faculty_id: string | null; smarttt_department_id: number | null }>(
    `SELECT id, name, faculty_id, smarttt_department_id FROM departments ORDER BY name`,
    [],
    client,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, facultyId: r.faculty_id, smartttId: r.smarttt_department_id }));
}

export async function findFaculty(id: string): Promise<LocalFaculty | null> {
  const row = await queryOne<{ id: string; name: string; smarttt_faculty_id: number | null }>(
    `SELECT id, name, smarttt_faculty_id FROM faculties WHERE id = $1`,
    [id],
  );
  return row ? { id: row.id, name: row.name, smartttId: row.smarttt_faculty_id } : null;
}

/** Links a local faculty to SMARTTT's and takes SMARTTT's name. */
export async function linkFaculty(client: PoolClient, id: string, smartttId: number, name: string): Promise<void> {
  await query(
    `UPDATE faculties SET smarttt_faculty_id = $2, name = $3, updated_at = NOW() WHERE id = $1`,
    [id, smartttId, name],
    client,
  );
}

export async function insertFaculty(client: PoolClient | undefined, name: string, smartttId: number | null): Promise<string> {
  const { rows: [row] } = await query<{ id: string }>(
    `INSERT INTO faculties (name, smarttt_faculty_id) VALUES ($1, $2) RETURNING id`,
    [name, smartttId],
    client,
  );
  return row!.id;
}

/** Links a local department to SMARTTT's and takes SMARTTT's name and faculty. */
export async function linkDepartment(
  client: PoolClient,
  id: string,
  smartttId: number,
  name: string,
  facultyId: string | null,
): Promise<void> {
  await query(
    `UPDATE departments
        SET smarttt_department_id = $2, name = $3, faculty_id = COALESCE($4, faculty_id), updated_at = NOW()
      WHERE id = $1`,
    [id, smartttId, name, facultyId],
    client,
  );
}

/** A new department here (one created in or read from SMARTTT, or local while SMARTTT is off). */
export async function insertDepartment(
  client: PoolClient | undefined,
  name: string,
  facultyId: string | null,
  smartttId: number | null,
): Promise<string> {
  if (!client) return transaction((tx) => insertDepartment(tx, name, facultyId, smartttId));
  const { rows: [row] } = await query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id, smarttt_department_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, facultyId, smartttId],
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

export async function setFacultySmartttId(id: string, smartttId: number): Promise<void> {
  await query(`UPDATE faculties SET smarttt_faculty_id = $2, updated_at = NOW() WHERE id = $1`, [id, smartttId]);
}

export async function setDepartmentSmartttId(id: string, smartttId: number): Promise<void> {
  await query(`UPDATE departments SET smarttt_department_id = $2, updated_at = NOW() WHERE id = $1`, [id, smartttId]);
}

export interface DepartmentForTimetabling {
  id: string;
  name: string;
  facultyId: string | null;
  facultyName: string | null;
  smartttDepartmentId: number | null;
  /** Active lecturers placed in the department here. */
  lecturerCount: number;
}

/** Every department, for the Timetable Generator (src/modules/integration). */
export async function listDepartmentsForTimetabling(): Promise<DepartmentForTimetabling[]> {
  const { rows } = await query<{
    id: string; name: string; faculty_id: string | null; faculty_name: string | null;
    smarttt_department_id: number | null; lecturer_count: number;
  }>(
    `SELECT d.id, d.name, d.faculty_id, f.name AS faculty_name, d.smarttt_department_id,
            (SELECT COUNT(*) FROM lecturer_profiles lp JOIN users u ON u.id = lp.user_id
              WHERE lp.department_id = d.id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL)::int AS lecturer_count
       FROM departments d
  LEFT JOIN faculties f ON f.id = d.faculty_id
      ORDER BY d.name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    facultyId: r.faculty_id,
    facultyName: r.faculty_name,
    smartttDepartmentId: r.smarttt_department_id,
    lecturerCount: r.lecturer_count,
  }));
}

import { query, queryOne } from '../../db/database.js';

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

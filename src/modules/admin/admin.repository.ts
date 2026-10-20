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

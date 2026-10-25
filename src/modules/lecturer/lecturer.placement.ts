import { query, queryOne, transaction } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import type { RegistrationContext } from '../auth/auth.service.js';

/**
 * Which department a lecturer belongs to, set by hand.
 *
 * Sign-in places a lecturer by matching SMARTTT's department name
 * (`auth.repository.ts DEPARTMENT_BY_NAME`). When nothing matches, the
 * lecturer is left unassigned rather than a department being invented, and
 * an administrator places them here. The same call moves
 * a lecturer who changed departments. Sign-in never overrides a placement.
 *
 * Placing an unassigned lecturer also teaches the system their SMARTTT
 * spelling: it is saved as an alias of the chosen department
 * (`department_aliases`), and every other unassigned lecturer with the same
 * spelling is placed with them. So "Comp. Sci & IT" needs placing by hand
 * once, not once per lecturer.
 *
 * Moving a lecturer moves their staff membership only. Their units stay with
 * the departments that own them (`db/migrations/033_unit_owning_department.sql`);
 * units with no owner yet follow them into the new department.
 *
 * Used by `admin.service.ts`, which checks who may call it.
 */

export interface PlacementLecturerRow {
  userId: string;
  fullName: string;
  staffNumber: string;
  title: string | null;
  email: string;
  departmentId: string | null;
  departmentName: string | null;
  /** The department name SMARTTT/ERP gave at sign-in, to help decide where an unassigned lecturer goes. */
  reportedDepartment: string | null;
  unitCount: number;
}

const PLACEMENT_SELECT = `
  SELECT lp.user_id, usr.full_name, lp.staff_number, lp.title, usr.email,
         d.id AS department_id, d.name AS department_name,
         lp.department AS reported_department,
         (SELECT COUNT(*) FROM units un WHERE un.lecturer_user_id = lp.user_id)::int AS unit_count
    FROM lecturer_profiles lp
    JOIN users usr ON usr.id = lp.user_id
LEFT JOIN departments d ON d.id = lp.department_id`;

interface PlacementDbRow {
  user_id: string;
  full_name: string;
  staff_number: string;
  title: string | null;
  email: string;
  department_id: string | null;
  department_name: string | null;
  reported_department: string | null;
  unit_count: number;
}

const toRow = (r: PlacementDbRow): PlacementLecturerRow => ({
  userId: r.user_id,
  fullName: r.full_name,
  staffNumber: r.staff_number,
  title: r.title,
  email: r.email,
  departmentId: r.department_id,
  departmentName: r.department_name,
  reportedDepartment: r.reported_department,
  unitCount: r.unit_count,
});

/**
 * Lecturers to place, newest problems first: unassigned ones, then everyone
 * else. `unassignedOnly` drops the second group. Capped by `limit`.
 */
export async function listLecturers(options: {
  unassignedOnly?: boolean;
  search?: string | null;
  limit: number;
}): Promise<PlacementLecturerRow[]> {
  const { rows } = await query<PlacementDbRow>(
    `${PLACEMENT_SELECT}
      WHERE usr.deleted_at IS NULL
        AND (lp.department_id IS NULL OR NOT $1::boolean)
        AND ($2::text IS NULL OR usr.full_name ILIKE '%' || $2 || '%' OR lp.staff_number ILIKE '%' || $2 || '%')
      ORDER BY (lp.department_id IS NOT NULL), usr.full_name
      LIMIT $3`,
    [options.unassignedOnly ?? false, options.search ?? null, options.limit],
  );
  return rows.map(toRow);
}

export async function findLecturer(lecturerUserId: string): Promise<PlacementLecturerRow | null> {
  const row = await queryOne<PlacementDbRow>(
    `${PLACEMENT_SELECT} WHERE lp.user_id = $1 AND usr.deleted_at IS NULL`,
    [lecturerUserId],
  );
  return row ? toRow(row) : null;
}

export async function findDepartment(departmentId: string): Promise<{ id: string; name: string } | null> {
  return queryOne<{ id: string; name: string }>(`SELECT id, name FROM departments WHERE id = $1`, [departmentId]);
}

export interface MoveResult extends PlacementLecturerRow {
  /** SMARTTT's spelling, now an alias of the department; null when nothing new was learned. */
  learnedSpelling: string | null;
  /** Other unassigned lecturers with that spelling, placed in the same department along with this one. */
  alsoPlaced: number;
}

/**
 * Puts the lecturer in `department`, audited with who did it. The units
 * trigger (`lecturer_department_claims_units`) hands them any unowned units.
 * For a lecturer who was unassigned, their SMARTTT spelling becomes an alias
 * of the department unless it already means some department.
 */
export async function moveLecturer(
  lecturer: PlacementLecturerRow,
  department: { id: string; name: string },
  actor: { userId: string; kind: 'ADMIN' },
  context: RegistrationContext,
): Promise<MoveResult> {
  const { learnedSpelling, alsoPlaced } = await transaction(async (client) => {
    await query(`UPDATE lecturer_profiles SET department_id = $2, updated_at = NOW() WHERE user_id = $1`, [lecturer.userId, department.id], client);
    if (lecturer.departmentId !== null || !lecturer.reportedDepartment) return { learnedSpelling: null, alsoPlaced: 0 };

    const alias = await queryOne<{ alias: string }>(
      `INSERT INTO department_aliases (alias_key, alias, department_id, source, created_by_user_id)
       SELECT department_key($1), $1, $2, 'PLACEMENT', $3
        WHERE department_key($1) IS NOT NULL AND department_for_name($1) IS NULL
       ON CONFLICT (alias_key) DO NOTHING
       RETURNING alias`,
      [lecturer.reportedDepartment, department.id, actor.userId],
      client,
    );
    if (!alias) return { learnedSpelling: null, alsoPlaced: 0 };
    const placed = await query(
      `UPDATE lecturer_profiles SET department_id = $1, updated_at = NOW()
        WHERE department_id IS NULL AND department_for_name(department) = $1 AND user_id <> $2`,
      [department.id, lecturer.userId],
      client,
    );
    return { learnedSpelling: alias.alias, alsoPlaced: placed.rowCount ?? 0 };
  });

  await auditService.record({
    action: 'LECTURER_DEPARTMENT_CHANGED',
    outcome: 'SUCCESS',
    userId: actor.userId,
    subjectStaffNumber: lecturer.staffNumber,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      lecturerUserId: lecturer.userId,
      by: actor.kind,
      fromDepartmentId: lecturer.departmentId,
      fromDepartmentName: lecturer.departmentName,
      toDepartmentId: department.id,
      toDepartmentName: department.name,
      learnedSpelling,
      alsoPlaced,
    },
  });
  return { ...(await findLecturer(lecturer.userId))!, learnedSpelling, alsoPlaced };
}

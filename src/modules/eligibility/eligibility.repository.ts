import { query, queryOne } from '../../db/database.js';

/** All SQL for the attendance policy and exam eligibility. Every value is parameterised. */

export interface PolicyRow {
  minAttendancePercent: number;
  atRiskMarginPercent: number;
  updatedAt: Date;
  updatedByName: string | null;
}

/** The single policy row (`db/migrations/034_attendance_policy.sql`). Always present after migration. */
export async function getPolicy(): Promise<PolicyRow> {
  const row = await queryOne<{
    min_attendance_percent: string;
    at_risk_margin_percent: string;
    updated_at: Date;
    updated_by_name: string | null;
  }>(
    `SELECT p.min_attendance_percent, p.at_risk_margin_percent, p.updated_at, u.full_name AS updated_by_name
       FROM attendance_policy p
  LEFT JOIN users u ON u.id = p.updated_by_user_id
      WHERE p.id`,
  );
  if (!row) throw new Error('attendance_policy has no row; run the migrations');
  return {
    // NUMERIC arrives as a string from pg.
    minAttendancePercent: Number(row.min_attendance_percent),
    atRiskMarginPercent: Number(row.at_risk_margin_percent),
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

export async function updatePolicy(
  input: { minAttendancePercent?: number; atRiskMarginPercent?: number },
  updatedByUserId: string,
): Promise<void> {
  await query(
    `UPDATE attendance_policy
        SET min_attendance_percent = COALESCE($1, min_attendance_percent),
            at_risk_margin_percent = COALESCE($2, at_risk_margin_percent),
            updated_by_user_id = $3
      WHERE id`,
    [input.minAttendancePercent ?? null, input.atRiskMarginPercent ?? null, updatedByUserId],
  );
}

export interface StandingRow {
  allocation_id: string;
  student_user_id: string | null;
  registration_number: string | null;
  full_name: string | null;
  unit_id: string;
  unit_code: string;
  unit_name: string | null;
  lecturer_name: string;
  department_id: string | null;
  department_name: string | null;
  sessions_held: number;
  sessions_attended: number;
}

/**
 * Every active (student, unit) pair in scope, with classes held and attended.
 * `held` and `attended` have exactly the meaning `department.repository.ts
 * listStudents` gives them, so a student's rate here matches what the
 * department's student list shows. Scope is the unit's owning department:
 * `departmentId`, or every department of `facultyId`, or (neither) the whole
 * institution — QA's view.
 */
export async function listStanding(scope: { departmentId?: string; facultyId?: string }): Promise<StandingRow[]> {
  const { rows } = await query<StandingRow>(
    `SELECT a.id AS allocation_id, a.student_user_id, a.registration_number,
            COALESCE(a.full_name, su.full_name) AS full_name,
            u.id AS unit_id, u.code AS unit_code, u.name AS unit_name,
            lu.full_name AS lecturer_name,
            d.id AS department_id, d.name AS department_name,
            COUNT(DISTINCT se.id) FILTER (
              WHERE se.opens_at <= NOW()
                AND (r.id IS NOT NULL OR se.status = 'CLOSED' OR se.closes_at <= NOW())
            )::int AS sessions_held,
            COUNT(DISTINCT r.id)::int AS sessions_attended
       FROM unit_allocations a
       JOIN units u  ON u.id = a.unit_id
       JOIN users lu ON lu.id = u.lecturer_user_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN users su ON su.id = a.student_user_id
  LEFT JOIN attendance_sessions se ON se.unit_id = u.id
  LEFT JOIN attendance_records r   ON r.session_id = se.id AND r.student_user_id = a.student_user_id
      WHERE a.status = 'ACTIVE'
        AND ($1::uuid IS NULL OR u.department_id = $1)
        AND ($2::uuid IS NULL OR d.faculty_id = $2)
      GROUP BY a.id, a.student_user_id, a.registration_number, a.full_name, su.full_name,
               u.id, u.code, u.name, lu.full_name, d.id, d.name
      ORDER BY full_name NULLS LAST, u.code`,
    [scope.departmentId ?? null, scope.facultyId ?? null],
  );
  return rows;
}

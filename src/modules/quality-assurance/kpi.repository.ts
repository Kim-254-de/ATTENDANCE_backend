import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for the KPI dashboard. Every value is parameterised.
 *
 * Compliance rollups (by standard/category) are computed in `kpi.service.ts`
 * from the raw finding rows this returns, not in SQL — so the rating→score
 * fallback and averaging are plain, synchronously-testable functions rather
 * than logic hidden inside a query. Everything else (completion rate,
 * overdue CAPA count, attendance trend) is a small-enough aggregate that SQL
 * is the natural place for it.
 */

export interface DashboardFilters {
  targetDepartmentId?: string;
  targetFacultyId?: string;
  from?: string;
  to?: string;
}

const AUDIT_TARGET_FILTER = `
  AND ($1::uuid IS NULL OR a.target_department_id = $1)
  AND ($2::uuid IS NULL OR a.target_faculty_id = $2)
  AND ($3::date IS NULL OR a.scheduled_date >= $3)
  AND ($4::date IS NULL OR a.scheduled_date <= $4)`;

const auditTargetParams = (f: DashboardFilters): unknown[] => [
  f.targetDepartmentId ?? null,
  f.targetFacultyId ?? null,
  f.from ?? null,
  f.to ?? null,
];

export async function getAuditCompletionRate(
  filters: DashboardFilters,
): Promise<{ completed: number; total: number }> {
  const row = await queryOne<{ completed: number; total: number }>(
    `SELECT COUNT(*) FILTER (WHERE a.status = 'COMPLETED')::int AS completed, COUNT(*)::int AS total
       FROM qa_audits a
      WHERE TRUE ${AUDIT_TARGET_FILTER}`,
    auditTargetParams(filters),
  );
  return { completed: row?.completed ?? 0, total: row?.total ?? 0 };
}

export interface ComplianceFindingRow {
  standard_id: string;
  standard_code: string;
  standard_title: string;
  standard_category: string;
  rating: string;
  score: string | null;
}

/** Findings from COMPLETED audits only — an in-progress audit's partial ratings would skew a standard's figure. */
export async function listComplianceFindings(filters: DashboardFilters): Promise<ComplianceFindingRow[]> {
  const { rows } = await query<ComplianceFindingRow>(
    `SELECT s.id AS standard_id, s.code AS standard_code, s.title AS standard_title, s.category AS standard_category,
            fi.rating, fi.score
       FROM qa_audit_findings fi
       JOIN qa_audits a ON a.id = fi.audit_id AND a.status = 'COMPLETED'
       JOIN qa_checklist_items ci ON ci.id = fi.checklist_item_id
       JOIN qa_standards s ON s.id = ci.standard_id
      WHERE fi.rating <> 'NOT_APPLICABLE' ${AUDIT_TARGET_FILTER}`,
    auditTargetParams(filters),
  );
  return rows;
}

export async function getOverdueCapaCount(filters: DashboardFilters): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM qa_corrective_actions ca
       JOIN qa_audit_findings fi ON fi.id = ca.finding_id
       JOIN qa_audits a ON a.id = fi.audit_id
      WHERE ca.due_date < CURRENT_DATE AND ca.status NOT IN ('VERIFIED', 'CLOSED')
            ${AUDIT_TARGET_FILTER}`,
    auditTargetParams(filters),
  );
  return row?.count ?? 0;
}

export interface AttendanceTrendRow {
  period_start: Date;
  department_id: string;
  department_name: string;
  avg_attendance_rate: number;
}

/**
 * Attendance rate per department, bucketed by period. Same per-session rate
 * shape as `department.repository.ts`'s `avgAttendanceRate` (checked-in
 * records ÷ ACTIVE allocations per session), widened to every department —
 * or the filtered subset — instead of one officer's own.
 */
export async function getAttendanceTrends(
  filters: DashboardFilters,
  groupBy: 'week' | 'month',
): Promise<AttendanceTrendRow[]> {
  const { rows } = await query<AttendanceTrendRow>(
    `SELECT date_trunc($3, s.scheduled_start_at) AS period_start,
            d.id AS department_id, d.name AS department_name,
            AVG(
              (SELECT COUNT(*) FROM attendance_records r WHERE r.session_id = s.id)::numeric
              / NULLIF((SELECT COUNT(*) FROM unit_allocations al
                         WHERE al.unit_id = s.unit_id AND al.status = 'ACTIVE'), 0) * 100
            )::float8 AS avg_attendance_rate
       FROM attendance_sessions s
       JOIN lecturer_profiles lp ON lp.user_id = s.lecturer_user_id
       JOIN departments d ON d.id = lp.department_id
      WHERE s.scheduled_start_at IS NOT NULL
        AND ($1::uuid IS NULL OR d.id = $1)
        AND ($2::uuid IS NULL OR d.faculty_id = $2)
        AND ($4::date IS NULL OR s.scheduled_start_at >= $4)
        AND ($5::date IS NULL OR s.scheduled_start_at <= $5)
      GROUP BY period_start, d.id, d.name
      ORDER BY period_start, d.name`,
    [filters.targetDepartmentId ?? null, filters.targetFacultyId ?? null, groupBy, filters.from ?? null, filters.to ?? null],
  );
  return rows.filter((r) => r.avg_attendance_rate !== null);
}

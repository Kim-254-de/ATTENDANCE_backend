import * as kpiRepository from './kpi.repository.js';
import type { DashboardQuery } from './kpi.schema.js';

/**
 * KPI rollups. The rating→score fallback and the averaging itself are plain
 * functions, independent of SQL, so they can be unit-tested against
 * synthetic finding arrays (tests/unit/qa-kpi-math.test.ts) rather than only
 * through a database fixture.
 */

/** A finding's score when none was recorded explicitly. NOT_APPLICABLE has no fallback — callers must exclude it first. */
export function fallbackScoreFor(rating: string): number | null {
  switch (rating) {
    case 'COMPLIANT':
      return 100;
    case 'PARTIAL':
      return 50;
    case 'NON_COMPLIANT':
      return 0;
    default:
      return null;
  }
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Mean of each finding's own score, or its rating's fallback. Null for an empty list. */
export function averageScore(findings: ReadonlyArray<{ rating: string; score: number | null }>): number | null {
  const values = findings
    .map((f) => f.score ?? fallbackScoreFor(f.rating))
    .filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  return round1(values.reduce((sum, v) => sum + v, 0) / values.length);
}

export interface ComplianceByStandardDto {
  standardId: string;
  standardCode: string;
  standardTitle: string;
  category: string;
  avgScore: number | null;
  sampleCount: number;
}

export interface ComplianceByCategoryDto {
  category: string;
  avgScore: number | null;
  sampleCount: number;
}

function rollupByStandard(rows: kpiRepository.ComplianceFindingRow[]): ComplianceByStandardDto[] {
  const byStandard = new Map<string, kpiRepository.ComplianceFindingRow[]>();
  for (const row of rows) {
    const list = byStandard.get(row.standard_id) ?? [];
    list.push(row);
    byStandard.set(row.standard_id, list);
  }
  return [...byStandard.values()].map((group) => {
    const first = group[0] as kpiRepository.ComplianceFindingRow;
    return {
      standardId: first.standard_id,
      standardCode: first.standard_code,
      standardTitle: first.standard_title,
      category: first.standard_category,
      avgScore: averageScore(group.map((r) => ({ rating: r.rating, score: r.score === null ? null : Number(r.score) }))),
      sampleCount: group.length,
    };
  });
}

function rollupByCategory(rows: kpiRepository.ComplianceFindingRow[]): ComplianceByCategoryDto[] {
  const byCategory = new Map<string, kpiRepository.ComplianceFindingRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.standard_category) ?? [];
    list.push(row);
    byCategory.set(row.standard_category, list);
  }
  return [...byCategory.values()].map((group) => {
    const first = group[0] as kpiRepository.ComplianceFindingRow;
    return {
      category: first.standard_category,
      avgScore: averageScore(group.map((r) => ({ rating: r.rating, score: r.score === null ? null : Number(r.score) }))),
      sampleCount: group.length,
    };
  });
}

export interface AttendanceTrendDto {
  periodStart: string;
  departmentId: string;
  departmentName: string;
  avgAttendanceRate: number;
}

export interface DashboardDto {
  /** 0–100, one decimal; null when no audit matches the filters yet. */
  auditCompletionRate: number | null;
  auditsCompleted: number;
  auditsTotal: number;
  complianceByStandard: ComplianceByStandardDto[];
  complianceByCategory: ComplianceByCategoryDto[];
  overdueCapaCount: number;
  attendanceTrends: AttendanceTrendDto[];
}

/** GET /quality-assurance/dashboard */
export async function getDashboard(filters: DashboardQuery): Promise<DashboardDto> {
  const [completion, complianceFindings, overdueCapaCount, attendanceTrends] = await Promise.all([
    kpiRepository.getAuditCompletionRate(filters),
    kpiRepository.listComplianceFindings(filters),
    kpiRepository.getOverdueCapaCount(filters),
    kpiRepository.getAttendanceTrends(filters, filters.groupBy),
  ]);

  return {
    auditCompletionRate: completion.total > 0 ? round1((completion.completed / completion.total) * 100) : null,
    auditsCompleted: completion.completed,
    auditsTotal: completion.total,
    complianceByStandard: rollupByStandard(complianceFindings),
    complianceByCategory: rollupByCategory(complianceFindings),
    overdueCapaCount,
    attendanceTrends: attendanceTrends.map((r) => ({
      periodStart: r.period_start.toISOString().slice(0, 10),
      departmentId: r.department_id,
      departmentName: r.department_name,
      avgAttendanceRate: round1(r.avg_attendance_rate),
    })),
  };
}

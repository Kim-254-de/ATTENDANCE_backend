import { auditService } from '../audit/index.js';
import type { RegistrationContext } from '../auth/auth.service.js';
import * as eligibilityRepository from './eligibility.repository.js';

/**
 * The exam-eligibility rule and who it currently catches.
 *
 * The rule is one institution-wide setting (`attendance_policy`): the minimum
 * share of a unit's held classes a student must attend to sit its exam, plus
 * a margin above it that counts as "at risk". Each (student, unit) pair is
 * judged on its own, the way Senates word the rule: missing too much of one
 * unit bars that unit's exam, not the others.
 *
 * The standing is "so far": it is computed over the classes held to date,
 * since there is no semester or planned-class count in the schema to project
 * against.
 */

export type EligibilityStatus = 'ELIGIBLE' | 'AT_RISK' | 'NOT_ELIGIBLE' | 'NOT_YET_MEASURED';

export interface PolicyDto {
  minAttendancePercent: number;
  atRiskMarginPercent: number;
  updatedAt: string;
  updatedByName: string | null;
}

const toPolicyDto = (p: eligibilityRepository.PolicyRow): PolicyDto => ({
  minAttendancePercent: p.minAttendancePercent,
  atRiskMarginPercent: p.atRiskMarginPercent,
  updatedAt: p.updatedAt.toISOString(),
  updatedByName: p.updatedByName,
});

/** Attended ÷ held as a percentage to one decimal; null until a class has been held. */
export const rateOf = (attended: number, held: number): number | null =>
  held > 0 ? Math.round((attended / held) * 1000) / 10 : null;

/**
 * Where a rate stands against the policy. Compared on the unrounded ratio, so
 * 2 of 3 against a 66.67% rule is not failed by rounding to 66.7.
 */
export function classify(
  attended: number,
  held: number,
  policy: { minAttendancePercent: number; atRiskMarginPercent: number },
): EligibilityStatus {
  if (held <= 0) return 'NOT_YET_MEASURED';
  const percent = (attended / held) * 100;
  if (percent < policy.minAttendancePercent) return 'NOT_ELIGIBLE';
  if (percent < policy.minAttendancePercent + policy.atRiskMarginPercent) return 'AT_RISK';
  return 'ELIGIBLE';
}

/** GET /attendance-policy */
export async function getPolicy(): Promise<PolicyDto> {
  return toPolicyDto(await eligibilityRepository.getPolicy());
}

/** PUT /quality-assurance/attendance-policy — audited, since it changes who may sit exams. */
export async function updatePolicy(
  input: { minAttendancePercent?: number; atRiskMarginPercent?: number },
  actorUserId: string,
  context: RegistrationContext,
): Promise<PolicyDto> {
  const before = await eligibilityRepository.getPolicy();
  await eligibilityRepository.updatePolicy(input, actorUserId);
  const after = await eligibilityRepository.getPolicy();
  await auditService.record({
    action: 'ATTENDANCE_POLICY_UPDATED',
    outcome: 'SUCCESS',
    userId: actorUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      from: { minAttendancePercent: before.minAttendancePercent, atRiskMarginPercent: before.atRiskMarginPercent },
      to: { minAttendancePercent: after.minAttendancePercent, atRiskMarginPercent: after.atRiskMarginPercent },
    },
  });
  return toPolicyDto(after);
}

export interface EligibilityRowDto {
  allocationId: string;
  studentUserId: string | null;
  registrationNumber: string | null;
  fullName: string | null;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  lecturerName: string;
  departmentId: string | null;
  departmentName: string | null;
  sessionsHeld: number;
  sessionsAttended: number;
  attendanceRate: number | null;
  status: EligibilityStatus;
}

export interface EligibilityReportDto {
  policy: PolicyDto;
  /** Counted per (student, unit) pair, like the rows. */
  summary: Record<'total' | 'eligible' | 'atRisk' | 'notEligible' | 'notYetMeasured', number>;
  /** Only AT_RISK and NOT_ELIGIBLE rows unless `includeAll`, worst first. */
  rows: EligibilityRowDto[];
}

const SEVERITY: Record<EligibilityStatus, number> = { NOT_ELIGIBLE: 0, AT_RISK: 1, NOT_YET_MEASURED: 2, ELIGIBLE: 3 };

/**
 * The eligibility report for a scope. The callers (department and QA
 * services) resolve the scope from the signed-in officer, never from the
 * request alone.
 */
export async function buildReport(
  scope: { departmentId?: string },
  options: { includeAll?: boolean } = {},
): Promise<EligibilityReportDto> {
  const [policy, standing] = await Promise.all([eligibilityRepository.getPolicy(), eligibilityRepository.listStanding(scope)]);
  const summary = { total: 0, eligible: 0, atRisk: 0, notEligible: 0, notYetMeasured: 0 };
  const rows: EligibilityRowDto[] = [];
  for (const r of standing) {
    const status = classify(r.sessions_attended, r.sessions_held, policy);
    summary.total += 1;
    if (status === 'ELIGIBLE') summary.eligible += 1;
    else if (status === 'AT_RISK') summary.atRisk += 1;
    else if (status === 'NOT_ELIGIBLE') summary.notEligible += 1;
    else summary.notYetMeasured += 1;
    if (!options.includeAll && status !== 'AT_RISK' && status !== 'NOT_ELIGIBLE') continue;
    rows.push({
      allocationId: r.allocation_id,
      studentUserId: r.student_user_id,
      registrationNumber: r.registration_number,
      fullName: r.full_name,
      unitId: r.unit_id,
      unitCode: r.unit_code,
      unitName: r.unit_name,
      lecturerName: r.lecturer_name,
      departmentId: r.department_id,
      departmentName: r.department_name,
      sessionsHeld: r.sessions_held,
      sessionsAttended: r.sessions_attended,
      attendanceRate: rateOf(r.sessions_attended, r.sessions_held),
      status,
    });
  }
  rows.sort((a, b) =>
    SEVERITY[a.status] - SEVERITY[b.status] || (a.attendanceRate ?? 101) - (b.attendanceRate ?? 101) || a.unitCode.localeCompare(b.unitCode));
  return { policy: toPolicyDto(policy), summary, rows };
}

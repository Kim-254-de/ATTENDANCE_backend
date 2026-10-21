import { isForeignKeyViolation } from '../../db/database.js';
import { AppError } from '../../common/errors/index.js';
import * as auditRepository from './audit.repository.js';
import type { CreateAuditInput, ListAuditsQuery, UpdateAuditInput, UpsertFindingInput } from './audit.schema.js';

/**
 * Audits and their findings.
 *
 * Status is forward-only (`PLANNED -> IN_PROGRESS -> COMPLETED`), enforced by
 * `canTransitionAuditStatus` below — a pure function so its 9 (from, to)
 * pairs can be exhaustively unit-tested without a database. `COMPLETED` is
 * additionally refused until every checklist item in the audit's template has
 * a finding recorded, because a half-filled audit cannot be reported as done.
 */

const AUDIT_FORWARD_TRANSITIONS: Record<string, readonly string[]> = {
  PLANNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['COMPLETED'],
  COMPLETED: [],
};

export function canTransitionAuditStatus(from: string, to: string): boolean {
  if (from === to) return false;
  return AUDIT_FORWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface AuditDto {
  id: string;
  title: string;
  auditType: string;
  targetDepartmentId: string | null;
  targetDepartmentName: string | null;
  targetFacultyId: string | null;
  targetFacultyName: string | null;
  checklistTemplateId: string;
  checklistTemplateName: string;
  leadAuditorUserId: string;
  leadAuditorName: string;
  scheduledDate: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  totalItems: number;
  findingsRecorded: number;
  createdAt: string;
  updatedAt: string;
}

const toDate = (d: Date): string => d.toISOString().slice(0, 10);

const toAuditDto = (row: auditRepository.AuditRow): AuditDto => ({
  id: row.id,
  title: row.title,
  auditType: row.audit_type,
  targetDepartmentId: row.target_department_id,
  targetDepartmentName: row.target_department_name,
  targetFacultyId: row.target_faculty_id,
  targetFacultyName: row.target_faculty_name,
  checklistTemplateId: row.checklist_template_id,
  checklistTemplateName: row.checklist_template_name,
  leadAuditorUserId: row.lead_auditor_user_id,
  leadAuditorName: row.lead_auditor_name,
  scheduledDate: toDate(row.scheduled_date),
  status: row.status,
  startedAt: row.started_at ? row.started_at.toISOString() : null,
  completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  notes: row.notes,
  totalItems: row.total_items,
  findingsRecorded: row.findings_count,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** GET /quality-assurance/audits */
export async function list(filters: ListAuditsQuery): Promise<AuditDto[]> {
  const rows = await auditRepository.list(filters);
  return rows.map(toAuditDto);
}

async function requireAudit(id: string): Promise<auditRepository.AuditRow> {
  const row = await auditRepository.findById(id);
  if (!row) throw AppError.notFound('No such audit.');
  return row;
}

/** GET /quality-assurance/audits/:id */
export async function getById(id: string): Promise<AuditDto> {
  return toAuditDto(await requireAudit(id));
}

/** POST /quality-assurance/audits */
export async function create(input: CreateAuditInput, createdByUserId: string): Promise<AuditDto> {
  try {
    const row = await auditRepository.create({ ...input, createdByUserId });
    return toAuditDto(row);
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw AppError.badRequest('The target department/faculty, checklist template or lead auditor does not exist.');
    }
    throw error;
  }
}

/** PATCH /quality-assurance/audits/:id */
export async function update(id: string, input: UpdateAuditInput): Promise<AuditDto> {
  const audit = await requireAudit(id);

  const hasFieldUpdate =
    input.title !== undefined ||
    input.leadAuditorUserId !== undefined ||
    input.scheduledDate !== undefined ||
    input.notes !== undefined;
  if (hasFieldUpdate) {
    try {
      await auditRepository.updateFields(id, input);
    } catch (error) {
      if (isForeignKeyViolation(error)) throw AppError.badRequest('The lead auditor does not exist.');
      throw error;
    }
  }

  if (input.status !== undefined && input.status !== audit.status) {
    if (!canTransitionAuditStatus(audit.status, input.status)) {
      throw AppError.badRequest(`An audit cannot move from ${audit.status} to ${input.status}.`);
    }
    if (input.status === 'COMPLETED') {
      const missing = await auditRepository.countMissingFindings(id, audit.checklist_template_id);
      if (missing > 0) {
        throw AppError.badRequest(
          `${missing} checklist item${missing === 1 ? '' : 's'} still need a finding before this audit can be completed.`,
        );
      }
    }
    await auditRepository.updateStatus(id, input.status, {
      startedAt: input.status === 'IN_PROGRESS' ? new Date() : undefined,
      completedAt: input.status === 'COMPLETED' ? new Date() : undefined,
    });
  }

  return toAuditDto(await requireAudit(id));
}

export interface ChecklistViewItemDto {
  checklistItemId: string;
  prompt: string;
  guidance: string | null;
  sortOrder: number;
  standardId: string;
  standardCode: string;
  standardTitle: string;
  standardCategory: string;
  finding: {
    id: string;
    rating: string;
    score: number | null;
    evidenceNotes: string | null;
    recordedByUserId: string;
    updatedAt: string;
  } | null;
}

/** GET /quality-assurance/audits/:id/checklist — the "fill checklist" view. */
export async function getChecklistView(auditId: string): Promise<ChecklistViewItemDto[]> {
  const audit = await requireAudit(auditId);
  const rows = await auditRepository.getChecklistView(auditId, audit.checklist_template_id);
  return rows.map((r) => ({
    checklistItemId: r.checklist_item_id,
    prompt: r.prompt,
    guidance: r.guidance,
    sortOrder: r.sort_order,
    standardId: r.standard_id,
    standardCode: r.standard_code,
    standardTitle: r.standard_title,
    standardCategory: r.standard_category,
    finding:
      r.finding_id && r.rating && r.recorded_by_user_id && r.finding_updated_at
        ? {
            id: r.finding_id,
            rating: r.rating,
            score: r.score === null ? null : Number(r.score),
            evidenceNotes: r.evidence_notes,
            recordedByUserId: r.recorded_by_user_id,
            updatedAt: r.finding_updated_at.toISOString(),
          }
        : null,
  }));
}

export interface FindingDto {
  id: string;
  auditId: string;
  checklistItemId: string;
  rating: string;
  score: number | null;
  evidenceNotes: string | null;
  recordedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

const toFindingDto = (row: auditRepository.FindingRow): FindingDto => ({
  id: row.id,
  auditId: row.audit_id,
  checklistItemId: row.checklist_item_id,
  rating: row.rating,
  score: row.score === null ? null : Number(row.score),
  evidenceNotes: row.evidence_notes,
  recordedByUserId: row.recorded_by_user_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** GET /quality-assurance/audits/:id/findings */
export async function listFindings(auditId: string): Promise<FindingDto[]> {
  await requireAudit(auditId);
  const rows = await auditRepository.listFindings(auditId);
  return rows.map(toFindingDto);
}

/**
 * PUT /quality-assurance/audits/:id/findings/:checklistItemId
 *
 * Refused once the audit is COMPLETED — a completed audit's findings are the
 * historical record; reopening one is not supported in this phase.
 */
export async function upsertFinding(
  auditId: string,
  checklistItemId: string,
  input: UpsertFindingInput,
  recordedByUserId: string,
): Promise<FindingDto> {
  const audit = await requireAudit(auditId);
  if (audit.status === 'COMPLETED') {
    throw AppError.conflict('This audit is already completed; its findings cannot be changed.');
  }

  try {
    const row = await auditRepository.upsertFinding({
      auditId,
      checklistItemId,
      rating: input.rating,
      score: input.score,
      evidenceNotes: input.evidenceNotes,
      recordedByUserId,
    });
    return toFindingDto(row);
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      throw AppError.badRequest('That checklist item does not belong to this audit.');
    }
    throw error;
  }
}

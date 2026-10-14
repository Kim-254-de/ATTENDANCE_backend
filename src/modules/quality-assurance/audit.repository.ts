import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for audits and their findings. Every value is parameterised.
 *
 * QA is institution-wide — unlike the department/faculty modules, nothing
 * here is auto-scoped to the caller. Every list takes explicit filters.
 */

export interface AuditRow {
  id: string;
  title: string;
  audit_type: string;
  target_department_id: string | null;
  target_department_name: string | null;
  target_faculty_id: string | null;
  target_faculty_name: string | null;
  checklist_template_id: string;
  checklist_template_name: string;
  lead_auditor_user_id: string;
  lead_auditor_name: string;
  scheduled_date: Date;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  notes: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  total_items: number;
  findings_count: number;
}

const AUDIT_SELECT = `
  SELECT a.*, t.name AS checklist_template_name,
         d.name AS target_department_name, f.name AS target_faculty_name,
         u.full_name AS lead_auditor_name,
         (SELECT COUNT(*) FROM qa_checklist_items ci WHERE ci.template_id = a.checklist_template_id)::int AS total_items,
         (SELECT COUNT(*) FROM qa_audit_findings fi WHERE fi.audit_id = a.id)::int AS findings_count
    FROM qa_audits a
    JOIN qa_checklist_templates t ON t.id = a.checklist_template_id
    JOIN users u ON u.id = a.lead_auditor_user_id
LEFT JOIN departments d ON d.id = a.target_department_id
LEFT JOIN faculties   f ON f.id = a.target_faculty_id`;

export interface ListAuditsFilters {
  status?: string;
  targetDepartmentId?: string;
  targetFacultyId?: string;
  from?: string;
  to?: string;
}

export async function list(filters: ListAuditsFilters): Promise<AuditRow[]> {
  const { rows } = await query<AuditRow>(
    `${AUDIT_SELECT}
      WHERE ($1::text IS NULL OR a.status = $1)
        AND ($2::uuid IS NULL OR a.target_department_id = $2)
        AND ($3::uuid IS NULL OR a.target_faculty_id = $3)
        AND ($4::date IS NULL OR a.scheduled_date >= $4)
        AND ($5::date IS NULL OR a.scheduled_date <= $5)
      ORDER BY a.scheduled_date DESC, a.created_at DESC`,
    [
      filters.status ?? null,
      filters.targetDepartmentId ?? null,
      filters.targetFacultyId ?? null,
      filters.from ?? null,
      filters.to ?? null,
    ],
  );
  return rows;
}

export async function findById(id: string): Promise<AuditRow | null> {
  return queryOne<AuditRow>(`${AUDIT_SELECT} WHERE a.id = $1`, [id]);
}

export interface CreateAuditParams {
  title: string;
  targetDepartmentId?: string;
  targetFacultyId?: string;
  checklistTemplateId: string;
  leadAuditorUserId: string;
  scheduledDate: string;
  notes?: string;
  createdByUserId: string;
}

export async function create(params: CreateAuditParams): Promise<AuditRow> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO qa_audits
       (title, target_department_id, target_faculty_id, checklist_template_id,
        lead_auditor_user_id, scheduled_date, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.title,
      params.targetDepartmentId ?? null,
      params.targetFacultyId ?? null,
      params.checklistTemplateId,
      params.leadAuditorUserId,
      params.scheduledDate,
      params.notes ?? null,
      params.createdByUserId,
    ],
  );
  if (!inserted) throw new Error('qa_audits insert returned no row');
  const row = await findById(inserted.id);
  if (!row) throw new Error('qa_audits row vanished immediately after insert');
  return row;
}

export interface UpdateAuditFieldsParams {
  title?: string;
  leadAuditorUserId?: string;
  scheduledDate?: string;
  notes?: string | null;
}

export async function updateFields(id: string, params: UpdateAuditFieldsParams): Promise<void> {
  await query(
    `UPDATE qa_audits
        SET title = COALESCE($2, title),
            lead_auditor_user_id = COALESCE($3, lead_auditor_user_id),
            scheduled_date = COALESCE($4, scheduled_date),
            notes = CASE WHEN $5::boolean THEN $6 ELSE notes END
      WHERE id = $1`,
    [id, params.title ?? null, params.leadAuditorUserId ?? null, params.scheduledDate ?? null, params.notes !== undefined, params.notes ?? null],
  );
}

export async function updateStatus(
  id: string,
  status: string,
  timestamps: { startedAt?: Date; completedAt?: Date },
): Promise<void> {
  await query(
    `UPDATE qa_audits
        SET status = $2,
            started_at = COALESCE(started_at, $3),
            completed_at = COALESCE($4, completed_at)
      WHERE id = $1`,
    [id, status, timestamps.startedAt ?? null, timestamps.completedAt ?? null],
  );
}

export interface ChecklistViewRow {
  checklist_item_id: string;
  prompt: string;
  guidance: string | null;
  sort_order: number;
  standard_id: string;
  standard_code: string;
  standard_title: string;
  standard_category: string;
  finding_id: string | null;
  rating: string | null;
  score: string | null;
  evidence_notes: string | null;
  recorded_by_user_id: string | null;
  finding_updated_at: Date | null;
}

/** The audit's checklist items, in order, left-joined to any finding already recorded for this audit. */
export async function getChecklistView(auditId: string, templateId: string): Promise<ChecklistViewRow[]> {
  const { rows } = await query<ChecklistViewRow>(
    `SELECT ci.id AS checklist_item_id, ci.prompt, ci.guidance, ci.sort_order,
            s.id AS standard_id, s.code AS standard_code, s.title AS standard_title, s.category AS standard_category,
            fi.id AS finding_id, fi.rating, fi.score, fi.evidence_notes,
            fi.recorded_by_user_id, fi.updated_at AS finding_updated_at
       FROM qa_checklist_items ci
       JOIN qa_standards s ON s.id = ci.standard_id
  LEFT JOIN qa_audit_findings fi ON fi.checklist_item_id = ci.id AND fi.audit_id = $1
      WHERE ci.template_id = $2
      ORDER BY ci.sort_order, ci.created_at`,
    [auditId, templateId],
  );
  return rows;
}

export interface FindingRow {
  id: string;
  audit_id: string;
  checklist_item_id: string;
  rating: string;
  score: string | null;
  evidence_notes: string | null;
  recorded_by_user_id: string;
  created_at: Date;
  updated_at: Date;
}

export async function listFindings(auditId: string): Promise<FindingRow[]> {
  const { rows } = await query<FindingRow>(
    `SELECT * FROM qa_audit_findings WHERE audit_id = $1 ORDER BY created_at`,
    [auditId],
  );
  return rows;
}

export async function findFindingById(auditId: string, checklistItemId: string): Promise<FindingRow | null> {
  return queryOne<FindingRow>(
    `SELECT * FROM qa_audit_findings WHERE audit_id = $1 AND checklist_item_id = $2`,
    [auditId, checklistItemId],
  );
}

export interface UpsertFindingParams {
  auditId: string;
  checklistItemId: string;
  rating: string;
  score?: number;
  evidenceNotes?: string;
  recordedByUserId: string;
}

/** True upsert: the UNIQUE(audit_id, checklist_item_id) constraint on qa_audit_findings backs this. */
export async function upsertFinding(params: UpsertFindingParams): Promise<FindingRow> {
  const row = await queryOne<FindingRow>(
    `INSERT INTO qa_audit_findings (audit_id, checklist_item_id, rating, score, evidence_notes, recorded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (audit_id, checklist_item_id)
     DO UPDATE SET rating = EXCLUDED.rating, score = EXCLUDED.score,
                   evidence_notes = EXCLUDED.evidence_notes, recorded_by_user_id = EXCLUDED.recorded_by_user_id
     RETURNING *`,
    [params.auditId, params.checklistItemId, params.rating, params.score ?? null, params.evidenceNotes ?? null, params.recordedByUserId],
  );
  if (!row) throw new Error('qa_audit_findings upsert returned no row');
  return row;
}

export interface FindingExportRow {
  standard_code: string;
  standard_title: string;
  prompt: string;
  rating: string | null;
  score: string | null;
  evidence_notes: string | null;
  recorded_by_name: string | null;
  updated_at: Date | null;
}

/** One row per checklist item (whether or not it has a finding yet), for the audit-detail export. */
export async function getFindingsForExport(auditId: string, templateId: string): Promise<FindingExportRow[]> {
  const { rows } = await query<FindingExportRow>(
    `SELECT s.code AS standard_code, s.title AS standard_title, ci.prompt,
            fi.rating, fi.score, fi.evidence_notes, u.full_name AS recorded_by_name, fi.updated_at
       FROM qa_checklist_items ci
       JOIN qa_standards s ON s.id = ci.standard_id
  LEFT JOIN qa_audit_findings fi ON fi.checklist_item_id = ci.id AND fi.audit_id = $1
  LEFT JOIN users u ON u.id = fi.recorded_by_user_id
      WHERE ci.template_id = $2
      ORDER BY ci.sort_order, ci.created_at`,
    [auditId, templateId],
  );
  return rows;
}

/** Checklist items of an audit's template with no finding recorded yet for this audit. */
export async function countMissingFindings(auditId: string, templateId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM qa_checklist_items ci
  LEFT JOIN qa_audit_findings fi ON fi.checklist_item_id = ci.id AND fi.audit_id = $1
      WHERE ci.template_id = $2 AND fi.id IS NULL`,
    [auditId, templateId],
  );
  return row?.count ?? 0;
}

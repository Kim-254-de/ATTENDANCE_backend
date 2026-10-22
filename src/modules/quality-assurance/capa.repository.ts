import { query, queryOne } from '../../db/database.js';

/** All SQL for corrective action plans (CAPA). Every value is parameterised. */

export interface CapaRow {
  id: string;
  finding_id: string;
  description: string;
  owner_user_id: string;
  owner_name: string;
  due_date: Date;
  status: string;
  verified_by_user_id: string | null;
  verified_by_name: string | null;
  verified_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  // Traced-back context, for the register and its filters.
  audit_id: string;
  audit_title: string;
  rating: string;
  standard_code: string;
  standard_title: string;
  target_department_id: string | null;
  target_faculty_id: string | null;
}

const CAPA_SELECT = `
  SELECT ca.*, owner.full_name AS owner_name, verifier.full_name AS verified_by_name,
         a.id AS audit_id, a.title AS audit_title, a.target_department_id, a.target_faculty_id,
         fi.rating, s.code AS standard_code, s.title AS standard_title
    FROM qa_corrective_actions ca
    JOIN users owner ON owner.id = ca.owner_user_id
LEFT JOIN users verifier ON verifier.id = ca.verified_by_user_id
    JOIN qa_audit_findings fi ON fi.id = ca.finding_id
    JOIN qa_audits a ON a.id = fi.audit_id
    JOIN qa_checklist_items ci ON ci.id = fi.checklist_item_id
    JOIN qa_standards s ON s.id = ci.standard_id`;

export interface ListCapaFilters {
  status?: string;
  ownerUserId?: string;
  targetDepartmentId?: string;
  targetFacultyId?: string;
  overdue?: boolean;
}

export async function list(filters: ListCapaFilters): Promise<CapaRow[]> {
  const { rows } = await query<CapaRow>(
    `${CAPA_SELECT}
      WHERE ($1::text IS NULL OR ca.status = $1)
        AND ($2::uuid IS NULL OR ca.owner_user_id = $2)
        AND ($3::uuid IS NULL OR a.target_department_id = $3)
        AND ($4::uuid IS NULL OR a.target_faculty_id = $4)
        AND ($5::boolean IS NULL OR ($5 = TRUE AND ca.due_date < CURRENT_DATE AND ca.status NOT IN ('VERIFIED', 'CLOSED')))
      ORDER BY ca.due_date, ca.created_at`,
    [
      filters.status ?? null,
      filters.ownerUserId ?? null,
      filters.targetDepartmentId ?? null,
      filters.targetFacultyId ?? null,
      filters.overdue ?? null,
    ],
  );
  return rows;
}

export async function findById(id: string): Promise<CapaRow | null> {
  return queryOne<CapaRow>(`${CAPA_SELECT} WHERE ca.id = $1`, [id]);
}

export interface FindingForCapaRow {
  id: string;
  audit_id: string;
  rating: string;
}

export async function findFindingForCapa(findingId: string): Promise<FindingForCapaRow | null> {
  return queryOne<FindingForCapaRow>(`SELECT id, audit_id, rating FROM qa_audit_findings WHERE id = $1`, [
    findingId,
  ]);
}

export interface CreateCapaParams {
  findingId: string;
  description: string;
  ownerUserId: string;
  dueDate: string;
  createdByUserId: string;
}

export async function create(params: CreateCapaParams): Promise<CapaRow> {
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO qa_corrective_actions (finding_id, description, owner_user_id, due_date, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.findingId, params.description, params.ownerUserId, params.dueDate, params.createdByUserId],
  );
  if (!inserted) throw new Error('qa_corrective_actions insert returned no row');
  const row = await findById(inserted.id);
  if (!row) throw new Error('qa_corrective_actions row vanished immediately after insert');
  return row;
}

export interface UpdateCapaFieldsParams {
  description?: string;
  ownerUserId?: string;
  dueDate?: string;
}

export async function updateFields(id: string, params: UpdateCapaFieldsParams): Promise<void> {
  await query(
    `UPDATE qa_corrective_actions
        SET description = COALESCE($2, description),
            owner_user_id = COALESCE($3, owner_user_id),
            due_date = COALESCE($4, due_date)
      WHERE id = $1`,
    [id, params.description ?? null, params.ownerUserId ?? null, params.dueDate ?? null],
  );
}

/**
 * Status transition. `verifiedByUserId`/`verifiedAt` are passed by the
 * service, already resolved from the authenticated caller — never from the
 * request body — and are cleared (set to NULL) on any non-terminal status so
 * the CHECK constraint tying status to the verification pair always holds.
 */
export async function updateStatus(
  id: string,
  status: string,
  verification: { verifiedByUserId: string | null; verifiedAt: Date | null },
): Promise<void> {
  await query(
    `UPDATE qa_corrective_actions
        SET status = $2, verified_by_user_id = $3, verified_at = $4
      WHERE id = $1`,
    [id, status, verification.verifiedByUserId, verification.verifiedAt],
  );
}

import { query, queryOne } from '../../db/database.js';

/** All SQL for checklist templates and their items. Every value is parameterised. */

export interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TemplateItemRow {
  id: string;
  template_id: string;
  standard_id: string;
  prompt: string;
  guidance: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  standard_code: string;
  standard_title: string;
  standard_category: string;
}

export async function listTemplates(filters: { active?: boolean }): Promise<TemplateRow[]> {
  const { rows } = await query<TemplateRow>(
    `SELECT * FROM qa_checklist_templates
      WHERE ($1::boolean IS NULL OR is_active = $1)
      ORDER BY name`,
    [filters.active ?? null],
  );
  return rows;
}

export async function findTemplateById(id: string): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(`SELECT * FROM qa_checklist_templates WHERE id = $1`, [id]);
}

export async function findTemplateByName(name: string): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(`SELECT * FROM qa_checklist_templates WHERE name = $1`, [name]);
}

export async function createTemplate(params: {
  name: string;
  description?: string;
  createdByUserId?: string;
}): Promise<TemplateRow> {
  const row = await queryOne<TemplateRow>(
    `INSERT INTO qa_checklist_templates (name, description, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [params.name, params.description ?? null, params.createdByUserId ?? null],
  );
  if (!row) throw new Error('qa_checklist_templates insert returned no row');
  return row;
}

export async function updateTemplate(
  id: string,
  params: { name?: string; description?: string | null; isActive?: boolean },
): Promise<TemplateRow | null> {
  return queryOne<TemplateRow>(
    `UPDATE qa_checklist_templates
        SET name = COALESCE($2, name),
            description = CASE WHEN $3::boolean THEN $4 ELSE description END,
            is_active = COALESCE($5, is_active)
      WHERE id = $1
  RETURNING *`,
    [id, params.name ?? null, params.description !== undefined, params.description ?? null, params.isActive ?? null],
  );
}

/** Items of one template, ordered, each joined to the standard it maps to. */
export async function listItems(templateId: string): Promise<TemplateItemRow[]> {
  const { rows } = await query<TemplateItemRow>(
    `SELECT ci.*, s.code AS standard_code, s.title AS standard_title, s.category AS standard_category
       FROM qa_checklist_items ci
       JOIN qa_standards s ON s.id = ci.standard_id
      WHERE ci.template_id = $1
      ORDER BY ci.sort_order, ci.created_at`,
    [templateId],
  );
  return rows;
}

export async function findItemById(templateId: string, itemId: string): Promise<TemplateItemRow | null> {
  return queryOne<TemplateItemRow>(
    `SELECT ci.*, s.code AS standard_code, s.title AS standard_title, s.category AS standard_category
       FROM qa_checklist_items ci
       JOIN qa_standards s ON s.id = ci.standard_id
      WHERE ci.template_id = $1 AND ci.id = $2`,
    [templateId, itemId],
  );
}

export async function createItem(params: {
  templateId: string;
  standardId: string;
  prompt: string;
  guidance?: string;
  sortOrder?: number;
}): Promise<TemplateItemRow> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO qa_checklist_items (template_id, standard_id, prompt, guidance, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0))
     RETURNING id`,
    [params.templateId, params.standardId, params.prompt, params.guidance ?? null, params.sortOrder ?? null],
  );
  if (!row) throw new Error('qa_checklist_items insert returned no row');
  const item = await findItemById(params.templateId, row.id);
  if (!item) throw new Error('qa_checklist_items row vanished immediately after insert');
  return item;
}

export async function updateItem(
  templateId: string,
  itemId: string,
  params: { standardId?: string; prompt?: string; guidance?: string | null; sortOrder?: number },
): Promise<TemplateItemRow | null> {
  const updated = await queryOne<{ id: string }>(
    `UPDATE qa_checklist_items
        SET standard_id = COALESCE($3, standard_id),
            prompt = COALESCE($4, prompt),
            guidance = CASE WHEN $5::boolean THEN $6 ELSE guidance END,
            sort_order = COALESCE($7, sort_order)
      WHERE template_id = $1 AND id = $2
  RETURNING id`,
    [
      templateId,
      itemId,
      params.standardId ?? null,
      params.prompt ?? null,
      params.guidance !== undefined,
      params.guidance ?? null,
      params.sortOrder ?? null,
    ],
  );
  if (!updated) return null;
  return findItemById(templateId, itemId);
}

/** Whether any audit finding has been recorded against this checklist item. */
export async function itemHasFindings(itemId: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM qa_audit_findings WHERE checklist_item_id = $1) AS exists`,
    [itemId],
  );
  return row?.exists ?? false;
}

export async function deleteItem(templateId: string, itemId: string): Promise<boolean> {
  const result = await query(`DELETE FROM qa_checklist_items WHERE template_id = $1 AND id = $2`, [
    templateId,
    itemId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

export async function countItems(templateId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM qa_checklist_items WHERE template_id = $1`,
    [templateId],
  );
  return row?.count ?? 0;
}

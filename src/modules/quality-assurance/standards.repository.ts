import { query, queryOne } from '../../db/database.js';

/** All SQL for the QA standards catalog. Every value is parameterised. */

export interface StandardRow {
  id: string;
  code: string;
  category: string;
  title: string;
  description: string | null;
  display_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function list(filters: { category?: string; active?: boolean }): Promise<StandardRow[]> {
  const { rows } = await query<StandardRow>(
    `SELECT * FROM qa_standards
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::boolean IS NULL OR is_active = $2)
      ORDER BY category, display_order, code`,
    [filters.category ?? null, filters.active ?? null],
  );
  return rows;
}

export async function findById(id: string): Promise<StandardRow | null> {
  return queryOne<StandardRow>(`SELECT * FROM qa_standards WHERE id = $1`, [id]);
}

export async function findByIds(ids: readonly string[]): Promise<StandardRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await query<StandardRow>(`SELECT * FROM qa_standards WHERE id = ANY($1::uuid[])`, [ids]);
  return rows;
}

export interface CreateStandardParams {
  code: string;
  category: string;
  title: string;
  description?: string;
  displayOrder?: number;
}

export async function create(params: CreateStandardParams): Promise<StandardRow> {
  const row = await queryOne<StandardRow>(
    `INSERT INTO qa_standards (code, category, title, description, display_order)
     VALUES ($1, $2, $3, $4, COALESCE($5, 0))
     RETURNING *`,
    [params.code, params.category, params.title, params.description ?? null, params.displayOrder ?? null],
  );
  if (!row) throw new Error('qa_standards insert returned no row');
  return row;
}

export interface UpdateStandardParams {
  code?: string;
  category?: string;
  title?: string;
  description?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}

export async function update(id: string, params: UpdateStandardParams): Promise<StandardRow | null> {
  return queryOne<StandardRow>(
    `UPDATE qa_standards
        SET code = COALESCE($2, code),
            category = COALESCE($3, category),
            title = COALESCE($4, title),
            description = CASE WHEN $5::boolean THEN $6 ELSE description END,
            display_order = COALESCE($7, display_order),
            is_active = COALESCE($8, is_active)
      WHERE id = $1
  RETURNING *`,
    [
      id,
      params.code ?? null,
      params.category ?? null,
      params.title ?? null,
      params.description !== undefined,
      params.description ?? null,
      params.displayOrder ?? null,
      params.isActive ?? null,
    ],
  );
}

import { isUniqueViolation } from '../../db/database.js';
import { AppError } from '../../common/errors/index.js';
import * as standardsRepository from './standards.repository.js';
import type { CreateStandardInput, ListStandardsQuery, UpdateStandardInput } from './standards.schema.js';

/**
 * The quality standards catalog. No endpoint deletes a standard — a
 * standard already referenced by a checklist item (and in turn by findings)
 * must keep its meaning for every past audit, so it is deactivated
 * (`isActive: false`) instead.
 */

export interface StandardDto {
  id: string;
  code: string;
  category: string;
  title: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const toDto = (row: standardsRepository.StandardRow): StandardDto => ({
  id: row.id,
  code: row.code,
  category: row.category,
  title: row.title,
  description: row.description,
  displayOrder: row.display_order,
  isActive: row.is_active,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** GET /quality-assurance/standards */
export async function list(filters: ListStandardsQuery): Promise<StandardDto[]> {
  const rows = await standardsRepository.list({ category: filters.category, active: filters.active });
  return rows.map(toDto);
}

/** GET /quality-assurance/standards/:id */
export async function getById(id: string): Promise<StandardDto> {
  const row = await standardsRepository.findById(id);
  if (!row) throw AppError.notFound('No such standard.');
  return toDto(row);
}

/** POST /quality-assurance/standards */
export async function create(input: CreateStandardInput): Promise<StandardDto> {
  try {
    const row = await standardsRepository.create(input);
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict('A standard with this code already exists.');
    throw error;
  }
}

/** PATCH /quality-assurance/standards/:id */
export async function update(id: string, input: UpdateStandardInput): Promise<StandardDto> {
  try {
    const row = await standardsRepository.update(id, input);
    if (!row) throw AppError.notFound('No such standard.');
    return toDto(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw AppError.conflict('A standard with this code already exists.');
    throw error;
  }
}

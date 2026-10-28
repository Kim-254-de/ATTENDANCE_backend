import { AppError } from '../../common/errors/index.js';
import * as checklistRepository from './checklist.repository.js';
import type {
  CreateItemInput,
  CreateTemplateInput,
  ListTemplatesQuery,
  UpdateItemInput,
  UpdateTemplateInput,
} from './checklist.schema.js';

/**
 * Checklist templates and their items. A template is the structure an audit
 * is run against (`audit.service.ts`); an item cannot be removed once an
 * audit has recorded a finding against it, because that finding's meaning
 * would be lost.
 */

export interface ChecklistItemDto {
  id: string;
  templateId: string;
  standardId: string;
  standardCode: string;
  standardTitle: string;
  standardCategory: string;
  prompt: string;
  guidance: string | null;
  sortOrder: number;
}

export interface TemplateDto {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetailDto extends TemplateDto {
  items: ChecklistItemDto[];
}

const toItemDto = (row: checklistRepository.TemplateItemRow): ChecklistItemDto => ({
  id: row.id,
  templateId: row.template_id,
  standardId: row.standard_id,
  standardCode: row.standard_code,
  standardTitle: row.standard_title,
  standardCategory: row.standard_category,
  prompt: row.prompt,
  guidance: row.guidance,
  sortOrder: row.sort_order,
});

async function toTemplateDto(row: checklistRepository.TemplateRow): Promise<TemplateDto> {
  const itemCount = await checklistRepository.countItems(row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    itemCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** GET /quality-assurance/checklist-templates */
export async function listTemplates(filters: ListTemplatesQuery): Promise<TemplateDto[]> {
  const rows = await checklistRepository.listTemplates({ active: filters.active });
  return Promise.all(rows.map(toTemplateDto));
}

async function requireTemplate(id: string): Promise<checklistRepository.TemplateRow> {
  const row = await checklistRepository.findTemplateById(id);
  if (!row) throw AppError.notFound('No such checklist template.');
  return row;
}

/** GET /quality-assurance/checklist-templates/:id */
export async function getTemplateDetail(id: string): Promise<TemplateDetailDto> {
  const template = await requireTemplate(id);
  const items = await checklistRepository.listItems(id);
  const base = await toTemplateDto(template);
  return { ...base, items: items.map(toItemDto) };
}

/** POST /quality-assurance/checklist-templates */
export async function createTemplate(input: CreateTemplateInput, createdByUserId: string): Promise<TemplateDto> {
  const row = await checklistRepository.createTemplate({ ...input, createdByUserId });
  return toTemplateDto(row);
}

/** PATCH /quality-assurance/checklist-templates/:id */
export async function updateTemplate(id: string, input: UpdateTemplateInput): Promise<TemplateDto> {
  await requireTemplate(id);
  const row = await checklistRepository.updateTemplate(id, input);
  if (!row) throw AppError.notFound('No such checklist template.');
  return toTemplateDto(row);
}

/** POST /quality-assurance/checklist-templates/:id/items */
export async function createItem(templateId: string, input: CreateItemInput): Promise<ChecklistItemDto> {
  await requireTemplate(templateId);
  const row = await checklistRepository.createItem({ templateId, ...input });
  return toItemDto(row);
}

/** PATCH /quality-assurance/checklist-templates/:id/items/:itemId */
export async function updateItem(
  templateId: string,
  itemId: string,
  input: UpdateItemInput,
): Promise<ChecklistItemDto> {
  await requireTemplate(templateId);
  const row = await checklistRepository.updateItem(templateId, itemId, input);
  if (!row) throw AppError.notFound('No such checklist item.');
  return toItemDto(row);
}

/**
 * DELETE /quality-assurance/checklist-templates/:id/items/:itemId
 *
 * Refused once any audit has recorded a finding against this item — removing
 * it would strand that finding's `standardId`/`prompt` context.
 */
export async function deleteItem(templateId: string, itemId: string): Promise<void> {
  await requireTemplate(templateId);
  const item = await checklistRepository.findItemById(templateId, itemId);
  if (!item) throw AppError.notFound('No such checklist item.');

  if (await checklistRepository.itemHasFindings(itemId)) {
    throw AppError.conflict('This item already has findings recorded against it and cannot be removed.');
  }
  await checklistRepository.deleteItem(templateId, itemId);
}

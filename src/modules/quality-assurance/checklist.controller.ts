import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as checklistService from './checklist.service.js';
import type {
  CreateItemInput,
  CreateTemplateInput,
  ListTemplatesQuery,
  TemplateIdParam,
  TemplateItemParams,
  UpdateItemInput,
  UpdateTemplateInput,
} from './checklist.schema.js';

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/quality-assurance/checklist-templates */
export async function listTemplates(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await checklistService.listTemplates(req.query as unknown as ListTemplatesQuery));
}

/** GET /api/v1/quality-assurance/checklist-templates/:id */
export async function getTemplateDetail(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as TemplateIdParam;
  sendSuccess(res, await checklistService.getTemplateDetail(id));
}

/** POST /api/v1/quality-assurance/checklist-templates */
export async function createTemplate(req: Request, res: Response): Promise<void> {
  sendCreated(res, await checklistService.createTemplate(req.body as CreateTemplateInput, userId(req)));
}

/** PATCH /api/v1/quality-assurance/checklist-templates/:id */
export async function updateTemplate(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as TemplateIdParam;
  sendSuccess(res, await checklistService.updateTemplate(id, req.body as UpdateTemplateInput));
}

/** POST /api/v1/quality-assurance/checklist-templates/:id/items */
export async function createItem(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as TemplateIdParam;
  sendCreated(res, await checklistService.createItem(id, req.body as CreateItemInput));
}

/** PATCH /api/v1/quality-assurance/checklist-templates/:id/items/:itemId */
export async function updateItem(req: Request, res: Response): Promise<void> {
  const { id, itemId } = req.params as unknown as TemplateItemParams;
  sendSuccess(res, await checklistService.updateItem(id, itemId, req.body as UpdateItemInput));
}

/** DELETE /api/v1/quality-assurance/checklist-templates/:id/items/:itemId */
export async function deleteItem(req: Request, res: Response): Promise<void> {
  const { id, itemId } = req.params as unknown as TemplateItemParams;
  await checklistService.deleteItem(id, itemId);
  sendSuccess(res, { id: itemId, deleted: true });
}

import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as auditService from './audit.service.js';
import type {
  AuditFindingParams,
  AuditIdParam,
  CreateAuditInput,
  ListAuditsQuery,
  UpdateAuditInput,
  UpsertFindingInput,
} from './audit.schema.js';

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/quality-assurance/audits */
export async function list(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await auditService.list(req.query as unknown as ListAuditsQuery));
}

/** GET /api/v1/quality-assurance/audits/:id */
export async function getById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  sendSuccess(res, await auditService.getById(id));
}

/** POST /api/v1/quality-assurance/audits */
export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await auditService.create(req.body as CreateAuditInput, userId(req)));
}

/** PATCH /api/v1/quality-assurance/audits/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  sendSuccess(res, await auditService.update(id, req.body as UpdateAuditInput));
}

/** GET /api/v1/quality-assurance/audits/:id/checklist */
export async function getChecklistView(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  sendSuccess(res, await auditService.getChecklistView(id));
}

/** GET /api/v1/quality-assurance/audits/:id/findings */
export async function listFindings(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  sendSuccess(res, await auditService.listFindings(id));
}

/** PUT /api/v1/quality-assurance/audits/:id/findings/:checklistItemId */
export async function upsertFinding(req: Request, res: Response): Promise<void> {
  const { id, checklistItemId } = req.params as unknown as AuditFindingParams;
  sendSuccess(res, await auditService.upsertFinding(id, checklistItemId, req.body as UpsertFindingInput, userId(req)));
}

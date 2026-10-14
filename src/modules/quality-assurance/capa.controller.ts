import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as capaService from './capa.service.js';
import type { CapaIdParam, CreateCapaInput, ListCapaQuery, UpdateCapaInput } from './capa.schema.js';

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/quality-assurance/corrective-actions */
export async function list(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await capaService.list(req.query as unknown as ListCapaQuery));
}

/** GET /api/v1/quality-assurance/corrective-actions/:id */
export async function getById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as CapaIdParam;
  sendSuccess(res, await capaService.getById(id));
}

/** POST /api/v1/quality-assurance/corrective-actions */
export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await capaService.create(req.body as CreateCapaInput, userId(req)));
}

/** PATCH /api/v1/quality-assurance/corrective-actions/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as CapaIdParam;
  sendSuccess(res, await capaService.update(id, req.body as UpdateCapaInput, userId(req)));
}

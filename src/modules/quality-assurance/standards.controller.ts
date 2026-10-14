import type { Request, Response } from 'express';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as standardsService from './standards.service.js';
import type {
  CreateStandardInput,
  ListStandardsQuery,
  StandardIdParam,
  UpdateStandardInput,
} from './standards.schema.js';

/** GET /api/v1/quality-assurance/standards */
export async function list(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await standardsService.list(req.query as unknown as ListStandardsQuery));
}

/** GET /api/v1/quality-assurance/standards/:id */
export async function getById(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as StandardIdParam;
  sendSuccess(res, await standardsService.getById(id));
}

/** POST /api/v1/quality-assurance/standards */
export async function create(req: Request, res: Response): Promise<void> {
  sendCreated(res, await standardsService.create(req.body as CreateStandardInput));
}

/** PATCH /api/v1/quality-assurance/standards/:id */
export async function update(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as StandardIdParam;
  sendSuccess(res, await standardsService.update(id, req.body as UpdateStandardInput));
}

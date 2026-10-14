import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import * as kpiService from './kpi.service.js';
import type { DashboardQuery } from './kpi.schema.js';

/** GET /api/v1/quality-assurance/dashboard */
export async function getDashboard(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await kpiService.getDashboard(req.query as unknown as DashboardQuery));
}

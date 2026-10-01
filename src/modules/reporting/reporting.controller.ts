import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import * as reportingService from './reporting.service.js';
import type { ListSessionReportsQuery, SessionIdParam } from './reporting.schema.js';

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

/** GET /api/v1/reports/sessions */
export async function listSessionReports(req: Request, res: Response): Promise<void> {
  const { unitId, limit } = req.query as unknown as ListSessionReportsQuery;
  sendSuccess(res, await reportingService.listSessionReports(userId(req), { unitId, limit }));
}

/** GET /api/v1/reports/sessions/:sessionId/export */
export async function exportSessionCsv(req: Request, res: Response): Promise<void> {
  const { sessionId } = req.params as unknown as SessionIdParam;
  const { filename, csv } = await reportingService.exportSessionCsv(sessionId, userId(req));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('text/csv').send(csv);
}

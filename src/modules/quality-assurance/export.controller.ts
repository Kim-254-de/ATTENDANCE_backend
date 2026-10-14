import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { streamPdfToResponse } from '../../common/pdf/pdf-report.js';
import * as exportService from './export.service.js';
import type { AuditIdParam } from './audit.schema.js';
import type { DashboardQuery } from './kpi.schema.js';

/** Every export is attributed to the signed-in QA officer by name, drawn on the report's cover page. */
function generatedBy(req: Request): string {
  const name = req.auth?.qa?.fullName;
  if (!name) throw AppError.unauthenticated('Please sign in.');
  return name;
}

function sendCsv(res: Response, result: { filename: string; csv: string }): void {
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.type('text/csv').send(result.csv);
}

// --- Audits -----------------------------------------------------------------

export async function exportAuditsCsv(req: Request, res: Response): Promise<void> {
  sendCsv(res, await exportService.auditsCsv(req.query));
}

export async function exportAuditsPdf(req: Request, res: Response): Promise<void> {
  const doc = await exportService.auditsPdf(req.query, generatedBy(req));
  streamPdfToResponse(doc, res, `qa-audits-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export async function exportAuditDetailCsv(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  sendCsv(res, await exportService.auditDetailCsv(id));
}

export async function exportAuditDetailPdf(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as AuditIdParam;
  const doc = await exportService.auditDetailPdf(id, generatedBy(req));
  streamPdfToResponse(doc, res, `qa-audit-${id}.pdf`);
}

// --- CAPA ---------------------------------------------------------------

export async function exportCapaCsv(req: Request, res: Response): Promise<void> {
  sendCsv(res, await exportService.capaCsv(req.query));
}

export async function exportCapaPdf(req: Request, res: Response): Promise<void> {
  const doc = await exportService.capaPdf(req.query, generatedBy(req));
  streamPdfToResponse(doc, res, `qa-corrective-actions-${new Date().toISOString().slice(0, 10)}.pdf`);
}

// --- KPI dashboard --------------------------------------------------------

export async function exportDashboardCsv(req: Request, res: Response): Promise<void> {
  sendCsv(res, await exportService.dashboardCsv(req.query as unknown as DashboardQuery));
}

export async function exportDashboardPdf(req: Request, res: Response): Promise<void> {
  const doc = await exportService.dashboardPdf(req.query as unknown as DashboardQuery, generatedBy(req));
  streamPdfToResponse(doc, res, `qa-dashboard-${new Date().toISOString().slice(0, 10)}.pdf`);
}

import { createReportDocument, drawTableRow, type ReportOptions } from '../../common/pdf/pdf-report.js';
import { AppError } from '../../common/errors/index.js';
import * as auditRepository from './audit.repository.js';
import * as capaRepository from './capa.repository.js';
import type { ListAuditsQuery } from './audit.schema.js';
import type { ListCapaQuery } from './capa.schema.js';
import type { DashboardQuery } from './kpi.schema.js';
import * as kpiService from './kpi.service.js';

/**
 * CSV and PDF exports for every QA list/report. CSV follows the same
 * hand-rolled convention `reporting.service.ts` uses elsewhere in this
 * service (manual escaping, no library); PDF content is drawn here on top of
 * the shared cover-page/footer chrome from `src/common/pdf/pdf-report.ts`.
 */

const escapeCsv = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
const csvLine = (values: readonly string[]): string => values.map(escapeCsv).join(',');
const toDateStamp = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

/** Renders a filters object (whatever shape a list query has) into cover-page label lines. */
function stringifyFilters(filters: Record<string, unknown>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = String(value);
    }
  }
  return result;
}

// --- Audits -----------------------------------------------------------------

export interface CsvExport {
  filename: string;
  csv: string;
}

export async function auditsCsv(filters: ListAuditsQuery): Promise<CsvExport> {
  const rows = await auditRepository.list(filters);
  const lines = [
    csvLine(['Title', 'Target', 'Checklist Template', 'Lead Auditor', 'Scheduled Date', 'Status', 'Items', 'Findings Recorded']),
    ...rows.map((r) =>
      csvLine([
        r.title,
        r.target_department_name,
        r.checklist_template_name,
        r.lead_auditor_name,
        r.scheduled_date.toISOString().slice(0, 10),
        r.status,
        String(r.total_items),
        String(r.findings_count),
      ]),
    ),
  ];
  return { filename: `qa-audits-${toDateStamp()}.csv`, csv: lines.join('\n') };
}

const reportOptionsFromFilters = (title: string, generatedBy: string, filters: Record<string, unknown>): ReportOptions => ({
  title,
  generatedBy,
  filtersApplied: stringifyFilters(filters),
});

/** Audit-register table columns: title/target/status/scheduled/findings. */
const AUDITS_TABLE_WIDTHS = [140, 100, 80, 80, 90] as const;

export async function auditsPdf(filters: ListAuditsQuery, generatedBy: string): Promise<PDFKit.PDFDocument> {
  const rows = await auditRepository.list(filters);
  const doc = createReportDocument(reportOptionsFromFilters('Audit Register', generatedBy, filters));
  const [wTitle, wTarget, wStatus, wScheduled, wFindings] = AUDITS_TABLE_WIDTHS;

  drawTableRow(
    doc,
    [
      { text: 'Title', width: wTitle },
      { text: 'Target', width: wTarget },
      { text: 'Status', width: wStatus },
      { text: 'Scheduled', width: wScheduled },
      { text: 'Findings', width: wFindings },
    ],
    { bold: true },
  );
  for (const r of rows) {
    drawTableRow(doc, [
      { text: r.title, width: wTitle },
      { text: r.target_department_name, width: wTarget },
      { text: r.status, width: wStatus },
      { text: r.scheduled_date.toISOString().slice(0, 10), width: wScheduled },
      { text: `${r.findings_count}/${r.total_items}`, width: wFindings },
    ]);
  }
  if (rows.length === 0) doc.fontSize(10).fillColor('#6b7280').text('No audits match these filters.');
  return doc;
}

async function requireAuditForExport(auditId: string): Promise<auditRepository.AuditRow> {
  const audit = await auditRepository.findById(auditId);
  if (!audit) throw AppError.notFound('No such audit.');
  return audit;
}

export async function auditDetailCsv(auditId: string): Promise<CsvExport> {
  const audit = await requireAuditForExport(auditId);
  const findings = await auditRepository.getFindingsForExport(auditId, audit.checklist_template_id);
  const lines = [
    csvLine(['Standard', 'Checklist Item', 'Rating', 'Score', 'Evidence Notes', 'Recorded By', 'Updated At']),
    ...findings.map((f) =>
      csvLine([
        `${f.standard_code} — ${f.standard_title}`,
        f.prompt,
        f.rating ?? 'NOT RECORDED',
        f.score ?? '',
        f.evidence_notes ?? '',
        f.recorded_by_name ?? '',
        f.updated_at ? f.updated_at.toISOString() : '',
      ]),
    ),
  ];
  return { filename: `qa-audit-${audit.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`, csv: lines.join('\n') };
}

export async function auditDetailPdf(auditId: string, generatedBy: string): Promise<PDFKit.PDFDocument> {
  const audit = await requireAuditForExport(auditId);
  const findings = await auditRepository.getFindingsForExport(auditId, audit.checklist_template_id);

  const doc = createReportDocument({
    title: 'Internal Audit Report',
    subtitle: audit.title,
    generatedBy,
    filtersApplied: {
      Target: audit.target_department_name,
      'Lead Auditor': audit.lead_auditor_name,
      Status: audit.status,
      Scheduled: audit.scheduled_date.toISOString().slice(0, 10),
    },
  });

  const [wStandard, wPrompt, wRating, wScore] = [110, 170, 90, 50] as const;
  drawTableRow(
    doc,
    [
      { text: 'Standard', width: wStandard },
      { text: 'Checklist Item', width: wPrompt },
      { text: 'Rating', width: wRating },
      { text: 'Score', width: wScore },
    ],
    { bold: true },
  );
  for (const f of findings) {
    drawTableRow(doc, [
      { text: f.standard_code, width: wStandard },
      { text: f.prompt, width: wPrompt },
      { text: f.rating ?? 'NOT RECORDED', width: wRating },
      { text: f.score ?? '—', width: wScore },
    ]);
  }
  return doc;
}

// --- CAPA ---------------------------------------------------------------

export async function capaCsv(filters: ListCapaQuery): Promise<CsvExport> {
  const rows = await capaRepository.list(filters);
  const lines = [
    csvLine(['Audit', 'Standard', 'Description', 'Owner', 'Due Date', 'Status', 'Verified By', 'Verified At']),
    ...rows.map((r) =>
      csvLine([
        r.audit_title,
        `${r.standard_code} — ${r.standard_title}`,
        r.description,
        r.owner_name,
        r.due_date.toISOString().slice(0, 10),
        r.status,
        r.verified_by_name ?? '',
        r.verified_at ? r.verified_at.toISOString() : '',
      ]),
    ),
  ];
  return { filename: `qa-corrective-actions-${toDateStamp()}.csv`, csv: lines.join('\n') };
}

export async function capaPdf(filters: ListCapaQuery, generatedBy: string): Promise<PDFKit.PDFDocument> {
  const rows = await capaRepository.list(filters);
  const doc = createReportDocument(reportOptionsFromFilters('Corrective Action Register', generatedBy, filters));

  const [wAudit, wDescription, wOwner, wDue, wStatus] = [110, 170, 90, 60, 60] as const;
  drawTableRow(
    doc,
    [
      { text: 'Audit / Standard', width: wAudit },
      { text: 'Description', width: wDescription },
      { text: 'Owner', width: wOwner },
      { text: 'Due', width: wDue },
      { text: 'Status', width: wStatus },
    ],
    { bold: true },
  );
  for (const r of rows) {
    drawTableRow(doc, [
      { text: `${r.audit_title} (${r.standard_code})`, width: wAudit },
      { text: r.description, width: wDescription },
      { text: r.owner_name, width: wOwner },
      { text: r.due_date.toISOString().slice(0, 10), width: wDue },
      { text: r.status, width: wStatus },
    ]);
  }
  if (rows.length === 0) doc.fontSize(10).fillColor('#6b7280').text('No corrective actions match these filters.');
  return doc;
}

// --- KPI dashboard --------------------------------------------------------

export async function dashboardCsv(filters: DashboardQuery): Promise<CsvExport> {
  const dashboard = await kpiService.getDashboard(filters);
  const lines = [
    'Metric,Value',
    csvLine(['Audit completion rate (%)', dashboard.auditCompletionRate === null ? '' : String(dashboard.auditCompletionRate)]),
    csvLine(['Audits completed', String(dashboard.auditsCompleted)]),
    csvLine(['Audits total', String(dashboard.auditsTotal)]),
    csvLine(['Overdue corrective actions', String(dashboard.overdueCapaCount)]),
    '',
    csvLine(['Standard', 'Category', 'Avg Score', 'Sample Count']),
    ...dashboard.complianceByStandard.map((s) =>
      csvLine([`${s.standardCode} — ${s.standardTitle}`, s.category, s.avgScore === null ? '' : String(s.avgScore), String(s.sampleCount)]),
    ),
    '',
    csvLine(['Period', 'Department', 'Avg Attendance Rate (%)']),
    ...dashboard.attendanceTrends.map((t) => csvLine([t.periodStart, t.departmentName, String(t.avgAttendanceRate)])),
  ];
  return { filename: `qa-dashboard-${toDateStamp()}.csv`, csv: lines.join('\n') };
}

export async function dashboardPdf(filters: DashboardQuery, generatedBy: string): Promise<PDFKit.PDFDocument> {
  const dashboard = await kpiService.getDashboard(filters);
  const doc = createReportDocument(reportOptionsFromFilters('Quality Assurance Dashboard', generatedBy, filters));

  doc.fontSize(13).fillColor('#111827').text('Headline figures');
  doc.moveDown(0.3);
  doc
    .fontSize(10)
    .fillColor('#374151')
    .text(
      `Audit completion rate: ${dashboard.auditCompletionRate === null ? 'No audits yet' : `${dashboard.auditCompletionRate}%`} ` +
        `(${dashboard.auditsCompleted}/${dashboard.auditsTotal} completed)`,
    )
    .text(`Overdue corrective actions: ${dashboard.overdueCapaCount}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#111827').text('Compliance by standard');
  doc.moveDown(0.3);
  drawTableRow(
    doc,
    [
      { text: 'Standard', width: 220 },
      { text: 'Category', width: 150 },
      { text: 'Avg Score', width: 80 },
      { text: 'Sample', width: 60 },
    ],
    { bold: true },
  );
  for (const s of dashboard.complianceByStandard) {
    drawTableRow(doc, [
      { text: `${s.standardCode} — ${s.standardTitle}`, width: 220 },
      { text: s.category, width: 150 },
      { text: s.avgScore === null ? '—' : `${s.avgScore}%`, width: 80 },
      { text: String(s.sampleCount), width: 60 },
    ]);
  }
  if (dashboard.complianceByStandard.length === 0) {
    doc.fontSize(10).fillColor('#6b7280').text('No completed audits in range.');
  }
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#111827').text('Attendance trend by department');
  doc.moveDown(0.3);
  drawTableRow(
    doc,
    [
      { text: 'Period', width: 100 },
      { text: 'Department', width: 220 },
      { text: 'Avg Attendance Rate', width: 150 },
    ],
    { bold: true },
  );
  for (const t of dashboard.attendanceTrends) {
    drawTableRow(doc, [
      { text: t.periodStart, width: 100 },
      { text: t.departmentName, width: 220 },
      { text: `${t.avgAttendanceRate}%`, width: 150 },
    ]);
  }
  if (dashboard.attendanceTrends.length === 0) {
    doc.fontSize(10).fillColor('#6b7280').text('No measurable sessions in range.');
  }

  return doc;
}

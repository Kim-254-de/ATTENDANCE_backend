import { AppError } from '../../common/errors/index.js';
import { findSessionById } from '../session/index.js';
import * as reportingRepository from './reporting.repository.js';

export interface SessionReportDto {
  id: string;
  date: string;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  present: number;
  absent: number;
  total: number;
  /** 0–100. */
  rate: number;
  /** Display only, derived from real fields — nothing is stored under this name. */
  reference: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `QR-COSC100-0924`-style — matches the mockup's look without persisting anything new. */
function buildReference(unitCode: string, opensAt: Date): string {
  const code = unitCode.replace(/\s+/g, '');
  return `QR-${code}-${pad2(opensAt.getMonth() + 1)}${pad2(opensAt.getDate())}`;
}

const toDto = (row: reportingRepository.SessionReportRow): SessionReportDto => ({
  id: row.id,
  date: row.opensAt.toISOString(),
  unitId: row.unitId,
  unitCode: row.unitCode,
  unitName: row.unitName,
  present: row.present,
  absent: Math.max(0, row.total - row.present),
  total: row.total,
  rate: row.total > 0 ? Math.round((row.present / row.total) * 1000) / 10 : 0,
  reference: buildReference(row.unitCode, row.opensAt),
});

/** Backs both the Dashboard's "Recent Sessions" (small `limit`) and the Attendance page's full log. */
export async function listSessionReports(
  lecturerUserId: string,
  options: { unitId?: string; limit?: number } = {},
): Promise<SessionReportDto[]> {
  const rows = await reportingRepository.listSessionReports(lecturerUserId, options);
  return rows.map(toDto);
}

/** `Registration Number,Full Name,Status,Recorded At` — one row per ACTIVE allocation on the session's unit. */
export async function exportSessionCsv(
  sessionId: string,
  lecturerUserId: string,
): Promise<{ filename: string; csv: string }> {
  const session = await findSessionById(sessionId);
  if (!session) throw AppError.notFound('Session not found.');
  if (session.lecturerUserId !== lecturerUserId) {
    throw AppError.forbidden('This session belongs to another lecturer.');
  }

  const attendees = await reportingRepository.listSessionAttendeesForExport(sessionId, session.unitId);

  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [
    'Registration Number,Full Name,Status,Recorded At',
    ...attendees.map((a) =>
      [
        escape(a.registrationNumber ?? ''),
        escape(a.fullName ?? ''),
        a.recordedAt ? 'Present' : 'Absent',
        a.recordedAt ? a.recordedAt.toISOString() : '',
      ].join(','),
    ),
  ];

  return {
    filename: `${buildReference(session.unitCode, session.opensAt)}.csv`,
    csv: lines.join('\n'),
  };
}

import { AlignmentType, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';
import type { Meeting } from '../../integrations/generator/generator.client.js';
import type { BoardDto } from './teaching.service.js';

/**
 * The department's allocation form as PDF, Word and Excel, laid out like the
 * Word form departments send today:
 *
 *     THARAKA UNIVERSITY
 *     DEPARTMENT OF COMPUTER SCIENCE AND ICT
 *     2026/2027 SEMESTER 1 COURSE ALLOCATION
 *
 *     BSC.COMP SCI Y1S1 (120 Students)
 *     Course code | Course title | L | P | CF | Lecturer (FT/PT) | Phone [| Day, time & room]
 *     ...
 *     TOTAL                        L   P   CF
 *
 *     SERVICING FOR OTHER DEPARTMENTS
 *     ...
 *     Prepared by: <name>
 *
 * Phone numbers are printed only here, on the department's own download.
 * Once the Director has published the timetable, each class's day, time and
 * room is printed too.
 */

export type ExportFormat = 'pdf' | 'docx' | 'xlsx';

export const MEDIA: Record<ExportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const HEADERS = ['Course code', 'Course title', 'L', 'P', 'CF', 'Lecturer (FT/PT)', 'Phone'];
const WHEN = 'Day, time & room';
const SERVICING = 'SERVICING FOR OTHER DEPARTMENTS';

interface Block {
  heading: string;
  rows: string[][];
  totals: [number, number, number];
}

export interface Layout {
  titleLines: string[];
  own: Block[];
  servicing: Block[];
  preparedBy: string;
  withTimes: boolean;
  headers: string[];
}

const h = (value: number | null): string => (value === null ? '' : String(value));

const when = (meetings: Meeting[]): string =>
  meetings.map((m) => `${m.dayOfWeek} ${m.startTime}-${m.endTime}${m.room ? ` ${m.room}` : ''}`).join('; ');

/** One row per class (a unit, or one group of a split unit), under the first course that takes it. */
export function layout(board: BoardDto, preparedBy: string): Layout {
  const title = [
    env.QA_INSTITUTION_NAME.toUpperCase(),
    board.department.name.toUpperCase(),
    `${board.term.name.toUpperCase()} COURSE ALLOCATION`,
  ];
  const phones = new Map(board.lecturers.map((l) => [l.id, l.phone]));
  const withTimes = board.units.some((u) => u.groups.some((g) => g.meetings.length > 0));
  const own = new Map<string, Block>();
  const servicing = new Map<string, Block>();
  for (const unit of board.units) {
    for (const group of unit.groups) {
      const members = group.members.length ? group.members : [{ label: 'Other units', students: 0 }];
      const first = members[0]!;
      const heading = first.label + (first.students ? ` (${first.students} Students)` : '');
      const target = unit.servicing ? servicing : own;
      const block = target.get(heading) ?? { heading, rows: [], totals: [0, 0, 0] };
      target.set(heading, block);
      const others = members.slice(1).map((m) => m.label);
      const hours = [group.lectureHours, group.practicalHours, group.cfHours] as const;
      const row = [
        `${unit.code} ${group.label}`.trim(),
        unit.title + (others.length ? ` (with ${others.join(', ')})` : ''),
        ...hours.map(h),
        group.lecturer ?? 'To be allocated',
        (group.lecturerId && phones.get(group.lecturerId)) || '',
      ];
      if (withTimes) row.push(when(group.meetings) || 'Not timetabled');
      block.rows.push(row);
      hours.forEach((value, i) => (block.totals[i] = block.totals[i]! + (value ?? 0)));
    }
  }
  const sorted = (m: Map<string, Block>) => [...m.values()].sort((a, b) => a.heading.localeCompare(b.heading));
  return {
    titleLines: title,
    own: sorted(own),
    servicing: sorted(servicing),
    preparedBy,
    withTimes,
    headers: withTimes ? [...HEADERS, WHEN] : HEADERS,
  };
}

const sections = (doc: Layout): Array<[string | null, Block[]]> => [[null, doc.own], ...(doc.servicing.length ? [[SERVICING, doc.servicing] as [string, Block[]]] : [])];

const totalRow = (doc: Layout, block: Block): string[] => ['TOTAL', '', ...block.totals.map((t) => String(t)), '', ...Array<string>(doc.headers.length - 6).fill('')];

// -- PDF -------------------------------------------------------------------------------------------

export function buildPdf(doc: Layout): Promise<Buffer> {
  const MARGIN = 34;
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: doc.titleLines.at(-1) } });
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));

  const usable = pdf.page.width - MARGIN * 2;
  const weights = doc.withTimes ? [22, 40, 8, 8, 8, 40, 22, 36] : [28, 54, 9, 9, 9, 51, 24];
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / sum) * usable);
  const PAD = 3;

  const drawRow = (values: string[], bold: boolean, fill?: string) => {
    pdf.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const height = Math.max(...values.map((v, i) => pdf.heightOfString(v, { width: widths[i]! - PAD * 2 }))) + PAD * 2;
    if (pdf.y + height > pdf.page.height - MARGIN) pdf.addPage();
    const top = pdf.y;
    let x = MARGIN;
    values.forEach((v, i) => {
      if (fill) pdf.rect(x, top, widths[i]!, height).fill(fill).fillColor('#000000');
      pdf.rect(x, top, widths[i]!, height).lineWidth(0.4).strokeColor('#888888').stroke();
      pdf.text(v, x + PAD, top + PAD, { width: widths[i]! - PAD * 2 });
      x += widths[i]!;
    });
    pdf.x = MARGIN;
    pdf.y = top + height;
  };

  for (const line of doc.titleLines) pdf.font('Helvetica-Bold').fontSize(12).text(line, { align: 'center' });
  pdf.moveDown(1);
  for (const [name, blocks] of sections(doc)) {
    if (name) {
      pdf.moveDown(0.8);
      pdf.font('Helvetica-Bold').fontSize(11).text(name, MARGIN);
    }
    for (const block of blocks) {
      pdf.moveDown(0.6);
      pdf.font('Helvetica-Bold').fontSize(9).text(block.heading, MARGIN);
      pdf.moveDown(0.2);
      drawRow(doc.headers, true, '#e2e8f0');
      for (const row of block.rows) drawRow(row, false);
      drawRow(totalRow(doc, block), true);
    }
  }
  if (!doc.own.length && !doc.servicing.length) pdf.font('Helvetica').fontSize(9).text('No units entered yet.');
  pdf.moveDown(2);
  pdf.font('Helvetica').fontSize(9).text(`Prepared by: ${doc.preparedBy}`, MARGIN);
  pdf.end();
  return done;
}

// -- Word ------------------------------------------------------------------------------------------

export async function buildDocx(doc: Layout): Promise<Buffer> {
  const children: Array<Paragraph | Table> = doc.titleLines.map(
    (line) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: line, bold: true, size: 24 })] }),
  );
  const weights = doc.withTimes ? [11, 20, 4, 4, 4, 19, 11, 17] : [13, 28, 5, 5, 5, 28, 16];
  const cell = (text: string, bold: boolean, i: number) =>
    new TableCell({
      width: { size: weights[i]!, type: WidthType.PERCENTAGE },
      children: [new Paragraph({ children: [new TextRun({ text, bold, size: 16 })] })],
    });
  for (const [name, blocks] of sections(doc)) {
    if (name) children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: name, bold: true, size: 22 })] }));
    for (const block of blocks) {
      children.push(new Paragraph({ spacing: { before: 160 }, children: [new TextRun({ text: block.heading, bold: true, size: 18 })] }));
      const rows = [doc.headers, ...block.rows, totalRow(doc, block)];
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((values, r) => new TableRow({ children: values.map((v, i) => cell(v, r === 0 || r === rows.length - 1, i)) })),
        }),
      );
    }
  }
  if (!doc.own.length && !doc.servicing.length) children.push(new Paragraph('No units entered yet.'));
  children.push(new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: `Prepared by: ${doc.preparedBy}`, size: 18 })] }));
  const word = new Document({
    title: doc.titleLines.at(-1),
    sections: [{ properties: { page: { margin: { top: 850, bottom: 850, left: 850, right: 850 } } }, children }],
  });
  return Packer.toBuffer(word);
}

// -- Excel -----------------------------------------------------------------------------------------

export async function buildXlsx(doc: Layout): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Allocation');
  const thin = { style: 'thin' as const, color: { argb: 'FF999999' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  [14, 44, 6, 6, 6, 34, 16, 34].slice(0, doc.headers.length).forEach((w, i) => (sheet.getColumn(i + 1).width = w));
  let r = 1;
  for (const line of doc.titleLines) {
    sheet.mergeCells(r, 1, r, doc.headers.length);
    const c = sheet.getCell(r, 1);
    c.value = line;
    c.font = { bold: true, size: 12 };
    c.alignment = { horizontal: 'center' };
    r++;
  }
  r++;
  for (const [name, blocks] of sections(doc)) {
    if (name) {
      sheet.getCell(r, 1).value = name;
      sheet.getCell(r, 1).font = { bold: true, size: 11 };
      r += 2;
    }
    for (const block of blocks) {
      sheet.getCell(r, 1).value = block.heading;
      sheet.getCell(r, 1).font = { bold: true };
      r++;
      const rows: Array<[string[], boolean]> = [[doc.headers, true], ...block.rows.map((row): [string[], boolean] => [row, false]), [totalRow(doc, block), true]];
      for (const [values, bold] of rows) {
        values.forEach((value, i) => {
          const c = sheet.getCell(r, i + 1);
          const number = i >= 2 && i <= 4 && value !== '' && values !== doc.headers;
          c.value = number ? Number(value) : value;
          c.border = border;
          c.font = { bold };
          c.alignment = { wrapText: true, vertical: 'top' };
          if (values === doc.headers) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
        });
        r++;
      }
      r++;
    }
  }
  sheet.getCell(r + 1, 1).value = `Prepared by: ${doc.preparedBy}`;
  return Buffer.from(await book.xlsx.writeBuffer());
}

export const BUILDERS: Record<ExportFormat, (doc: Layout) => Promise<Buffer>> = { pdf: buildPdf, docx: buildDocx, xlsx: buildXlsx };

// -- reading a workbook for "Paste from Excel" -----------------------------------------------------

const MAX_ROWS = 5000;
const MAX_COLUMNS = 60;

/**
 * Every sheet with something in it, as rows of text cells (empty rows
 * dropped). The browser can't read .xlsx itself, so it sends the file here;
 * nothing is stored.
 */
export async function readWorkbook(content: Buffer): Promise<Array<{ name: string; rows: string[][] }>> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(content as unknown as ArrayBuffer);
  } catch {
    throw new WorkbookError("This isn't an Excel workbook (.xlsx). In Excel, use File > Save As > Excel Workbook (.xlsx) and try again.");
  }
  const sheets: Array<{ name: string; rows: string[][] }> = [];
  book.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let i = 1; i <= Math.min(row.cellCount, MAX_COLUMNS); i++) cells.push(text(row.getCell(i).value));
      while (cells.length && cells.at(-1) === '') cells.pop();
      if (!cells.length) return;
      if (rows.length === MAX_ROWS) throw new WorkbookError(`Sheet “${sheet.name}” has more than ${MAX_ROWS} rows. Split it into smaller files.`);
      rows.push(cells);
    });
    if (rows.length) sheets.push({ name: sheet.name, rows });
  });
  if (!sheets.length) throw new WorkbookError('The workbook has no filled-in cells.');
  return sheets;
}

export class WorkbookError extends Error {}

function text(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'object') {
    if ('result' in value) return text(value.result);
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return String(value.text);
    return '';
  }
  // Tabs and line breaks inside a cell would split it when the browser reads the rows.
  return String(value).split(/\s+/).filter(Boolean).join(' ');
}

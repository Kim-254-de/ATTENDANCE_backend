import { AlignmentType, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import PDFDocument from 'pdfkit';
import { env } from '../../config/env.js';

/**
 * The letter a department sends with its exam drafts for moderation, as Word
 * and PDF, built from the paper list (replacing the typed letter):
 *
 *     THARAKA UNIVERSITY
 *     DEPARTMENT OF COMPUTER SCIENCE AND ICT
 *     <date>
 *     <moderator's name and address>
 *     RE: MODERATION OF <TERM> <DEPARTMENT> EXAMINATION DRAFTS
 *     <covering paragraph>
 *     S/NO | UNIT CODE(S) | UNIT TITLE
 *     ...
 *     <signature block>
 *     CC: Registrar A&A
 */

export interface Letter {
  department: string;
  term: string;
  date: string;
  /** Name, then address lines. */
  moderator: string[];
  /** [codes, title] per paper. */
  papers: Array<[string, string]>;
  signedBy: string;
}

export type LetterFormat = 'pdf' | 'docx';

export const LETTER_MEDIA: Record<LetterFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const HEADERS = ['S/NO', 'UNIT CODE(S)', 'UNIT TITLE'];
const heading = (l: Letter) => `RE: MODERATION OF ${l.term.toUpperCase()} ${l.department.toUpperCase()} EXAMINATION DRAFTS`;
const body = (l: Letter) =>
  `Please find enclosed ${l.papers.length} examination drafts from the ${l.department} for the ${l.term} examinations, listed below, for your moderation.`;
const rows = (l: Letter) => l.papers.map(([codes, title], i) => [String(i + 1), codes, title]);

async function buildDocx(l: Letter): Promise<Buffer> {
  const centred = (text: string) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, size: 26 })] });
  const line = (text: string, after = 0) => new Paragraph({ spacing: { after }, children: [new TextRun({ text, size: 22 })] });
  const widths = [10, 30, 60];
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [HEADERS, ...rows(l)].map(
      (values, r) =>
        new TableRow({
          children: values.map(
            (v, i) =>
              new TableCell({
                width: { size: widths[i]!, type: WidthType.PERCENTAGE },
                children: [new Paragraph({ children: [new TextRun({ text: v, bold: r === 0, size: 20 })] })],
              }),
          ),
        }),
    ),
  });
  const doc = new Document({
    title: heading(l),
    sections: [
      {
        properties: { page: { margin: { top: 850, bottom: 850, left: 1134, right: 1134 } } },
        children: [
          centred(env.QA_INSTITUTION_NAME.toUpperCase()),
          centred(l.department.toUpperCase()),
          line(''),
          line(l.date, 160),
          ...l.moderator.map((m) => line(m)),
          line(''),
          new Paragraph({ children: [new TextRun({ text: heading(l), bold: true, size: 22 })] }),
          line(body(l), 160),
          table,
          line(''),
          line('Yours faithfully,', 480),
          line(l.signedBy),
          line(`Chair, ${l.department}`),
          line(''),
          line('CC: Registrar A&A'),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function buildPdf(l: Letter): Promise<Buffer> {
  const MARGIN = 50;
  const pdf = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: heading(l) } });
  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on('end', () => resolve(Buffer.concat(chunks))));
  const usable = pdf.page.width - MARGIN * 2;
  const widths = [0.1, 0.3, 0.6].map((w) => w * usable);

  pdf.font('Helvetica-Bold').fontSize(13).text(env.QA_INSTITUTION_NAME.toUpperCase(), { align: 'center' }).text(l.department.toUpperCase(), { align: 'center' });
  pdf.moveDown(1.5).font('Helvetica').fontSize(11).text(l.date, MARGIN).moveDown(0.5);
  for (const m of l.moderator) pdf.text(m);
  pdf.moveDown(1).font('Helvetica-Bold').text(heading(l)).moveDown(0.3).font('Helvetica').text(body(l)).moveDown(0.6);

  const PAD = 4;
  for (const [r, values] of [HEADERS, ...rows(l)].entries()) {
    pdf.font(r === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    const height = Math.max(...values.map((v, i) => pdf.heightOfString(v, { width: widths[i]! - PAD * 2 }))) + PAD * 2;
    if (pdf.y + height > pdf.page.height - MARGIN) pdf.addPage();
    const top = pdf.y;
    let x = MARGIN;
    values.forEach((v, i) => {
      if (r === 0) pdf.rect(x, top, widths[i]!, height).fill('#e2e8f0').fillColor('#000000');
      pdf.rect(x, top, widths[i]!, height).lineWidth(0.4).strokeColor('#888888').stroke();
      pdf.text(v, x + PAD, top + PAD, { width: widths[i]! - PAD * 2 });
      x += widths[i]!;
    });
    pdf.x = MARGIN;
    pdf.y = top + height;
  }
  pdf.moveDown(1.5).font('Helvetica').fontSize(11).text('Yours faithfully,', MARGIN).moveDown(2.5);
  pdf.text(l.signedBy).text(`Chair, ${l.department}`).moveDown(1).text('CC: Registrar A&A');
  pdf.end();
  return done;
}

export const LETTER_BUILDERS: Record<LetterFormat, (l: Letter) => Promise<Buffer>> = { pdf: buildPdf, docx: buildDocx };

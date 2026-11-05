import JSZip from 'jszip';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Sitting } from './exams.repository.js';

/**
 * Reads the exam list a department writes for moderation (the Word letter
 * with its table of drafts) into papers: each table row with a unit code is
 * one paper, its title the next cell with words in it.
 *
 *     | 1 | BEEM 111        | ENTREPRENEURSHIP        |
 *     |   | COSC 0172/0170  | Programming             |   two codes, one paper
 *     |   | Math 241 odel   | Linear Algebra          |   the ODEL paper
 *
 * A row or paragraph with words and no code is a heading ("HISTORY",
 * "ODEL/PART-TIME DRAFTS"); papers under an ODEL, part-time or distance
 * heading are ODEL papers until the next heading. A unit listed a second time
 * with nothing saying ODEL is its ODEL paper (departments list the regular
 * paper first, then the ODEL one); a third listing is a duplicate. A title
 * saying ODEL ("Gross Anatomy ODEL") marks the ODEL paper too. Under a class
 * heading ("BSc Nursing Y1S1 (107 students)"), as in a course allocation, a unit
 * listed again is one paper another class sits, not an ODEL paper. Codes are tidied ("Math
 * 241" is "MATH 241"; "COSC 0172/0170" is COSC 0172 and COSC 0170). Nothing
 * is decided here about whether a code exists: the review does that.
 *
 * A heading can name a class and its size, as a course allocation does ("BSc
 * Nursing (Sep 2026) Y1S1 (107 students)"): classOf reads that.
 */

export interface ListedEntry {
  /** 1-based, in reading order: how the review names a row. */
  line: number;
  codes: string[];
  title: string;
  /** The heading the row sits under, '' before any. */
  section: string;
  sitting: Sitting;
  /** The line this one repeats, when it was taken as that unit's ODEL paper for being listed a second time. */
  secondListingOf: number | null;
}

const W = 'w:';
const MAX_BYTES = 5 * 1024 * 1024;

const CLASS_YEAR = /\bY(?:EAR)?\s*([1-9])(?:\s*,?\s*S(?:EM(?:ESTER)?)?\s*([1-3]))?\b/i;
const CLASS_STUDENTS = /\b(\d{1,4})\s*STUDENTS?\b/i;
const CLASS_END = /\(|\b(?:19|20)\d{2}\b/;

export interface HeadingClass {
  name: string;
  year: number | null;
  semester: number | null;
  students: number | null;
}

/**
 * The class a heading names: "BACHELOR OF SCIENCE NURSING (SEPTEMBER 2026 INTAKE)
 * Y1S1 (107 STUDENTS) MISHECK 0793315005". Null for a heading with neither a year
 * nor a number ("SERVICING UNITS"); a number of 0 says nothing.
 */
export function classOf(heading: string): HeadingClass | null {
  const year = CLASS_YEAR.exec(heading);
  const students = CLASS_STUDENTS.exec(heading);
  if (!year && !students) return null;
  const cut = Math.min(...[year, students, CLASS_END.exec(heading)].filter((m) => m !== null).map((m) => m.index));
  const name = heading.slice(0, cut).split(':').pop()!.replace(/\s+/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '');
  if (!/[A-Za-z]{2}/.test(name)) return null;
  return {
    name: name.slice(0, 120),
    year: year ? Number(year[1]) : null,
    semester: year?.[2] ? Number(year[2]) : null,
    students: students ? Number(students[1]) || null : null,
  };
}

/** A whole code cell: one or more codes separated by "/", maybe followed by "odel". */
const CODE_CELL = /^([A-Za-z]{2,6})\s*-?\s*(\d{2,5}[A-Za-z]?)((?:\s*[/&,]\s*(?:[A-Za-z]{2,6}\s*-?\s*)?\d{2,5}[A-Za-z]?)*)(?:\s*[-(]?\s*(odel|part[\s-]?time)\s*\)?)?\s*$/i;
/** "Gross Anatomy ODEL", "General genetics-Odel", "Pasture & Fodder Crops (ODEL)". */
const ODEL_TITLE = /(?:^|[\s(-])odel\b/i;
const ODEL_HEADING = /\b(odel|part[\s-]?time|distance|open\s+and\s+distance)\b/i;
const HEADER_WORDS = /^(s\/?\s*no\.?|no\.?|#|unit\s*code|code|unit\s*(name|title)|title|course\s*(code|title)|comments?|remarks?)$/i;

/** "Math 241" -> "MATH 241"; "COSC 0172/0170" -> ["COSC 0172", "COSC 0170"]. Null when the cell isn't codes. */
export function codesOf(cell: string): { codes: string[]; odel: boolean } | null {
  const text = cell.replace(/\s+/g, ' ').trim();
  const m = CODE_CELL.exec(text);
  if (!m) return null;
  let prefix = m[1]!.toUpperCase();
  const codes = [`${prefix} ${m[2]!.toUpperCase()}`];
  for (const part of (m[3] ?? '').split(/[/&,]/).map((p) => p.trim()).filter(Boolean)) {
    const pm = /^([A-Za-z]{2,6})?\s*-?\s*(\d{2,5}[A-Za-z]?)$/.exec(part);
    if (!pm) return null;
    if (pm[1]) prefix = pm[1].toUpperCase();
    codes.push(`${prefix} ${pm[2]!.toUpperCase()}`);
  }
  return { codes: [...new Set(codes)], odel: !!m[4] };
}

interface Node {
  tag: string;
  children: Node[];
  text: string;
}

/** A small reader for document.xml: elements and their text, enough to walk paragraphs, tables, rows and cells. */
function parseXml(xml: string): Node {
  const root: Node = { tag: '#root', children: [], text: '' };
  const stack: Node[] = [root];
  const token = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m = token.exec(xml); m; m = token.exec(xml)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (top.tag === `${W}t`) top.text += decode(m[5]);
      continue;
    }
    const [, closing, tag, , selfClosing] = m;
    if (tag!.startsWith('?') || tag!.startsWith('!')) continue;
    if (closing) {
      while (stack.length > 1 && stack.pop()!.tag !== tag) { /* unwind to the matching tag */ }
      continue;
    }
    const node: Node = { tag: tag!, children: [], text: '' };
    if (tag === `${W}tab` || tag === `${W}br`) node.text = ' ';
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

const textOf = (n: Node): string => (n.tag === `${W}t` || n.tag === `${W}tab` || n.tag === `${W}br` ? n.text : n.children.map(textOf).join(''));
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Every cell of a table row as text, nested tables flattened into their cell. */
const cellsOf = (row: Node): string[] => row.children.filter((c) => c.tag === `${W}tc`).map((c) => clean(textOf(c)));

/** The paragraphs and tables of the body in order, tables yielded as their rows. */
function* blocks(body: Node): Generator<{ kind: 'p'; text: string } | { kind: 'row'; cells: string[] }> {
  for (const el of body.children) {
    if (el.tag === `${W}p`) yield { kind: 'p', text: clean(textOf(el)) };
    else if (el.tag === `${W}tbl`) {
      for (const row of el.children.filter((r) => r.tag === `${W}tr`)) yield { kind: 'row', cells: cellsOf(row) };
    } else if (el.tag === `${W}sdt`) {
      const content = el.children.find((c) => c.tag === `${W}sdtContent`);
      if (content) yield* blocks(content);
    }
  }
}

/** Words, not a serial number, a header word or punctuation. */
const isWords = (s: string) => /[A-Za-z]{2}/.test(s) && !HEADER_WORDS.test(s);

export async function readExamList(file: Buffer): Promise<ListedEntry[]> {
  if (file.length > MAX_BYTES) throw new AppError(413, ErrorCode.VALIDATION_FAILED, 'The document is over 5 MB.');
  let xml: string | undefined;
  try {
    const zip = await JSZip.loadAsync(file);
    xml = await zip.file('word/document.xml')?.async('string');
  } catch {
    xml = undefined;
  }
  if (!xml) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'That is not a Word document (.docx). Save it as .docx and upload it again.');
  }
  const root = parseXml(xml);
  const body = root.children.find((n) => n.tag === `${W}document`)?.children.find((n) => n.tag === `${W}body`);
  if (!body) throw new AppError(422, ErrorCode.VALIDATION_FAILED, "The document's text couldn't be read.");

  const entries: ListedEntry[] = [];
  let section = '';
  let sectionOdel = false;
  const heading = (text: string) => {
    section = text.slice(0, 200);
    sectionOdel = ODEL_HEADING.test(text);
  };
  for (const block of blocks(body)) {
    if (block.kind === 'p') {
      // A short line on its own in capitals (or naming ODEL) is a heading; letter text ("Dear Sir, ...") isn't.
      const t = block.text;
      const plain = t.length <= 80 && (ODEL_HEADING.test(t) || (/[A-Z]{3}/.test(t) && t === t.toUpperCase()));
      if (t && t.length <= 200 && !/[.,;]$/.test(t) && (plain || classOf(t)?.students)) heading(t);
      continue;
    }
    const at = block.cells.findIndex((c) => codesOf(c) !== null);
    if (at < 0) {
      const words = block.cells.filter(isWords);
      if (words.length === 1 && block.cells.filter((c) => c).length <= 2) heading(words[0]!);
      continue;
    }
    const found = codesOf(block.cells[at]!)!;
    const title = block.cells.slice(at + 1).find(isWords) ?? '';
    entries.push({
      line: entries.length + 1,
      codes: found.codes,
      title: title.slice(0, 255),
      section,
      sitting: found.odel || sectionOdel || ODEL_TITLE.test(title) ? 'odel' : 'regular',
      secondListingOf: null,
    });
  }
  if (entries.length === 0) {
    throw new AppError(422, ErrorCode.VALIDATION_FAILED, 'No unit codes were found in the tables of this document.');
  }
  return secondListingsAsOdel(entries);
}

/** The codes of a paper however they're written or ordered: "COSC 130/BITE 131" = "BITE131/COSC130". */
export const codesKey = (codes: string[]): string =>
  codes.map((c) => c.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).sort().join('/');

/**
 * A unit listed twice with nothing saying ODEL: the second listing is its ODEL
 * paper, unless the letter already has one, or either listing is under a class
 * heading (a course allocation: another class sitting the same paper). Later listings stay
 * as they are (the review shows them as duplicates).
 */
export function secondListingsAsOdel(entries: ListedEntry[]): ListedEntry[] {
  const regularLine = new Map<string, number>();
  const sectionOf = new Map(entries.map((x) => [x.line, x.section] as const));
  const byClass = (a: string, b: string) => classOf(a) !== null || classOf(b) !== null;
  const hasOdel = new Set<string>();
  for (const x of entries) if (x.sitting === 'odel') hasOdel.add(codesKey(x.codes));
  return entries.map((x) => {
    const key = codesKey(x.codes);
    if (x.sitting === 'odel') return x;
    const first = regularLine.get(key);
    if (first === undefined) {
      regularLine.set(key, x.line);
      return x;
    }
    if (hasOdel.has(key) || byClass(sectionOf.get(first) ?? '', x.section)) return x;
    hasOdel.add(key);
    return { ...x, sitting: 'odel', secondListingOf: first };
  });
}

import type { PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { logger } from '../../config/logger.js';
import { transaction } from '../../db/database.js';
import { AuditAction } from '../../db/types.js';
import { smartttClient, type SmartttUnitEnrolment } from '../../integrations/smarttt/index.js';
import { classOf, codesKey, readExamList, type ListedEntry } from './exam-list.read.js';
import * as examsRepo from './exams.repository.js';
import type { ListedRow, ListedRowValues, PaperRow, Sitting } from './exams.repository.js';
import { board, EXAMS_KIND, isGuessedRow, isListed, loadExamTerm, publish, type ExamBoardDto } from './exams.service.js';
import { compact } from './teaching.repository.js';
import { audit, invalid, writeTeaching, type Ctx } from './teaching.service.js';

/**
 * The department's exam list, uploaded instead of built from its units: the
 * Word document it sends for moderation (exam-list.read.ts), reviewed, then
 * saved as listed papers. Each listed paper's classes are those taking its
 * units on SMARTTT's master timetable (so the Generator keeps them from
 * clashing even before anyone syncs), and those of the students who synced
 * them; numbers are who synced. The department can correct any number, add a
 * class or remove one, and what it set stays when SMARTTT is read again.
 * SMARTTT is read again whenever the Generator imports the papers, so the
 * Director plans with the latest classes and syncs.
 *
 * ODEL and part-time students sit the ODEL paper of a unit when it has one;
 * when the unit has only a regular paper they sit that one, as a class row
 * of their own ("BSC.CS Y2S1 (ODEL)").
 *
 * A letter's heading can name a class and its size. That number is the class's on
 * each paper under the heading, and uploading a letter again overwrites what the
 * class had, a number typed earlier too. A class the letter gives no number keeps
 * what it has, and the department or the Director can enter one.
 */

const exams = <T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>, whilePublished = false) =>
  writeTeaching(ctx, work, { kind: EXAMS_KIND, whilePublished });

/** One paper per set of codes and sitting: "COSC 130/BITE 131" and "BITE 131/COSC 130" are the same paper. */
const paperKey = (codes: string[], sitting: Sitting) => `${codes.map(compact).sort().join('/')}|${sitting}`;
const rowKey = (r: { programme: string; year: number; semester: number; stream: string }) =>
  `${compact(r.programme)}|${r.year}|${r.semester}|${compact(r.stream)}`;

type Enrolment = { available: true; units: Map<string, SmartttUnitEnrolment>; unknown: Set<string> } | { available: false; reason: string };

async function enrolment(codes: string[]): Promise<Enrolment> {
  const asked = [...new Set(codes)];
  if (asked.length === 0) return { available: true, units: new Map(), unknown: new Set() };
  const result = await smartttClient.unitEnrolment(asked);
  if (result.status === 'DISABLED') return { available: false, reason: 'SMARTTT is not connected, so student numbers have to be entered.' };
  if (result.status !== 'FOUND') return { available: false, reason: result.reason };
  const units = new Map<string, SmartttUnitEnrolment>();
  for (const [code, unit] of result.units) units.set(compact(code), unit);
  return { available: true, units, unknown: new Set(result.unknown.map(compact)) };
}

/**
 * Who sits a paper of these codes and sitting, by class row, from SMARTTT. A
 * class taking two of its codes counts once, at the larger number.
 */
function smartttRows(e: Enrolment & { available: true }, codes: string[], sitting: Sitting, odelTwin: boolean): Map<string, ListedRowValues> {
  const out = new Map<string, ListedRowValues>();
  for (const code of codes) {
    for (const r of e.units.get(compact(code))?.rows ?? []) {
      if (sitting === 'odel' ? r.sitting !== 'odel' : r.sitting === 'odel' && odelTwin) continue;
      const row = {
        programme: r.programme,
        year: Math.max(1, Math.min(10, r.year || 1)),
        semester: Math.max(1, Math.min(3, r.semester || 1)),
        // ODEL students sitting a regular paper are a class row of their own.
        stream: r.stream || (r.sitting === 'odel' ? 'ODEL' : ''),
      };
      const key = rowKey(row);
      const had = out.get(key);
      if (!had || had.students < r.students) {
        out.set(key, { ...row, students: r.students, smartttStudents: r.students, edited: false });
      }
    }
  }
  return out;
}

/**
 * Fresh SMARTTT classes and counts over the rows a paper has: a row the
 * department set keeps its number. A class guessed from the code gives way to
 * the real classes; a number typed for it moves to them when they have none
 * (shared out evenly when there are several), so the paper keeps its seats.
 */
function merged(p: PaperRow, fresh: Map<string, ListedRowValues>): ListedRowValues[] {
  const out = new Map<string, ListedRowValues>();
  const guesses: ListedRow[] = [];
  for (const r of p.rows) {
    if (!r.edited) continue;
    const now = fresh.get(rowKey(r));
    if (!now && isGuessedRow(p, r)) {
      guesses.push(r);
      continue;
    }
    out.set(rowKey(r), { ...r, smartttStudents: now ? now.students : r.smartttStudents === null ? null : 0 });
  }
  for (const [key, r] of fresh) if (!out.has(key)) out.set(key, r);
  const real = [...out.values()].filter((r) => r.students > 0 || !r.edited);
  if (real.length === 0) {
    for (const r of guesses) out.set(rowKey(r), r);
  } else if (real.every((r) => r.students === 0)) {
    const typed = guesses.reduce((n, r) => n + r.students, 0);
    if (typed > 0) {
      const share = Math.floor(typed / real.length);
      real.forEach((r, i) => {
        out.set(rowKey(r), { ...r, students: share + (i < typed % real.length ? 1 : 0), edited: true });
      });
    }
  }
  return [...out.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

export interface LetterClassInput {
  programme: string;
  year: number;
  semester: number;
  students: number;
}

/**
 * The classes a letter names, over a paper's rows. The letter's number is the
 * whole class's, so the class's other rows (its streams, or the timetable's other
 * semester) go to 0, which keeps SMARTTT from bringing them back, and a guess gives way.
 */
function withLetterClasses(paper: PaperRow | null, rows: ListedRowValues[], classes: LetterClassInput[] | undefined, sitting: Sitting): ListedRowValues[] {
  if (!classes?.length) return rows;
  const out = new Map(rows.map((r) => [rowKey(r), r] as const));
  if (paper) for (const r of paper.rows) if (isGuessedRow(paper, r)) out.delete(rowKey(r));
  const stream = sitting === 'odel' ? 'ODEL' : '';
  const named = new Set(classes.map((c) => rowKey({ ...c, stream })));
  for (const c of classes) {
    const programme = c.programme.trim().toUpperCase();
    let smartttStudents: number | null = null;
    for (const [key, r] of [...out]) {
      if (compact(r.programme) !== compact(programme) || r.year !== c.year) continue;
      if (sitting !== 'odel' && r.stream.trim().toUpperCase() === 'ODEL') continue;
      if (r.smartttStudents !== null) smartttStudents = (smartttStudents ?? 0) + r.smartttStudents;
      if (named.has(key)) continue;
      if (r.smartttStudents === null) out.delete(key);
      else out.set(key, { ...r, students: 0, edited: true });
    }
    const row = { programme, year: c.year, semester: c.semester, stream, students: c.students, smartttStudents, edited: true };
    out.set(rowKey(row), row);
  }
  return [...out.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

/** Is there an ODEL paper of any of these codes in the term (any department), or about to be? */
function hasOdelTwin(codes: string[], papers: Array<{ codes: string[]; sitting: Sitting }>): boolean {
  const mine = new Set(codes.map(compact));
  return papers.some((p) => p.sitting === 'odel' && p.codes.some((c) => mine.has(compact(c))));
}

// -- the classes a letter names --------------------------------------------------------------------

export interface LetterClass {
  id: string;
  heading: string;
  name: string;
  /** Null when neither the letter nor the timetable says: the department checks it. */
  year: number | null;
  semester: number | null;
  students: number;
  /** SMARTTT's programme, when exactly one has this name. */
  programme: string;
}

const DEGREE_WORDS = /\b(BACHELORS?|OF|SCIENCE|IN|BSC|B\s*SC|AND|THE)\b/g;
/** 'BACHELOR OF SCIENCE IN NURSING', 'BSc Nursing' -> 'NURSING': how a class is matched to a programme. */
const nameKey = (name: string) => compact(name.toUpperCase().replace(/\./g, ' ').replace(DEGREE_WORDS, ' '));

type Programme = { code: string; name: string };

/** The numbered classes in the letter's headings, and which of them each line sits under. */
function letterClasses(entries: ListedEntry[], programmes: Programme[], e: Enrolment): { classes: LetterClass[]; ofLine: Map<number, string> } {
  const codes = new Map<string, Set<string>>();
  for (const p of programmes) {
    const key = nameKey(p.name);
    if (key) codes.set(key, (codes.get(key) ?? new Set()).add(p.code));
  }
  const classes = new Map<string, LetterClass>();
  const ofLine = new Map<number, string>();
  for (const x of entries) {
    const c = x.section ? classOf(x.section) : null;
    if (!c?.students) continue;
    const key = nameKey(c.name);
    const id = `${key}|${c.year ?? ''}|${c.semester ?? ''}`;
    ofLine.set(x.line, id);
    if (classes.has(id)) continue;
    const found = [...(codes.get(key) ?? [])];
    classes.set(id, { id, heading: x.section, name: c.name, year: c.year, semester: c.semester, students: c.students, programme: found.length === 1 ? found[0]! : '' });
  }
  // What the letter leaves out, from the timetable when it has only one answer for the class's own papers.
  if (e.available) {
    for (const c of classes.values()) {
      if (!c.programme || (c.year !== null && c.semester !== null)) continue;
      const rows = entries
        .filter((x) => ofLine.get(x.line) === c.id)
        .flatMap((x) => x.codes.flatMap((code) => e.units.get(compact(code))?.rows ?? []))
        .filter((r) => compact(r.programme) === compact(c.programme) && (c.year === null || r.year === c.year));
      const seen = new Set(rows.map((r) => `${r.year}|${r.semester ?? ''}`));
      if (seen.size === 1 && rows[0]) {
        c.year = rows[0].year;
        c.semester ??= rows[0].semester;
      }
    }
  }
  return { classes: [...classes.values()], ofLine };
}

// -- review ----------------------------------------------------------------------------------------

export interface ReviewEntry extends ListedEntry {
  /** SMARTTT's students for this sitting; null when SMARTTT couldn't be read. */
  students: number | null;
  /** The classes taking it: on the master timetable (0 until someone syncs) or by who synced. */
  classRows: Array<{ label: string; students: number }>;
  /** Codes SMARTTT has no unit for: a typo, or a unit it doesn't know. */
  unknownCodes: string[];
  /** The earlier line in this document with the same paper. */
  duplicateOf: number | null;
  /** Other departments with a paper of any of these codes and this sitting. */
  otherDepartments: string[];
  /** Your paper this updates (title), rather than a new one. */
  existingPaperId: string | null;
  /**
   * Your regular paper of these codes that this ODEL line turns into an ODEL paper, keeping its
   * examiner, invigilators and numbers: the letter lists the unit only as ODEL now. Null otherwise.
   */
  switchesPaperId: string | null;
  /** Who teaches it in SMARTTT, and their id on your lecturer list when they're on it. */
  examiner: { lecturerId: string | null; name: string; staffNumber: string } | null;
  /** The classes the letter names for this paper, under any of its lines: ids in `classes`. */
  letterClasses: string[];
}

export interface ReviewDto {
  entries: ReviewEntry[];
  /** The classes the letter's headings give a number for. */
  classes: LetterClass[];
  /** SMARTTT's programmes, to match a class to by hand. */
  programmes: Programme[];
  smarttt: { available: boolean; reason: string | null };
  summary: {
    papers: number;
    newPapers: number;
    duplicates: number;
    unknown: number;
    noStudents: number;
    noClasses: number;
    /** Lines taken as a unit's ODEL paper for being its second listing. */
    secondListings: number;
    /** Your regular papers this letter turns into ODEL papers. */
    toOdel: number;
  };
}

/** The uploaded document read and checked against SMARTTT and the papers already entered. Nothing is stored. */
export async function review(ctx: Ctx, file: Buffer): Promise<ReviewDto> {
  const entries = await readExamList(file);
  const [d, e] = await Promise.all([loadExamTerm(ctx.term.id), enrolment(entries.flatMap((x) => x.codes))]);
  const hasNumbers = entries.some((x) => x.section && classOf(x.section)?.students);
  const programmes = hasNumbers ? await smartttClient.programs() : [];
  const named = letterClasses(entries, programmes, e);
  const classesOfPaper = new Map<string, string[]>();
  for (const x of entries) {
    const id = named.ofLine.get(x.line);
    if (!id) continue;
    const key = paperKey(x.codes, x.sitting);
    const list = classesOfPaper.get(key) ?? [];
    if (!list.includes(id)) classesOfPaper.set(key, [...list, id]);
  }
  const all = [...d.exams.papers.map((p) => ({ p, codes: paperCodesOf(p, d.units), sitting: p.sitting }))];
  const firstLine = new Map<string, number>();
  const pending = entries.map((x) => ({ codes: x.codes, sitting: x.sitting }));
  const listedRegular = new Set(entries.filter((x) => x.sitting === 'regular').map((x) => codesKey(x.codes)));
  const ownListed = d.exams.papers.filter((p) => p.departmentId === ctx.department.id && isListed(p));
  const claimed = new Set<string>();
  const out = entries.map((x): ReviewEntry => {
    const key = paperKey(x.codes, x.sitting);
    const duplicateOf = firstLine.get(key) ?? null;
    if (duplicateOf === null) firstLine.set(key, x.line);
    const mine = new Set(x.codes.map(compact));
    const overlapping = all.filter((o) => o.sitting === x.sitting && o.codes.some((c) => mine.has(compact(c))));
    const own = overlapping.find((o) => o.p.departmentId === ctx.department.id && paperKey(o.codes, o.sitting) === key);
    let switchesPaperId: string | null = null;
    if (x.sitting === 'odel' && duplicateOf === null && !own && !listedRegular.has(codesKey(x.codes))) {
      const regular = ownListed.find((p) => p.sitting === 'regular' && codesKey(p.codes) === codesKey(x.codes) && !claimed.has(p.id));
      if (regular) {
        switchesPaperId = regular.id;
        claimed.add(regular.id);
      }
    }
    let students: number | null = null;
    let classRows: ReviewEntry['classRows'] = [];
    let examiner: ReviewEntry['examiner'] = null;
    if (e.available) {
      const twin = hasOdelTwin(x.codes, [...all.map((o) => ({ codes: o.codes, sitting: o.sitting })), ...pending]);
      const rows = [...smartttRows(e, x.codes, x.sitting, twin).values()];
      students = rows.reduce((n, r) => n + r.students, 0);
      classRows = rows
        .map((r) => ({ label: `${r.programme} Y${r.year}S${r.semester}${r.stream ? ` (${r.stream})` : ''}`, students: r.students }))
        .sort((a, b) => a.label.localeCompare(b.label));
      const teacher = x.codes.map((c) => e.units.get(compact(c))?.lecturers[0]).find((l) => l);
      if (teacher) examiner = { ...teacher, lecturerId: ownLecturer(ctx, d, teacher.staffNumber) };
    }
    return {
      ...x,
      students,
      classRows,
      unknownCodes: e.available ? x.codes.filter((c) => e.unknown.has(compact(c))) : [],
      duplicateOf,
      otherDepartments: [...new Set(overlapping.filter((o) => o.p.departmentId !== ctx.department.id).map((o) => o.p.departmentCode))].sort(),
      existingPaperId: own?.p.id ?? null,
      switchesPaperId,
      examiner,
      letterClasses: classesOfPaper.get(key) ?? [],
    };
  });
  return {
    entries: out,
    classes: named.classes,
    programmes,
    smarttt: { available: e.available, reason: e.available ? null : e.reason },
    summary: {
      papers: out.filter((x) => x.duplicateOf === null).length,
      newPapers: out.filter((x) => x.duplicateOf === null && !x.existingPaperId).length,
      duplicates: out.filter((x) => x.duplicateOf !== null).length,
      unknown: out.filter((x) => x.unknownCodes.length).length,
      noStudents: out.filter((x) => x.students === 0).length,
      noClasses: out.filter((x) => x.students === 0 && x.classRows.length === 0).length,
      secondListings: out.filter((x) => x.secondListingOf !== null && x.duplicateOf === null).length,
      toOdel: out.filter((x) => x.switchesPaperId).length,
    },
  };
}

type Loaded = Awaited<ReturnType<typeof loadExamTerm>>;

const paperCodesOf = (p: PaperRow, units: Loaded['units']): string[] =>
  p.unitIds.length ? p.unitIds.map((id) => units.get(id)?.code).filter((c): c is string => !!c) : p.codes;

/** The department's own lecturer with this staff number, for the examiner. */
function ownLecturer(ctx: Ctx, d: Loaded, staffNumber: string): string | null {
  if (!staffNumber) return null;
  const want = compact(staffNumber);
  const found = [...d.term.lecturers.values()].find((l) => l.departmentId === ctx.department.id && l.active && compact(l.staffNumber) === want);
  return found?.id ?? null;
}

// -- saving ----------------------------------------------------------------------------------------

export interface ListedPaperInput {
  codes: string[];
  title: string;
  sitting: Sitting;
  /** Undefined: SMARTTT's lecturer when they're on your list (a new paper only); null: none. */
  examinerId?: string | null;
  /** The classes the letter names for it, as reviewed: these numbers overwrite what the classes had. */
  classes?: LetterClassInput[];
  /**
   * For an ODEL paper: your regular paper of the same codes that becomes it (review's
   * switchesPaperId). It keeps its id, examiner, invigilators and numbers; the letter's numbers win.
   */
  replacesPaperId?: string | null;
}

/**
 * Saves the reviewed list: a paper per set of codes and sitting, its title
 * updated when it is already there, its students from the letter's headings and
 * SMARTTT. Papers not in the list are kept (delete them on the page). An ODEL
 * paper given replacesPaperId is that regular paper of yours, switched to ODEL.
 */
export async function save(
  ctx: Ctx,
  input: ListedPaperInput[],
  options: { whilePublished?: boolean } = {},
): Promise<{ created: number; updated: number; switched: number; smarttt: ReviewDto['smarttt'] }> {
  const wanted = new Map<string, ListedPaperInput>();
  for (const p of input) {
    const codes = [...new Set(p.codes.map((c) => c.replace(/\s+/g, ' ').trim().toUpperCase()).filter(Boolean))];
    if (codes.length === 0) throw invalid('Every paper needs a unit code.');
    if (!p.title.trim()) throw invalid(`Give ${codes.join('/')} a title.`);
    wanted.set(paperKey(codes, p.sitting), { ...p, codes, title: p.title.trim() });
  }
  const e = await enrolment([...wanted.values()].flatMap((p) => p.codes));
  const counts = await exams(ctx, async (client) => {
    const d = await loadExamTerm(ctx.term.id, client);
    const others = d.exams.papers.map((p) => ({ codes: paperCodesOf(p, d.units), sitting: p.sitting }));
    const pending = [...wanted.values()].map((p) => ({ codes: p.codes, sitting: p.sitting }));
    const own = new Map(
      d.exams.papers.filter((p) => p.departmentId === ctx.department.id && isListed(p)).map((p) => [paperKey(p.codes, p.sitting), p] as const),
    );
    // Regular papers becoming ODEL ones, checked: yours, the same codes, and not also listed as regular.
    const switching = new Map<string, PaperRow>();
    for (const [key, w] of wanted) {
      if (!w.replacesPaperId) continue;
      const paper = d.exams.papers.find((p) => p.id === w.replacesPaperId);
      const label = w.codes.join('/');
      if (w.sitting !== 'odel') throw invalid(`${label}: only an ODEL paper can take over a regular one.`);
      if (!paper || paper.departmentId !== ctx.department.id || !isListed(paper) || paper.sitting !== 'regular') {
        throw invalid(`${label}: the regular paper it replaces isn't on your list. Upload the letter again.`);
      }
      if (codesKey(paper.codes) !== codesKey(w.codes)) throw invalid(`${label}: the regular paper it replaces has other codes (${paper.codes.join('/')}).`);
      if (wanted.has(paperKey(w.codes, 'regular'))) throw invalid(`${label} is also listed as a regular paper, so it can't replace it.`);
      if (own.has(key)) continue; // an ODEL paper of these codes is already there: it is updated instead
      if ([...switching.values()].some((p) => p.id === paper.id)) throw invalid(`${label}: that regular paper is taken over twice.`);
      switching.set(key, paper);
    }
    let created = 0;
    let updated = 0;
    let switched = 0;
    for (const [key, w] of wanted) {
      const found = own.get(key) ?? switching.get(key);
      const fresh = e.available ? smartttRows(e, w.codes, w.sitting, hasOdelTwin(w.codes, [...others, ...pending])) : new Map<string, ListedRowValues>();
      if (found) {
        await examsRepo.updateListedPaper(client, found.id, {
          codes: w.codes,
          title: w.title,
          sitting: w.sitting,
          examinerId: w.examinerId !== undefined ? checkedExaminer(ctx, d, w.examinerId) : found.examinerId,
          notes: found.notes,
        });
        const base = e.available ? merged(found, fresh) : found.rows;
        if (e.available || w.classes?.length) await examsRepo.setListedRows(client, found.id, withLetterClasses(found, base, w.classes, w.sitting));
        if (own.has(key)) updated++;
        else switched++;
      } else {
        const suggested = e.available ? w.codes.map((c) => e.units.get(compact(c))?.lecturers[0]).find((l) => l) : undefined;
        const id = await examsRepo.insertListedPaper(client, ctx.term.id, ctx.department.id, {
          codes: w.codes,
          title: w.title,
          sitting: w.sitting,
          examinerId: w.examinerId !== undefined ? checkedExaminer(ctx, d, w.examinerId) : suggested ? ownLecturer(ctx, d, suggested.staffNumber) : null,
          notes: '',
        });
        await examsRepo.setListedRows(client, id, withLetterClasses(null, [...fresh.values()], w.classes, w.sitting));
        created++;
      }
    }
    return { created, updated, switched };
  }, options.whilePublished);
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: 'exam_list.save', id: ctx.department.code, after: counts, ...(options.whilePublished ? { via: 'GENERATOR' } : {}) });
  return { ...counts, smarttt: { available: e.available, reason: e.available ? null : e.reason } };
}

/**
 * A moderation letter the Director uploaded on the Generator, for this department: saved like the
 * department's own (the same reading, review and rules), whether or not the department's list is
 * published, then the list is published so the Director's import brings it in. The department sees
 * the papers on its Exams tab, published under the Director's name.
 */
export async function saveForDirector(ctx: Ctx, input: ListedPaperInput[]): Promise<Awaited<ReturnType<typeof save>> & { published: number }> {
  const result = await save(ctx, input, { whilePublished: true });
  const after = await publish(ctx, { whilePublished: true });
  return { ...result, published: after.papers.length };
}

/**
 * The uploaded list taken back as a whole: every listed paper of the
 * department's this term. Papers built from units stay.
 */
export async function removeList(ctx: Ctx): Promise<{ deleted: number }> {
  const deleted = await exams(ctx, async (client) => {
    const d = await loadExamTerm(ctx.term.id, client);
    const own = d.exams.papers.filter((p) => p.departmentId === ctx.department.id && isListed(p));
    for (const p of own) await examsRepo.deletePaper(client, p.id);
    return own.length;
  });
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: 'exam_list.delete', id: ctx.department.code, after: { deleted } });
  return { deleted };
}

function checkedExaminer(ctx: Ctx, d: Loaded, lecturerId: string | null): string | null {
  if (!lecturerId) return null;
  const l = d.term.lecturers.get(lecturerId);
  if (!l || l.departmentId !== ctx.department.id) throw AppError.forbidden("That lecturer is not on your department's list.");
  return l.id;
}

// -- the department's corrections ------------------------------------------------------------------

export interface RowInput {
  programme: string;
  year: number;
  semester: number;
  stream: string;
  students: number;
}

/**
 * The listed paper's class rows as the department wants them. A row whose
 * number is changed from SMARTTT's (or added) is marked as theirs; a row of
 * SMARTTT's left out stays at 0, so reading SMARTTT again doesn't bring it back.
 */
export async function setRows(ctx: Ctx, paperId: string, rows: RowInput[]): Promise<ExamBoardDto> {
  await exams(ctx, async (client) => {
    const d = await loadExamTerm(ctx.term.id, client);
    await applyRows(client, ctx, d, paperId, rows);
  });
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: 'exam_paper.rows', id: paperId, after: rows });
  return board(ctx);
}

/**
 * Several listed papers' class rows at once (the "Enter student numbers"
 * screen), all or none: one bad paper saves nothing.
 */
export async function setManyRows(ctx: Ctx, papers: Array<{ paperId: string; rows: RowInput[] }>): Promise<ExamBoardDto> {
  await exams(ctx, async (client) => {
    const d = await loadExamTerm(ctx.term.id, client);
    for (const p of papers) await applyRows(client, ctx, d, p.paperId, p.rows);
  });
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: 'exam_paper.rows_many', id: ctx.department.code, after: { papers: papers.length } });
  return board(ctx);
}

async function applyRows(client: PoolClient, ctx: Ctx, d: Loaded, paperId: string, rows: RowInput[]): Promise<void> {
  const paper = d.exams.papers.find((p) => p.id === paperId);
  if (!paper || paper.departmentId !== ctx.department.id) throw AppError.notFound('No such paper in your department.');
  if (!isListed(paper)) throw invalid("This paper's students come from your units' courses; change them there.");
  const before = new Map(paper.rows.map((r) => [rowKey(r), r]));
  const out = new Map<string, ListedRowValues>();
  for (const r of rows) {
    const row = { programme: r.programme.trim().toUpperCase(), year: r.year, semester: r.semester, stream: r.stream.trim() };
    if (!row.programme) throw invalid('Every class row needs its programme code.');
    const key = rowKey(row);
    if (out.has(key)) throw invalid(`${row.programme} Y${row.year}S${row.semester} is listed twice.`);
    const was = before.get(key);
    const smartttStudents = was?.smartttStudents ?? null;
    out.set(key, { ...row, students: r.students, smartttStudents, edited: (was?.edited ?? false) || smartttStudents === null || r.students !== smartttStudents });
  }
  for (const [key, was] of before) {
    if (!out.has(key) && was.smartttStudents !== null) out.set(key, { ...was, students: 0, edited: true });
  }
  await examsRepo.setListedRows(client, paper.id, [...out.values()]);
}

/** Reads SMARTTT again for the department's listed papers; numbers the department set stay. */
export async function recount(ctx: Ctx): Promise<ExamBoardDto> {
  const d = await loadExamTerm(ctx.term.id);
  const own = d.exams.papers.filter((p) => p.departmentId === ctx.department.id && isListed(p));
  const e = await enrolment(own.flatMap((p) => p.codes));
  if (!e.available) throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, e.reason);
  await exams(ctx, (client) => refreshPapers(client, own, d, e));
  return board(ctx);
}

async function refreshPapers(client: PoolClient, papers: PaperRow[], d: Loaded, e: Enrolment & { available: true }): Promise<void> {
  const all = d.exams.papers.map((p) => ({ codes: paperCodesOf(p, d.units), sitting: p.sitting }));
  for (const p of papers) {
    await examsRepo.setListedRows(client, p.id, merged(p, smartttRows(e, p.codes, p.sitting, hasOdelTwin(p.codes, all))));
  }
}

/**
 * Every department's listed papers re-counted from SMARTTT, before the
 * Generator reads them. Best effort: SMARTTT down leaves the last numbers.
 */
export async function refreshTerm(termId: string): Promise<void> {
  try {
    const d = await loadExamTerm(termId);
    const listed = d.exams.papers.filter(isListed);
    if (listed.length === 0) return;
    const e = await enrolment(listed.flatMap((p) => p.codes));
    if (!e.available) {
      logger.warn({ termId, reason: e.reason }, 'exam list: SMARTTT not read; the last student numbers are used');
      return;
    }
    await transaction((client) => refreshPapers(client, listed, d, e));
  } catch (error) {
    logger.error({ err: error, termId }, 'exam list: re-counting from SMARTTT failed; the last student numbers are used');
  }
}

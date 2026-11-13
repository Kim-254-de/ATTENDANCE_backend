import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { AuditAction } from '../../db/types.js';
import * as examsRepo from './exams.repository.js';
import type { ExamData, ListedRow, PaperRow, PracticalRow, Sitting } from './exams.repository.js';
import * as repo from './teaching.repository.js';
import { compact, type CourseMode, type CourseRow, type LecturerRow, type TermData, type UnitRow } from './teaching.repository.js';
import { audit, courseLabel, displayName, invalid, publicationDto, writeTeaching, type Ctx, type PublicationDto } from './teaching.service.js';

/**
 * What departments enter for the exam timetable, and publish to the Director
 * (it used to be the Timetable Allocator's).
 *
 * A department's written exam papers are the ones on its moderation letters,
 * uploaded on the Exams tab (exam-list.service.ts), and only those: what it
 * teaches, and what SMARTTT's timetable shows, never adds a paper. One paper
 * can carry several codes ("BITE 131/COSC 130"). ODEL and part-time classes
 * sit papers of their own: a paper's sitting is 'regular' or 'odel'.
 * Practicals are on dates the department sets; the Generator only shows them.
 *
 * An officer publishes the paper list (and practicals), which locks it until
 * an officer reopens it; the teaching list has a lock of its own. The
 * Generator imports it, places every paper in a session and its students in
 * rooms; departments then name invigilators (invigilation.service.ts).
 */

const KIND = 'exams' as const;

const exams = <T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>) => writeTeaching(ctx, work, { kind: KIND });

interface Loaded {
  term: TermData;
  exams: ExamData;
  units: Map<string, UnitRow>;
  courses: Map<string, CourseRow>;
}

/**
 * The term's teaching and exams. Every department's lecturers are included:
 * an examiner need not teach a group, and an invigilator may be on any list.
 * `departmentIds` is kept for the call sites' intent; the lists are whole anyway.
 */
async function load(termId: string, client?: PoolClient, departmentIds: string[] = []): Promise<Loaded> {
  const [term, examData, everyone] = await Promise.all([
    repo.loadTerm(termId, departmentIds, client),
    examsRepo.loadExams(termId, client),
    repo.listAllLecturers(client),
  ]);
  for (const l of everyone) if (!term.lecturers.has(l.id)) term.lecturers.set(l.id, l);
  return { term, exams: examData, units: new Map(term.units.map((u) => [u.id, u])), courses: new Map(term.courses.map((c) => [c.id, c])) };
}

/** A paper built from units has their codes; a listed one (uploaded) the codes it was listed with. */
export const paperCodes = (p: PaperRow, units: Map<string, UnitRow>): string[] =>
  p.unitIds.length ? p.unitIds.map((id) => units.get(id)?.code).filter((c): c is string => !!c).sort() : [...p.codes].sort();

/** An uploaded paper, sized from SMARTTT rather than from the department's units and courses. */
export const isListed = (p: PaperRow): boolean => p.unitIds.length === 0 && p.codes.length > 0;

/**
 * The class the Exams tab fills in for a paper nobody synced so it can take a
 * number: programme from the first code's letters, year from its first
 * non-zero digit ("MATH 241" is MATH Y2S1). The department's page has the same
 * rule (guessedRow). A row still saying exactly this, with no SMARTTT count,
 * is a guess and not who is known to sit the paper: the Generator seats it
 * but doesn't hold it to a class's hard rules. Correcting the class makes it known.
 */
export function isGuessedRow(p: PaperRow, r: ListedRow): boolean {
  if (r.smartttStudents !== null) return false;
  const first = p.codes[0] ?? '';
  const year = Number(/[1-9]/.exec(first.replace(/^\D+/, ''))?.[0] ?? 1);
  return compact(r.programme) === first.replace(/[^A-Za-z]/g, '').toUpperCase() && r.year === Math.min(year, 10) && r.semester === 1 && !r.stream.trim();
}

/**
 * A listed paper's class rows as courses, so everything downstream (the
 * board, the Generator's import) treats them alike. The id is the class
 * itself (programme, year, semester, stream): one class sitting several
 * papers is one class row in the Generator, so its papers never clash.
 */
export function listedCourses(p: PaperRow): Array<CourseRow & { guessed: boolean }> {
  return p.rows
    // Students 0: a class the master timetable names, number not known yet (it still holds to the
    // Generator's hard rules); once the department set it to 0 or removed it, it doesn't sit the paper.
    .filter((r) => r.students > 0 || !r.edited)
    .map((r) => ({
      id: `listed:${compact(r.programme)}|${r.year}|${r.semester}|${compact(r.stream)}`,
      departmentId: p.departmentId,
      departmentCode: p.departmentCode,
      programme: r.programme,
      year: r.year,
      semester: r.semester,
      subClass: r.stream,
      students: r.students,
      mode: p.sitting === 'odel' ? 'odel' : 'regular',
      guessed: isGuessedRow(p, r),
    }));
}

/** 'MATH 241', or 'MATH 241 (ODEL)' for the ODEL paper: how a paper is named to people. */
export const paperLabel = (p: PaperRow, units: Map<string, UnitRow>): string =>
  `${paperCodes(p, units).join('/')}${p.sitting === 'odel' ? ' (ODEL)' : ''}`;

/** ODEL and part-time classes sit the ODEL papers; every other class the regular ones. */
export const sittingOf = (mode: CourseMode): Sitting => (mode === 'odel' || mode === 'part_time' ? 'odel' : 'regular');

/** The cohorts that sit the paper: every course of its sitting taking any of its units, once. */
function paperCourses(p: PaperRow, d: Loaded): Array<CourseRow & { guessed?: boolean }> {
  if (isListed(p)) return listedCourses(p).sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)));
  const ids = new Set(p.unitIds.flatMap((id) => d.units.get(id)?.courseIds ?? []));
  return [...ids]
    .map((id) => d.courses.get(id))
    .filter((c): c is CourseRow => !!c && sittingOf(c.mode) === p.sitting)
    .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)));
}

/** The sittings a unit's classes need papers for: those of its courses, or regular for a unit with none yet. */
function sittingsOf(u: UnitRow, d: Loaded): Sitting[] {
  const found = new Set(u.courseIds.map((id) => d.courses.get(id)).filter((c): c is CourseRow => !!c).map((c) => sittingOf(c.mode)));
  return found.size ? (['regular', 'odel'] as const).filter((x) => found.has(x)) : ['regular'];
}

/** The lecturer of the whole class, or of the first group of a split unit with one. */
const defaultExaminer = (u: UnitRow): string | null => u.groups.find((g) => g.lecturerId)?.lecturerId ?? null;

function signature(p: PaperRow, d: Loaded): string {
  const data = {
    codes: paperCodes(p, d.units),
    title: p.title,
    sitting: p.sitting,
    examiner: p.examinerId ? (d.term.lecturers.get(p.examinerId)?.staffNumber ?? null) : null,
    notes: p.notes,
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export interface ExamProblem {
  code: string;
  message: string;
}

function problems(ctx: Ctx, d: Loaded): ExamProblem[] {
  if (d.exams.papers.some((p) => p.departmentId === ctx.department.id)) return [];
  return [{ code: 'no_exam_list', message: 'Upload your moderation letter: its units are the ones on the exam timetable.' }];
}

/**
 * What doesn't stop publishing but needs a look: a listed paper nobody has
 * synced (part-time students may never sync) still goes to the Director and
 * gets its date and session; its room waits for a number.
 */
function warnings(ctx: Ctx, d: Loaded): ExamProblem[] {
  return d.exams.papers
    .filter((p) => p.departmentId === ctx.department.id && isListed(p) && paperCourses(p, d).every((c) => c.students === 0))
    .map((p) => {
      const classes = paperCourses(p, d).length;
      return {
        code: 'no_students',
        message: classes
          ? `${paperLabel(p, d.units)} has ${classes === 1 ? '1 class' : `${classes} classes`} on the master timetable and no student number yet. Its classes are kept from clashing and it gets a date; enter its students under Numbers so it gets a room.`
          : `Nobody has synced ${paperLabel(p, d.units)} in SMARTTT and the master timetable has no class for it. It still goes to the Director and gets a date; add its classes and students under Numbers so it gets a room and can't clash.`,
      };
    });
}

export interface PaperDto {
  id: string;
  codes: string;
  sitting: Sitting;
  units: Array<{ id: string; code: string; departmentCode: string }>;
  title: string;
  examinerId: string | null;
  examiner: string | null;
  notes: string;
  classRows: string[];
  students: number;
  changedSincePublished: boolean;
  /** Uploaded with the exam list: its class rows and numbers are `rows`, from SMARTTT or edited here. */
  listed: boolean;
  rows: ListedRow[];
}

function paperDto(p: PaperRow, d: Loaded, everPublished: boolean): PaperDto {
  const sitting = paperCourses(p, d);
  const examiner = p.examinerId ? d.term.lecturers.get(p.examinerId) : undefined;
  return {
    id: p.id,
    codes: paperCodes(p, d.units).join('/'),
    sitting: p.sitting,
    units: p.unitIds
      .map((id) => d.units.get(id))
      .filter((u): u is UnitRow => !!u)
      .map((u) => ({ id: u.id, code: u.code, departmentCode: u.departmentCode }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    title: p.title,
    examinerId: p.examinerId,
    examiner: examiner ? displayName(examiner) : null,
    notes: p.notes,
    classRows: sitting.map(courseLabel),
    students: sitting.reduce((n, c) => n + c.students, 0),
    changedSincePublished: everPublished && p.publishedSignature !== signature(p, d),
    listed: isListed(p),
    rows: isListed(p) ? p.rows : [],
  };
}

export interface PracticalDto {
  id: string;
  unitId: string;
  unitCode: string;
  unitTitle: string;
  date: string;
  startTime: string;
  endTime: string;
}

const practicalDto = (p: PracticalRow, units: Map<string, UnitRow>): PracticalDto => ({
  id: p.id,
  unitId: p.unitId,
  unitCode: units.get(p.unitId)?.code ?? '?',
  unitTitle: units.get(p.unitId)?.title ?? '',
  date: p.date,
  startTime: p.startTime,
  endTime: p.endTime,
});

export interface ExamBoardDto {
  term: Ctx['term'];
  department: Ctx['department'];
  canEdit: boolean;
  published: boolean;
  publication: PublicationDto | null;
  papers: PaperDto[];
  units: Array<{
    id: string; code: string; title: string; noWrittenExam: boolean;
    paperId: string | null; paperCodes: string | null; paperDepartment: string | null; defaultExaminerId: string | null;
    /** The sittings the unit's classes need papers for, and its ODEL paper when it has one. */
    sittings: Sitting[]; odelPaperId: string | null;
  }>;
  /** Other departments' units not on a paper yet, for a paper shared with them ("BITE 131/COSC 130"). */
  otherUnits: Array<{ id: string; code: string; title: string; departmentCode: string }>;
  practicals: PracticalDto[];
  lecturers: Array<{ id: string; display: string; staffNumber: string | null; active: boolean }>;
  problems: ExamProblem[];
  /** Not in the way of publishing: papers with no students known yet. */
  warnings: ExamProblem[];
  summary: { papers: number; students: number; changed: number; problems: number };
}

/** The department's exam papers, practicals and what blocks publishing them. */
export async function board(ctx: Ctx): Promise<ExamBoardDto> {
  const [d, latest] = await Promise.all([load(ctx.term.id, undefined, [ctx.department.id]), repo.latestPublication(ctx.term.id, ctx.department.id, undefined, KIND)]);
  const standing = latest && !latest.reopenedAt ? latest : null;
  const paperOf = new Map(d.exams.papers.filter((p) => p.sitting === 'regular').flatMap((p) => p.unitIds.map((id) => [id, p] as const)));
  const odelPaperOf = new Map(d.exams.papers.filter((p) => p.sitting === 'odel').flatMap((p) => p.unitIds.map((id) => [id, p] as const)));
  const own = d.term.units.filter((u) => u.departmentId === ctx.department.id).sort((a, b) => a.codeKey.localeCompare(b.codeKey));
  const papers = d.exams.papers
    .filter((p) => p.departmentId === ctx.department.id)
    .map((p) => paperDto(p, d, latest !== null))
    .sort((a, b) => a.codes.localeCompare(b.codes));
  const found = problems(ctx, d);
  return {
    term: ctx.term,
    department: ctx.department,
    canEdit: standing === null,
    published: standing !== null,
    publication: publicationDto(latest),
    papers,
    units: own.map((u) => {
      const p = paperOf.get(u.id);
      return {
        id: u.id,
        code: u.code,
        title: u.title,
        noWrittenExam: d.exams.noWrittenExam.has(u.id),
        paperId: p?.id ?? null,
        paperCodes: p ? paperCodes(p, d.units).join('/') : null,
        paperDepartment: p?.departmentCode ?? null,
        defaultExaminerId: defaultExaminer(u),
        sittings: sittingsOf(u, d),
        odelPaperId: odelPaperOf.get(u.id)?.id ?? null,
      };
    }),
    otherUnits: d.term.units
      .filter((u) => u.departmentId !== ctx.department.id && !(paperOf.has(u.id) && odelPaperOf.has(u.id)))
      .sort((a, b) => a.codeKey.localeCompare(b.codeKey))
      .map((u) => ({ id: u.id, code: u.code, title: u.title, departmentCode: u.departmentCode })),
    practicals: d.exams.practicals.filter((p) => p.departmentId === ctx.department.id).map((p) => practicalDto(p, d.units)),
    lecturers: [...d.term.lecturers.values()]
      .filter((l) => l.departmentId === ctx.department.id)
      .map((l) => ({ id: l.id, display: displayName(l), staffNumber: l.staffNumber, active: l.active })),
    problems: found,
    warnings: warnings(ctx, d),
    summary: {
      papers: papers.length,
      students: papers.reduce((n, p) => n + p.students, 0),
      changed: papers.filter((p) => p.changedSincePublished).length,
      problems: found.length,
    },
  };
}

// -- papers ----------------------------------------------------------------------------------------

export interface PaperInput {
  title?: string;
  sitting?: Sitting;
  examinerId?: string | null;
  notes?: string;
}

function examinerFor(ctx: Ctx, d: Loaded, lecturerId: string): string {
  const l = d.term.lecturers.get(lecturerId);
  if (!l || l.departmentId !== ctx.department.id) throw AppError.forbidden("That lecturer is not on your department's list.");
  if (!l.active) throw invalid(`${l.fullName} is marked inactive.`);
  return l.id;
}

function ownPaper(ctx: Ctx, d: Loaded, paperId: string): PaperRow {
  const p = d.exams.papers.find((x) => x.id === paperId);
  if (!p || p.departmentId !== ctx.department.id) throw AppError.notFound('No such paper in your department.');
  return p;
}

export async function updatePaperIn(client: PoolClient, ctx: Ctx, paperId: string, input: PaperInput): Promise<void> {
  const d = await load(ctx.term.id, client, [ctx.department.id]);
  const paper = ownPaper(ctx, d, paperId);
  await examsRepo.updateListedPaper(client, paper.id, {
    codes: paper.codes,
    title: input.title?.trim() || paper.title,
    sitting: input.sitting ?? paper.sitting,
    examinerId: input.examinerId !== undefined ? (input.examinerId ? examinerFor(ctx, d, input.examinerId) : null) : paper.examinerId,
    notes: input.notes !== undefined ? input.notes.trim() : paper.notes,
  });
}

const changed = (ctx: Ctx, what: string, id: string, data: unknown) => audit(ctx, AuditAction.TEACHING_CHANGED, { what, id, after: data });

export async function updatePaper(ctx: Ctx, paperId: string, input: PaperInput): Promise<void> {
  await exams(ctx, (client) => updatePaperIn(client, ctx, paperId, input));
  await changed(ctx, 'exam_paper.update', paperId, input);
}

export async function deletePaper(ctx: Ctx, paperId: string): Promise<void> {
  await exams(ctx, async (client) => {
    const paper = ownPaper(ctx, await load(ctx.term.id, client), paperId);
    await examsRepo.deletePaper(client, paper.id);
  });
  await changed(ctx, 'exam_paper.delete', paperId, null);
}

// -- practicals ------------------------------------------------------------------------------------

export interface PracticalInput {
  unitId: string;
  date: string;
  startTime: string;
  endTime: string;
}

function practicalValues(ctx: Ctx, d: Loaded, input: PracticalInput): examsRepo.PracticalValues {
  const unit = d.units.get(input.unitId);
  if (!unit || unit.departmentId !== ctx.department.id) throw invalid("Choose one of your department's units.");
  if (!(input.startTime < input.endTime)) throw invalid('A practical must end after it starts.');
  const day = new Date(`${input.date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) throw invalid('Practicals are on weekdays.');
  return { unitId: unit.id, date: input.date, startTime: input.startTime, endTime: input.endTime };
}

export async function savePracticalIn(client: PoolClient, ctx: Ctx, practicalId: string | null, input: PracticalInput): Promise<string> {
  const d = await load(ctx.term.id, client);
  const v = practicalValues(ctx, d, input);
  if (practicalId === null) return examsRepo.insertPractical(client, ctx.term.id, ctx.department.id, v);
  const found = d.exams.practicals.find((p) => p.id === practicalId);
  if (!found || found.departmentId !== ctx.department.id) throw AppError.notFound('No such practical in your department.');
  await examsRepo.updatePractical(client, found.id, v);
  return found.id;
}

export async function savePractical(ctx: Ctx, practicalId: string | null, input: PracticalInput): Promise<{ id: string }> {
  const id = await exams(ctx, (client) => savePracticalIn(client, ctx, practicalId, input));
  await changed(ctx, 'practical.save', id, input);
  return { id };
}

export async function deletePractical(ctx: Ctx, practicalId: string): Promise<void> {
  await exams(ctx, async (client) => {
    const found = (await examsRepo.loadExams(ctx.term.id, client)).practicals.find((p) => p.id === practicalId);
    if (!found || found.departmentId !== ctx.department.id) throw AppError.notFound('No such practical in your department.');
    await examsRepo.deletePractical(client, found.id);
  });
  await changed(ctx, 'practical.delete', practicalId, null);
}

// -- publishing ------------------------------------------------------------------------------------

export async function publish(ctx: Ctx, options: { whilePublished?: boolean } = {}): Promise<ExamBoardDto> {
  const papers = await writeTeaching(ctx, async (client) => {
    const d = await load(ctx.term.id, client);
    const found = problems(ctx, d);
    if (found.length) {
      throw new AppError(409, ErrorCode.TEACHING_NOT_READY, `${found.length} things must be fixed before publishing: ${found[0]!.message}`, {
        details: { problems: found.slice(0, 50) },
      });
    }
    const own = d.exams.papers.filter((p) => p.departmentId === ctx.department.id);
    await examsRepo.setPaperSignatures(client, own.map((p) => ({ paperId: p.id, signature: signature(p, d) })));
    await repo.insertPublication(client, {
      termId: ctx.term.id, departmentId: ctx.department.id, userId: ctx.userId, name: ctx.actor, unitCount: own.length, groupCount: 0, kind: KIND,
    });
    return own.length;
  }, { kind: KIND, whilePublished: options.whilePublished });
  await audit(ctx, AuditAction.TEACHING_PUBLISHED, { kind: KIND, papers, ...(options.whilePublished ? { via: 'GENERATOR' } : {}) });
  return board(ctx);
}

export async function reopen(ctx: Ctx): Promise<ExamBoardDto> {
  await writeTeaching(
    ctx,
    async (client) => {
      const latest = await repo.latestPublication(ctx.term.id, ctx.department.id, client, KIND);
      if (!latest || latest.reopenedAt) throw new AppError(409, ErrorCode.TEACHING_NOT_PUBLISHED, "Your department's exam papers haven't been published.");
      await repo.reopenPublication(client, latest.id, ctx.actor);
    },
    { whilePublished: true },
  );
  await audit(ctx, AuditAction.TEACHING_REOPENED, { kind: KIND });
  return board(ctx);
}

// -- what the Generator reads ----------------------------------------------------------------------

/**
 * Every published department's exam papers, with the class rows (courses)
 * that sit each and their students, its practicals, and the departments that
 * haven't published. snake_case and this exact shape on purpose: it is what
 * the Generator's exam import (app/services/exam_setup.py) reads, unchanged
 * from when the Timetable Allocator served it.
 */
export async function submissions(termId: string): Promise<Record<string, unknown>> {
  const [d, latest, departments] = await Promise.all([load(termId), repo.latestPublications(termId, KIND), repo.listDepartments()]);
  const published: Array<Record<string, unknown>> = [];
  const waiting: Array<Record<string, unknown>> = [];
  const needed = new Set<string>();
  // Listed papers' class rows: one per class however many papers it sits, with its biggest number.
  const listed = new Map<string, CourseRow>();
  for (const dept of departments.filter((x) => compact(x.code))) {
    const code = compact(dept.code);
    const pub = latest.get(dept.id);
    if (!pub || pub.reopenedAt) {
      waiting.push({ code, name: dept.name, reopened_at: pub?.reopenedAt?.toISOString() ?? null });
      continue;
    }
    const papers = d.exams.papers
      .filter((p) => p.departmentId === dept.id)
      .sort((a, b) => paperLabel(a, d.units).localeCompare(paperLabel(b, d.units)))
      .map((p) => {
        const sitting = paperCourses(p, d);
        for (const c of sitting) {
          if (!c.id.startsWith('listed:')) needed.add(c.id);
          else if ((listed.get(c.id)?.students ?? -1) < c.students) listed.set(c.id, c);
        }
        const examiner: LecturerRow | undefined = p.examinerId ? d.term.lecturers.get(p.examinerId) : undefined;
        // Named before the timetable is generated: the Generator keeps this person's papers in different sessions.
        const mainId = d.exams.invigilations.find((i) => i.paperId === p.id && i.room === '')?.lecturerId;
        const main: LecturerRow | undefined = mainId ? d.term.lecturers.get(mainId) : undefined;
        return {
          id: p.id,
          codes: paperCodes(p, d.units),
          title: p.title,
          sitting: p.sitting,
          examiner: examiner ? { staff_number: examiner.staffNumber, name: displayName(examiner) } : null,
          invigilator: main?.staffNumber ? { staff_number: main.staffNumber, name: displayName(main) } : null,
          notes: p.notes,
          rows: sitting.map((c) => ({ course_id: c.id, students: c.students, mode: c.mode, guessed: c.guessed === true })),
          students: sitting.reduce((n, c) => n + c.students, 0),
        };
      });
    published.push({
      code,
      name: dept.name,
      published_at: pub.publishedAt.toISOString(),
      published_by: pub.publishedByName,
      papers,
      practicals: d.exams.practicals
        .filter((p) => p.departmentId === dept.id)
        .map((p) => ({
          id: p.id,
          codes: d.units.get(p.unitId) ? [d.units.get(p.unitId)!.code] : [],
          title: d.units.get(p.unitId)?.title ?? '',
          date: p.date,
          start_time: p.startTime,
          end_time: p.endTime,
        })),
    });
  }
  return {
    term_id: termId,
    courses: [...[...needed].map((id) => d.courses.get(id)!), ...listed.values()]
      .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)))
      .map((c) => ({
        id: c.id, department_code: c.departmentCode, programme: c.programme, year: c.year, semester: c.semester,
        sub_class: c.subClass, label: courseLabel(c), students: c.students, mode: c.mode,
      })),
    published,
    not_published: waiting,
  };
}

export { load as loadExamTerm, KIND as EXAMS_KIND };

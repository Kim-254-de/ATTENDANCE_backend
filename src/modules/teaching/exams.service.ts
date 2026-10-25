import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { AuditAction } from '../../db/types.js';
import * as examsRepo from './exams.repository.js';
import type { ExamData, PaperRow, PracticalRow } from './exams.repository.js';
import * as repo from './teaching.repository.js';
import { compact, type CourseRow, type LecturerRow, type TermData, type UnitRow } from './teaching.repository.js';
import { audit, courseLabel, displayName, invalid, publicationDto, writeTeaching, type Ctx, type PublicationDto } from './teaching.service.js';

/**
 * What departments enter for the exam timetable, and publish to the Director
 * (it used to be the Timetable Allocator's).
 *
 * Each department lists its written exam papers, built from its units: all
 * groups of a unit sit one paper, and one paper can carry several units'
 * codes ("BITE 131/COSC 130"). A unit is on at most one paper per term, so a
 * code listed twice is refused. A unit with no written exam is marked so.
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

export const paperCodes = (p: PaperRow, units: Map<string, UnitRow>): string[] =>
  p.unitIds.map((id) => units.get(id)?.code).filter((c): c is string => !!c).sort();

/** The cohorts that sit the paper: every course taking any of its units, once. */
function paperCourses(p: PaperRow, d: Loaded): CourseRow[] {
  const ids = new Set(p.unitIds.flatMap((id) => d.units.get(id)?.courseIds ?? []));
  return [...ids].map((id) => d.courses.get(id)).filter((c): c is CourseRow => !!c).sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)));
}

/** The lecturer of the whole class, or of the first group of a split unit with one. */
const defaultExaminer = (u: UnitRow): string | null => u.groups.find((g) => g.lecturerId)?.lecturerId ?? null;

function signature(p: PaperRow, d: Loaded): string {
  const data = {
    codes: paperCodes(p, d.units),
    title: p.title,
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
  const found: ExamProblem[] = [];
  const own = d.term.units.filter((u) => u.departmentId === ctx.department.id).sort((a, b) => a.codeKey.localeCompare(b.codeKey));
  const onPaper = new Set(d.exams.papers.flatMap((p) => p.unitIds));
  if (own.length === 0) found.push({ code: 'no_units', message: 'Enter your units (Units & groups) first.' });
  for (const u of own) {
    if (!onPaper.has(u.id) && !d.exams.noWrittenExam.has(u.id)) {
      found.push({ code: 'unit_not_examined', message: `${u.code} is on no paper; add it to one, or mark it 'no written exam'.` });
    }
  }
  for (const p of d.exams.papers.filter((p) => p.departmentId === ctx.department.id)) {
    if (!p.examinerId) found.push({ code: 'no_examiner', message: `Give ${p.title} an examiner.` });
  }
  return found;
}

export interface PaperDto {
  id: string;
  codes: string;
  units: Array<{ id: string; code: string; departmentCode: string }>;
  title: string;
  examinerId: string | null;
  examiner: string | null;
  notes: string;
  classRows: string[];
  students: number;
  changedSincePublished: boolean;
}

function paperDto(p: PaperRow, d: Loaded, everPublished: boolean): PaperDto {
  const sitting = paperCourses(p, d);
  const examiner = p.examinerId ? d.term.lecturers.get(p.examinerId) : undefined;
  return {
    id: p.id,
    codes: paperCodes(p, d.units).join('/'),
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
  }>;
  /** Other departments' units not on a paper yet, for a paper shared with them ("BITE 131/COSC 130"). */
  otherUnits: Array<{ id: string; code: string; title: string; departmentCode: string }>;
  practicals: PracticalDto[];
  lecturers: Array<{ id: string; display: string; staffNumber: string | null; active: boolean }>;
  problems: ExamProblem[];
  summary: { papers: number; students: number; changed: number; problems: number };
}

/** The department's exam papers, practicals and what blocks publishing them. */
export async function board(ctx: Ctx): Promise<ExamBoardDto> {
  const [d, latest] = await Promise.all([load(ctx.term.id, undefined, [ctx.department.id]), repo.latestPublication(ctx.term.id, ctx.department.id, undefined, KIND)]);
  const standing = latest && !latest.reopenedAt ? latest : null;
  const paperOf = new Map(d.exams.papers.flatMap((p) => p.unitIds.map((id) => [id, p] as const)));
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
      };
    }),
    otherUnits: d.term.units
      .filter((u) => u.departmentId !== ctx.department.id && !paperOf.has(u.id))
      .sort((a, b) => a.codeKey.localeCompare(b.codeKey))
      .map((u) => ({ id: u.id, code: u.code, title: u.title, departmentCode: u.departmentCode })),
    practicals: d.exams.practicals.filter((p) => p.departmentId === ctx.department.id).map((p) => practicalDto(p, d.units)),
    lecturers: [...d.term.lecturers.values()]
      .filter((l) => l.departmentId === ctx.department.id)
      .map((l) => ({ id: l.id, display: displayName(l), staffNumber: l.staffNumber, active: l.active })),
    problems: found,
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
  unitIds?: string[];
  title?: string;
  examinerId?: string | null;
  notes?: string;
}

/** The paper's units: in this term, at least one this department's, none on another paper or marked no written exam. */
function checkUnits(ctx: Ctx, d: Loaded, unitIds: string[], paper: PaperRow | null): string[] {
  const ids = [...new Set(unitIds)];
  if (ids.length === 0) throw invalid('Choose the unit (or units) the paper covers.');
  const units = ids.map((id) => d.units.get(id));
  if (units.some((u) => !u)) throw invalid("A unit chosen isn't in this term.");
  if (!units.some((u) => u!.departmentId === ctx.department.id)) throw invalid("A paper needs at least one of your department's units.");
  for (const p of d.exams.papers) {
    if (p.id === paper?.id) continue;
    const taken = p.unitIds.find((id) => ids.includes(id));
    if (taken) throw new AppError(409, ErrorCode.TEACHING_TAKEN, `${d.units.get(taken)!.code} is already on another paper.`);
  }
  const marked = units.filter((u) => d.exams.noWrittenExam.has(u!.id));
  if (marked.length) throw new AppError(409, ErrorCode.TEACHING_TAKEN, `${marked.map((u) => u!.code).join(', ')} is marked 'no written exam'.`);
  return ids;
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

export async function createPaperIn(client: PoolClient, ctx: Ctx, input: PaperInput): Promise<string> {
  const d = await load(ctx.term.id, client, [ctx.department.id]);
  const ids = checkUnits(ctx, d, input.unitIds ?? [], null);
  const first = ids.map((id) => d.units.get(id)!).find((u) => u.departmentId === ctx.department.id)!;
  const examinerId = input.examinerId ? examinerFor(ctx, d, input.examinerId) : defaultExaminer(first);
  return examsRepo.insertPaper(client, ctx.term.id, ctx.department.id, {
    title: input.title?.trim() || first.title,
    examinerId,
    notes: input.notes?.trim() ?? '',
    unitIds: ids,
  });
}

export async function updatePaperIn(client: PoolClient, ctx: Ctx, paperId: string, input: PaperInput): Promise<void> {
  const d = await load(ctx.term.id, client, [ctx.department.id]);
  const paper = ownPaper(ctx, d, paperId);
  await examsRepo.updatePaper(client, paper.id, {
    unitIds: input.unitIds?.length ? checkUnits(ctx, d, input.unitIds, paper) : paper.unitIds,
    title: input.title?.trim() || paper.title,
    examinerId: input.examinerId !== undefined ? (input.examinerId ? examinerFor(ctx, d, input.examinerId) : null) : paper.examinerId,
    notes: input.notes !== undefined ? input.notes.trim() : paper.notes,
  });
}

const changed = (ctx: Ctx, what: string, id: string, data: unknown) => audit(ctx, AuditAction.TEACHING_CHANGED, { what, id, after: data });

export async function createPaper(ctx: Ctx, input: PaperInput): Promise<{ id: string }> {
  const id = await exams(ctx, (client) => createPaperIn(client, ctx, input));
  await changed(ctx, 'exam_paper.create', id, input);
  return { id };
}

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

/** A paper per unit of the department's not on one yet (nor marked no written exam), titled as the unit. */
export async function startFromUnits(ctx: Ctx): Promise<{ created: number }> {
  const created = await exams(ctx, async (client) => {
    const d = await load(ctx.term.id, client, [ctx.department.id]);
    const onPaper = new Set(d.exams.papers.flatMap((p) => p.unitIds));
    let n = 0;
    for (const u of d.term.units) {
      if (u.departmentId !== ctx.department.id || onPaper.has(u.id) || d.exams.noWrittenExam.has(u.id)) continue;
      await examsRepo.insertPaper(client, ctx.term.id, ctx.department.id, { title: u.title, examinerId: defaultExaminer(u), notes: '', unitIds: [u.id] });
      n++;
    }
    return n;
  });
  if (created) await changed(ctx, 'exam_paper.from_units', ctx.department.code, { created });
  return { created };
}

export async function setNoWrittenExamIn(client: PoolClient, ctx: Ctx, unitId: string, value: boolean): Promise<void> {
  const d = await load(ctx.term.id, client);
  const unit = d.units.get(unitId);
  if (!unit || unit.departmentId !== ctx.department.id) throw AppError.notFound('No such unit in your department.');
  if (value && d.exams.papers.some((p) => p.unitIds.includes(unit.id))) {
    throw new AppError(409, ErrorCode.TEACHING_IN_USE, `${unit.code} is on a paper; take it off the paper first.`);
  }
  await examsRepo.setNoWrittenExam(client, unit.id, value);
}

export async function setNoWrittenExam(ctx: Ctx, unitId: string, value: boolean): Promise<void> {
  await exams(ctx, (client) => setNoWrittenExamIn(client, ctx, unitId, value));
  await changed(ctx, 'unit.no_written_exam', unitId, { noWrittenExam: value });
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

export async function publish(ctx: Ctx): Promise<ExamBoardDto> {
  const papers = await exams(ctx, async (client) => {
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
  });
  await audit(ctx, AuditAction.TEACHING_PUBLISHED, { kind: KIND, papers });
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
  for (const dept of departments.filter((x) => compact(x.code))) {
    const code = compact(dept.code);
    const pub = latest.get(dept.id);
    if (!pub || pub.reopenedAt) {
      waiting.push({ code, name: dept.name, reopened_at: pub?.reopenedAt?.toISOString() ?? null });
      continue;
    }
    const papers = d.exams.papers
      .filter((p) => p.departmentId === dept.id)
      .sort((a, b) => paperCodes(a, d.units).join('/').localeCompare(paperCodes(b, d.units).join('/')))
      .map((p) => {
        const sitting = paperCourses(p, d);
        for (const c of sitting) needed.add(c.id);
        const examiner: LecturerRow | undefined = p.examinerId ? d.term.lecturers.get(p.examinerId) : undefined;
        return {
          id: p.id,
          codes: paperCodes(p, d.units),
          title: p.title,
          examiner: examiner ? { staff_number: examiner.staffNumber, name: displayName(examiner) } : null,
          notes: p.notes,
          rows: sitting.map((c) => ({ course_id: c.id, students: c.students, mode: c.mode })),
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
    courses: [...needed]
      .map((id) => d.courses.get(id)!)
      .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)))
      .map((c) => ({
        id: c.id, department_code: c.departmentCode, programme: c.programme, year: c.year, semester: c.semester,
        sub_class: c.subClass, label: courseLabel(c), students: c.students, mode: c.mode,
      })),
    published,
    not_published: waiting,
  };
}

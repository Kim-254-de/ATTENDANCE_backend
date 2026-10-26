import type { PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { AuditAction } from '../../db/types.js';
import { sharedExamDraft, type SharedExamDraft, type SharedPaper } from '../../integrations/generator/generator.client.js';
import * as examsRepo from './exams.repository.js';
import { paperLabel } from './exams.service.js';
import * as repo from './teaching.repository.js';
import { type LecturerRow } from './teaching.repository.js';
import { audit, displayName, invalid, person, publicationDto, writeTeaching, type Ctx, type PublicationDto } from './teaching.service.js';

/**
 * Invigilators, named by departments on the exam draft the Director shared
 * in the Generator (it used to be the Timetable Allocator's).
 *
 * Each of a department's papers gets one invigilator, who administers it,
 * collects the scripts and takes them away. Anyone on any department's list
 * can be named; one person (one staff number) is never in two places in one
 * session, and never over their duty limit when one is set. An officer
 * publishes the invigilators; the Director can publish the exam timetable
 * only when every paper has one.
 *
 * An invigilation's `room` is '' for the whole paper. (Naming one per extra
 * room of a multi-room paper is still to be confirmed.)
 */

const KIND = 'invigilators' as const;
const WHOLE_PAPER = '';

const when = (p: SharedPaper) => `${p.date} ${p.startTime}-${p.endTime}`;

async function shared(ctx: Ctx): Promise<{ draft: SharedExamDraft['draft']; papers: Map<string, SharedPaper> }> {
  const data = await sharedExamDraft(ctx.term.id);
  return { draft: data.draft, papers: new Map(data.papers.map((p) => [p.paperRef, p])) };
}

export interface InvigilatorBoardDto {
  term: Ctx['term'];
  department: Ctx['department'];
  draft: SharedExamDraft['draft'];
  canEdit: boolean;
  published: boolean;
  publication: PublicationDto | null;
  papers: Array<{
    paperId: string; codes: string; title: string;
    date: string | null; session: number | null; startTime: string | null; endTime: string | null; rooms: string[];
    invigilatorId: string | null; invigilator: string | null; invigilatorDepartment: string | null;
  }>;
  lecturers: Array<{ id: string; display: string; departmentCode: string; staffNumber: string | null; duties: number; maxExamDuties: number | null; own: boolean }>;
  problems: Array<{ code: string; message: string }>;
}

export async function board(ctx: Ctx): Promise<InvigilatorBoardDto> {
  const [draft, term, exams, everyone, latest] = await Promise.all([
    shared(ctx),
    repo.loadTerm(ctx.term.id),
    examsRepo.loadExams(ctx.term.id),
    repo.listAllLecturers(),
    repo.latestPublication(ctx.term.id, ctx.department.id, undefined, KIND),
  ]);
  const units = new Map(term.units.map((u) => [u.id, u]));
  const lecturers = new Map(everyone.map((l) => [l.id, l]));
  const byPaper = new Map(exams.invigilations.filter((i) => i.room === WHOLE_PAPER).map((i) => [i.paperId, i]));
  const duties = new Map<string, number>();
  for (const i of exams.invigilations) {
    const l = lecturers.get(i.lecturerId);
    if (l) duties.set(person(l), (duties.get(person(l)) ?? 0) + 1);
  }
  const standing = latest && !latest.reopenedAt ? latest : null;
  const own = exams.papers.filter((p) => p.departmentId === ctx.department.id);
  const papers = own
    .map((p) => {
      const where = draft.papers.get(p.id);
      const inv = byPaper.get(p.id);
      const l = inv ? lecturers.get(inv.lecturerId) : undefined;
      return {
        paperId: p.id,
        codes: paperLabel(p, units),
        title: p.title,
        date: where?.date ?? null,
        session: where?.session ?? null,
        startTime: where?.startTime ?? null,
        endTime: where?.endTime ?? null,
        rooms: where?.rooms ?? [],
        invigilatorId: inv?.lecturerId ?? null,
        invigilator: l ? displayName(l) : null,
        invigilatorDepartment: l?.departmentCode ?? null,
      };
    })
    .sort((a, b) => a.codes.localeCompare(b.codes));
  return {
    term: ctx.term,
    department: ctx.department,
    draft: draft.draft,
    canEdit: standing === null && draft.draft !== null,
    published: standing !== null,
    publication: publicationDto(latest),
    papers,
    lecturers: everyone
      .filter((l) => l.active && l.staffNumber)
      .map((l) => ({
        id: l.id,
        display: displayName(l),
        departmentCode: l.departmentCode,
        staffNumber: l.staffNumber,
        duties: duties.get(person(l)) ?? 0,
        maxExamDuties: l.maxExamDuties,
        own: l.departmentId === ctx.department.id,
      })),
    problems: own
      .filter((p) => draft.papers.has(p.id) && !byPaper.has(p.id))
      .map((p) => ({ code: 'no_invigilator', message: `Name an invigilator for ${p.title}.` })),
  };
}

/** Names (or clears) a paper's invigilator: never someone busy then, or at their duty limit. */
export async function setInvigilator(ctx: Ctx, paperId: string, lecturerId: string | null): Promise<void> {
  const draft = await shared(ctx);
  await writeTeaching(
    ctx,
    async (client: PoolClient) => {
      const exams = await examsRepo.loadExams(ctx.term.id, client);
      const paper = exams.papers.find((p) => p.id === paperId);
      if (!paper || paper.departmentId !== ctx.department.id) throw AppError.notFound('No such paper in your department.');
      const where = draft.papers.get(paper.id);
      if (!where) throw new AppError(409, ErrorCode.CONFLICT, "The Director's shared exam draft doesn't have this paper yet.");
      if (lecturerId === null) {
        await examsRepo.clearInvigilation(client, paper.id, WHOLE_PAPER);
        return;
      }
      const everyone = await repo.listAllLecturers(client);
      const lecturer = everyone.find((l) => l.id === lecturerId);
      if (!lecturer) throw AppError.notFound('No such lecturer.');
      if (!lecturer.active || !lecturer.staffNumber) throw invalid(`${lecturer.fullName} needs to be active, with a staff number.`);
      const who = person(lecturer);
      const byId = new Map(everyone.map((l) => [l.id, l]));
      let duties = 0;
      for (const other of exams.invigilations) {
        const l: LecturerRow | undefined = byId.get(other.lecturerId);
        if (other.paperId === paper.id || !l || person(l) !== who) continue;
        duties++;
        const there = draft.papers.get(other.paperId);
        if (there && there.date === where.date && there.session === where.session) {
          const otherPaper = exams.papers.find((p) => p.id === other.paperId);
          throw new AppError(409, ErrorCode.CONFLICT, `${lecturer.fullName} already invigilates ${otherPaper?.title ?? 'a paper'} on ${when(where)}.`);
        }
      }
      // The same person on every department's list: the smallest limit set applies.
      const limits = everyone.filter((l) => l.staffNumber === lecturer.staffNumber && l.maxExamDuties).map((l) => l.maxExamDuties!);
      const limit = limits.length ? Math.min(...limits) : null;
      if (limit !== null && duties + 1 > limit) {
        throw new AppError(409, ErrorCode.CONFLICT, `${lecturer.fullName} already has ${duties} duties; the limit is ${limit}.`);
      }
      await examsRepo.setInvigilation(client, paper.id, WHOLE_PAPER, lecturer.id, ctx.actor);
    },
    { kind: KIND },
  );
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: lecturerId ? 'invigilation.set' : 'invigilation.clear', id: paperId, after: { lecturerId } });
}

export async function publish(ctx: Ctx): Promise<InvigilatorBoardDto> {
  const current = await board(ctx);
  if (!current.draft) throw new AppError(409, ErrorCode.TEACHING_NOT_READY, "The Director hasn't shared an exam draft yet.");
  if (current.problems.length) {
    throw new AppError(409, ErrorCode.TEACHING_NOT_READY, `${current.problems.length} papers have no invigilator yet.`, {
      details: { problems: current.problems },
    });
  }
  await writeTeaching(
    ctx,
    (client) =>
      repo.insertPublication(client, {
        termId: ctx.term.id, departmentId: ctx.department.id, userId: ctx.userId, name: ctx.actor,
        unitCount: current.papers.length, groupCount: 0, kind: KIND,
      }),
    { kind: KIND },
  );
  await audit(ctx, AuditAction.TEACHING_PUBLISHED, { kind: KIND, papers: current.papers.length });
  return board(ctx);
}

export async function reopen(ctx: Ctx): Promise<InvigilatorBoardDto> {
  await writeTeaching(
    ctx,
    async (client) => {
      const latest = await repo.latestPublication(ctx.term.id, ctx.department.id, client, KIND);
      if (!latest || latest.reopenedAt) throw new AppError(409, ErrorCode.TEACHING_NOT_PUBLISHED, "Your department's invigilators haven't been published.");
      await repo.reopenPublication(client, latest.id, ctx.actor);
    },
    { whilePublished: true },
  );
  await audit(ctx, AuditAction.TEACHING_REOPENED, { kind: KIND });
  return board(ctx);
}

/**
 * Each paper's invigilator, from departments that published them:
 * { paper id: { room: { staff_number, name } } }, as the Generator reads it.
 */
export async function forGenerator(termId: string): Promise<Record<string, Record<string, { staff_number: string | null; name: string }>>> {
  const [exams, latest, everyone] = await Promise.all([examsRepo.loadExams(termId), repo.latestPublications(termId, KIND), repo.listAllLecturers()]);
  const published = new Set([...latest.values()].filter((p) => !p.reopenedAt).map((p) => p.departmentId));
  const lecturers = new Map(everyone.map((l) => [l.id, l]));
  const papers = new Map(exams.papers.map((p) => [p.id, p]));
  const out: Record<string, Record<string, { staff_number: string | null; name: string }>> = {};
  for (const inv of exams.invigilations) {
    const paper = papers.get(inv.paperId);
    const l = lecturers.get(inv.lecturerId);
    if (!paper || !l || !published.has(paper.departmentId)) continue;
    (out[inv.paperId] ??= {})[inv.room] = { staff_number: l.staffNumber, name: displayName(l) };
  }
  return out;
}

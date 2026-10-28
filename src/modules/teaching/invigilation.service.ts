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
 * Invigilators, named by departments for their exam papers.
 *
 * Each paper has a main invigilator, who administers it in its main room (the
 * one with most of its students) and collects every room's scripts; each extra
 * room of a paper split over rooms has an invigilator of its own. The main
 * invigilator can be named any time, before the Director generates the exam
 * timetable too (the Generator then keeps their papers apart); the extra
 * rooms are known once the Director shares an exam draft. Anyone on any
 * department's list can be named; one person (one staff number) is never in
 * two places in one session, and never over their duty limit when one is
 * set. An officer publishes the invigilators once the draft is shared; the
 * Director can publish the exam timetable only when every paper has its main
 * invigilator and every extra room its own.
 *
 * An invigilation's `room` is '' for the main invigilator, else the extra room.
 */

const KIND = 'invigilators' as const;
const MAIN = '';

const when = (p: SharedPaper) => `${p.date} ${p.startTime}-${p.endTime}`;
const slotOf = (p: SharedPaper | undefined) => (p?.date && p.session !== null ? `${p.date}|${p.session}` : null);

async function shared(ctx: Ctx): Promise<{ draft: SharedExamDraft['draft']; papers: Map<string, SharedPaper> }> {
  const data = await sharedExamDraft(ctx.term.id);
  return { draft: data.draft, papers: new Map(data.papers.map((p) => [p.paperRef, p])) };
}

interface Named {
  invigilatorId: string | null;
  invigilator: string | null;
  invigilatorDepartment: string | null;
}

export interface InvigilatorBoardDto {
  term: Ctx['term'];
  department: Ctx['department'];
  draft: SharedExamDraft['draft'];
  canEdit: boolean;
  published: boolean;
  publication: PublicationDto | null;
  papers: Array<
    Named & {
      paperId: string; codes: string; title: string;
      date: string | null; session: number | null; startTime: string | null; endTime: string | null; rooms: string[];
      /** In the shared draft: placed in a session. */
      placed: boolean;
      mainRoom: string | null;
      /** Each extra room and its invigilator. */
      extras: Array<Named & { room: string }>;
    }
  >;
  lecturers: Array<{ id: string; display: string; departmentCode: string; staffNumber: string | null; duties: number; maxExamDuties: number | null; own: boolean }>;
  problems: Array<{ code: string; message: string }>;
}

/** The smallest duty limit set for this person on any department's list. */
function limitOf(everyone: LecturerRow[], l: LecturerRow): number | null {
  const limits = everyone.filter((x) => person(x) === person(l) && x.maxExamDuties).map((x) => x.maxExamDuties!);
  return limits.length ? Math.min(...limits) : null;
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
  const at = new Map(exams.invigilations.map((i) => [`${i.paperId}|${i.room}`, i]));
  const named = (paperId: string, room: string): Named => {
    const l = at.has(`${paperId}|${room}`) ? lecturers.get(at.get(`${paperId}|${room}`)!.lecturerId) : undefined;
    return { invigilatorId: l?.id ?? null, invigilator: l ? displayName(l) : null, invigilatorDepartment: l?.departmentCode ?? null };
  };
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
      return {
        paperId: p.id,
        codes: paperLabel(p, units),
        title: p.title,
        date: where?.date ?? null,
        session: where?.session ?? null,
        startTime: where?.startTime ?? null,
        endTime: where?.endTime ?? null,
        rooms: where?.rooms ?? [],
        placed: !!where,
        mainRoom: where?.mainRoom ?? null,
        ...named(p.id, MAIN),
        extras: (where?.extraRooms ?? []).map((room) => ({ room, ...named(p.id, room) })),
      };
    })
    .sort((a, b) => a.codes.localeCompare(b.codes));

  const problems: InvigilatorBoardDto['problems'] = [];
  for (const p of papers) {
    // A paper nobody is known to sit has no room yet; it waits for its students' numbers, not an invigilator.
    if (!p.placed || p.rooms.length === 0) continue;
    if (!p.invigilatorId) problems.push({ code: 'no_invigilator', message: `Name the main invigilator for ${p.codes}.` });
    for (const x of p.extras) {
      if (!x.invigilatorId) problems.push({ code: 'no_invigilator', message: `Name an invigilator for ${p.codes} in ${x.room}.` });
    }
  }
  // Clashes, now that sessions are known: one person in two places at once (any department's papers).
  const titles = new Map(exams.papers.map((p) => [p.id, paperLabel(p, units)]));
  const ownIds = new Set(own.map((p) => p.id));
  const bySlot = new Map<string, Array<{ paperId: string; who: LecturerRow }>>();
  for (const i of exams.invigilations) {
    const l = lecturers.get(i.lecturerId);
    const slot = slotOf(draft.papers.get(i.paperId));
    if (!l || !slot) continue;
    const key = `${person(l)}|${slot}`;
    bySlot.set(key, [...(bySlot.get(key) ?? []), { paperId: i.paperId, who: l }]);
  }
  for (const list of bySlot.values()) {
    const distinct = [...new Set(list.map((x) => x.paperId))];
    if (distinct.length < 2 && list.length < 2) continue;
    if (!list.some((x) => ownIds.has(x.paperId))) continue;
    const where = draft.papers.get(list[0]!.paperId)!;
    problems.push({
      code: 'invigilator_clash',
      message: `${list[0]!.who.fullName} is named for ${distinct.map((id) => titles.get(id)).join(' and ')}${distinct.length < 2 ? ' twice' : ''} at the same time (${when(where)}).`,
    });
  }
  for (const l of everyone.filter((x) => x.departmentId === ctx.department.id && x.staffNumber)) {
    const limit = limitOf(everyone, l);
    const n = duties.get(person(l)) ?? 0;
    if (limit !== null && n > limit) problems.push({ code: 'over_limit', message: `${l.fullName} has ${n} duties; the limit is ${limit}.` });
  }

  return {
    term: ctx.term,
    department: ctx.department,
    draft: draft.draft,
    canEdit: standing === null,
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
    problems,
  };
}

/**
 * Names (or clears) a paper's main invigilator (`room` '') or an extra room's.
 * Never someone already in another room of the paper, busy in another paper
 * in that session, or at their duty limit.
 */
export async function setInvigilator(ctx: Ctx, paperId: string, lecturerId: string | null, room = MAIN): Promise<void> {
  const draft = await shared(ctx);
  await writeTeaching(
    ctx,
    async (client: PoolClient) => {
      const exams = await examsRepo.loadExams(ctx.term.id, client);
      const paper = exams.papers.find((p) => p.id === paperId);
      if (!paper || paper.departmentId !== ctx.department.id) throw AppError.notFound('No such paper in your department.');
      const where = draft.papers.get(paper.id);
      if (room !== MAIN && !where?.extraRooms.includes(room)) {
        throw new AppError(409, ErrorCode.CONFLICT, `${room} is not an extra room of this paper in the Director's shared exam draft.`);
      }
      if (lecturerId === null) {
        await examsRepo.clearInvigilation(client, paper.id, room);
        return;
      }
      const everyone = await repo.listAllLecturers(client);
      const lecturer = everyone.find((l) => l.id === lecturerId);
      if (!lecturer) throw AppError.notFound('No such lecturer.');
      if (!lecturer.active || !lecturer.staffNumber) throw invalid(`${lecturer.fullName} needs to be active, with a staff number.`);
      const who = person(lecturer);
      const byId = new Map(everyone.map((l) => [l.id, l]));
      const slot = slotOf(where);
      let duties = 0;
      for (const other of exams.invigilations) {
        const l: LecturerRow | undefined = byId.get(other.lecturerId);
        if (!l || person(l) !== who || (other.paperId === paper.id && other.room === room)) continue;
        duties++;
        if (other.paperId === paper.id) {
          throw new AppError(409, ErrorCode.CONFLICT, `${lecturer.fullName} is already named for ${other.room || 'the main room'} of this paper.`);
        }
        if (slot && slot === slotOf(draft.papers.get(other.paperId))) {
          const otherPaper = exams.papers.find((p) => p.id === other.paperId);
          throw new AppError(409, ErrorCode.CONFLICT, `${lecturer.fullName} already invigilates ${otherPaper?.title ?? 'a paper'} on ${when(where!)}.`);
        }
      }
      // The same person on every department's list: the smallest limit set applies.
      const limit = limitOf(everyone, lecturer);
      if (limit !== null && duties + 1 > limit) {
        throw new AppError(409, ErrorCode.CONFLICT, `${lecturer.fullName} already has ${duties} duties; the limit is ${limit}.`);
      }
      await examsRepo.setInvigilation(client, paper.id, room, lecturer.id, ctx.actor);
    },
    { kind: KIND },
  );
  await audit(ctx, AuditAction.TEACHING_CHANGED, { what: lecturerId ? 'invigilation.set' : 'invigilation.clear', id: paperId, after: { lecturerId, room } });
}

export async function publish(ctx: Ctx): Promise<InvigilatorBoardDto> {
  const current = await board(ctx);
  if (!current.draft) throw new AppError(409, ErrorCode.TEACHING_NOT_READY, "The Director hasn't shared an exam draft yet.");
  if (current.problems.length) {
    throw new AppError(409, ErrorCode.TEACHING_NOT_READY, `${current.problems.length} things to fix first: ${current.problems[0]!.message}`, {
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

import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { transaction } from '../../db/database.js';
import { AuditAction } from '../../db/types.js';
import { listTerms, termTimes, type GeneratorTerm, type Meeting } from '../../integrations/generator/generator.client.js';
import { auditService } from '../audit/index.js';
import { findOfficerDepartment } from '../department/department.repository.js';
import * as repo from './teaching.repository.js';
import { compact, type CourseMode, type CourseRow, type GroupRow, type LecturerRow, type MemberRow, type PublicationKind, type RoomType, type TermData, type UnitRow } from './teaching.repository.js';

/**
 * What a department teaches in a term of the Timetable Generator, entered by
 * its officers and published to the Director. This used to be the separate
 * Timetable Allocator; the rules are the same.
 *
 * For a term, each department enters its courses (cohorts, which become the
 * Generator's class rows), its units with the courses that take them, and
 * each unit's groups: the whole class, or a split into groups A, B, C...,
 * each with its courses, students, lecturer and the form's L/P/CF hours. A
 * unit taught to another department's students is entered by the department
 * that owns it, which picks the other department's courses from the shared
 * list.
 *
 * An officer publishes the department's list once nothing is missing; that
 * locks it until an officer reopens it. The Generator imports what is
 * published (`submissions`), gives every group a day, time and room, and the
 * Director publishes the timetable; each class's times then show here. There
 * is no clash check here: times don't exist until the Generator solves.
 *
 * Scope comes from the officer's own department_profiles row, never from the
 * request, as everywhere in the department portal.
 */

export const ROOM_TYPES: Record<RoomType, string> = { lecture_hall: 'Lecture hall', lab: 'Lab', seminar: 'Seminar room' };

export interface Ctx {
  term: GeneratorTerm;
  department: { id: string; name: string; code: string };
  userId: string;
  actor: string;
}

// -- terms (the Generator's) -----------------------------------------------------------------------

const TERMS_CACHE_MS = 30_000;
let termsCache: { at: number; terms: GeneratorTerm[] } | null = null;

/** The Generator's terms, newest first. Cached briefly: every page load and every save needs them. */
export async function terms(): Promise<GeneratorTerm[]> {
  if (termsCache && Date.now() - termsCache.at < TERMS_CACHE_MS) return termsCache.terms;
  const list = await listTerms();
  termsCache = { at: Date.now(), terms: list };
  return list;
}

/** Tests only. */
export function clearTermsCache(): void {
  termsCache = null;
}

async function pickTerm(termId: string | undefined): Promise<GeneratorTerm> {
  const list = await terms();
  if (list.length === 0) throw new AppError(404, ErrorCode.NOT_FOUND, 'The Timetable Generator has no term yet. The Director opens terms there.');
  if (!termId) return list[0]!;
  const found = list.find((t) => t.id === termId);
  if (!found) throw AppError.notFound('The Timetable Generator has no such term.');
  return found;
}

export async function context(userId: string, termId: string | undefined): Promise<Ctx> {
  const own = await findOfficerDepartment(userId);
  if (!own) throw AppError.forbidden('Your account is not attached to a department.');
  const code = compact(own.departmentCode);
  if (!code) {
    throw new AppError(409, ErrorCode.CONFLICT, 'Your department has no code yet, so the Timetable Generator cannot tell it apart. Ask the administrator to give it one.');
  }
  const [term, actor] = await Promise.all([pickTerm(termId), repo.findUserName(userId)]);
  return { term, department: { id: own.departmentId, name: own.departmentName, code }, userId, actor };
}

// -- shared ----------------------------------------------------------------------------------------

/** 'COSC 103', 'GR A' -> 'COSC103-GRA'; a whole class -> 'COSC103-MAIN', as the Generator keys it. */
export const classKey = (unitCode: string, groupLabel: string): string => `${compact(unitCode)}-${compact(groupLabel) || 'MAIN'}`;

/** As the Generator prints class rows: 'BSC.CS Y1S1', 'BSC.CS Y1S1 (A)'. */
export const courseLabel = (c: Pick<CourseRow, 'programme' | 'year' | 'semester' | 'subClass'>): string =>
  `${c.programme} Y${c.year}S${c.semester}${c.subClass ? ` (${c.subClass})` : ''}`;

const EMPLOYMENT_SHORT = { full_time: 'FT', part_time: 'PT' } as const;

/** 'Dr. Jane Otieno (FT)', as the allocation form writes lecturers. */
export const displayName = (l: LecturerRow): string => `${l.title ? `${l.title} ` : ''}${l.fullName} (${EMPLOYMENT_SHORT[l.employmentType]})`;

/** One person across departments' lists: the staff number when known. */
export const person = (l: LecturerRow): string => (l.staffNumber ? `staff:${l.staffNumber.toUpperCase()}` : `id:${l.id}`);

/** Collapses runs of whitespace and trims. */
const squash = (value: string): string => value.split(/\s+/).filter(Boolean).join(' ');

/** 'a', 'Group A', 'GR A' -> 'GR A'; blank -> '' (the whole class). */
export function groupLabel(raw: string | null | undefined): string {
  let text = squash(raw ?? '').toUpperCase();
  for (const prefix of ['GROUP', 'GRP', 'GR.']) {
    if (text.startsWith(prefix)) text = text.slice(prefix.length).trim();
  }
  if (text.startsWith('GR ') || text === 'GR') text = text.slice(2).trim();
  return text ? `GR ${text}` : '';
}

const memberStudents = (m: MemberRow, courses: Map<string, CourseRow>): number => m.students ?? courses.get(m.courseId)?.students ?? 0;
const groupStudents = (g: GroupRow, courses: Map<string, CourseRow>): number => g.members.reduce((n, m) => n + memberStudents(m, courses), 0);

/** Everything the Director gets about a unit, hashed: a unit that changed since publishing differs. */
export function signature(u: UnitRow, courses: Map<string, CourseRow>, lecturers: Map<string, LecturerRow>): string {
  const label = (id: string) => {
    const c = courses.get(id);
    return c ? courseLabel(c) : id;
  };
  const data = {
    code: u.code,
    title: u.title,
    weeklyHours: u.weeklyHours,
    classLength: u.classLength,
    roomType: u.roomType,
    courses: u.courseIds.map(label).sort(),
    groups: [...u.groups]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((g) => ({
        label: g.label,
        members: g.members.map((m) => [label(m.courseId), m.students ?? 0] as const).sort((a, b) => a[0].localeCompare(b[0])),
        lecturer: g.lecturerId ? (lecturers.get(g.lecturerId)?.staffNumber ?? null) : null,
        hours: [g.lectureHours, g.practicalHours, g.cfHours],
      })),
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

/** Each person's teaching hours a week, from every department's groups (one person = one staff number). */
function weeklyLoad(units: UnitRow[], lecturers: Map<string, LecturerRow>): Map<string, number> {
  const load = new Map<string, number>();
  for (const u of units) {
    for (const g of u.groups) {
      const l = g.lecturerId ? lecturers.get(g.lecturerId) : undefined;
      if (l) load.set(person(l), (load.get(person(l)) ?? 0) + u.weeklyHours);
    }
  }
  return load;
}

export interface Problem {
  code: string;
  message: string;
  unitId: string | null;
}

/** What must be fixed before the department can publish. */
export function problems(own: UnitRow[], all: UnitRow[], courses: Map<string, CourseRow>, lecturers: Map<string, LecturerRow>): Problem[] {
  const found: Problem[] = [];
  const add = (code: string, message: string, unit?: UnitRow) => found.push({ code, message, unitId: unit?.id ?? null });
  if (own.length === 0) add('no_units', 'Add at least one unit.');
  const named = new Map<string, LecturerRow>();
  for (const u of own) {
    if (u.courseIds.length === 0) add('no_courses', `${u.code} has no courses taking it.`, u);
    if (u.groups.length === 0) add('no_groups', `${u.code} has no group.`, u);
    const inGroups = new Map<string, MemberRow[]>();
    for (const g of u.groups) {
      const name = `${u.code} ${g.label}`.trim();
      const l = g.lecturerId ? lecturers.get(g.lecturerId) : undefined;
      if (!l) add('no_lecturer', `${name} has no lecturer.`, u);
      else named.set(l.id, l);
      if (g.members.length === 0) add('empty_group', `${name} has no courses in it.`, u);
      for (const m of g.members) inGroups.set(m.courseId, [...(inGroups.get(m.courseId) ?? []), m]);
    }
    for (const courseId of u.courseIds) {
      const course = courses.get(courseId);
      if (!course) continue;
      const members = inGroups.get(courseId) ?? [];
      if (members.length === 0) {
        if (u.groups.length > 0) add('course_not_in_group', `${courseLabel(course)} takes ${u.code} but is in none of its groups.`, u);
        continue;
      }
      const total = members.reduce((n, m) => n + memberStudents(m, courses), 0);
      if (total !== course.students) {
        add('split_total', `${courseLabel(course)} has ${course.students} students, but ${u.code}'s groups have ${total} of them.`, u);
      }
    }
  }
  const load = weeklyLoad(all, lecturers);
  for (const l of [...named.values()].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    if (!l.staffNumber) add('no_staff_number', `Add ${l.fullName}'s staff number on the Lecturers tab.`);
    const hours = load.get(person(l)) ?? 0;
    if (l.maxWeeklyHours && hours > l.maxWeeklyHours) {
      add('over_hours', `${l.fullName} would teach ${hours} hours a week across all departments; the limit is ${l.maxWeeklyHours}.`);
    }
  }
  return found;
}

// -- the department's page -----------------------------------------------------------------------

export interface CourseDto {
  id: string;
  departmentCode: string;
  programme: string;
  year: number;
  semester: number;
  subClass: string;
  label: string;
  students: number;
  mode: CourseMode;
}

const courseDto = (c: CourseRow): CourseDto => ({
  id: c.id,
  departmentCode: c.departmentCode,
  programme: c.programme,
  year: c.year,
  semester: c.semester,
  subClass: c.subClass,
  label: courseLabel(c),
  students: c.students,
  mode: c.mode,
});

export interface LecturerDto {
  id: string;
  title: string;
  fullName: string;
  staffNumber: string | null;
  employmentType: 'full_time' | 'part_time';
  phone: string;
  email: string;
  maxWeeklyHours: number | null;
  maxExamDuties: number | null;
  active: boolean;
  display: string;
}

export const lecturerDto = (l: LecturerRow): LecturerDto => ({
  id: l.id,
  title: l.title,
  fullName: l.fullName,
  staffNumber: l.staffNumber,
  employmentType: l.employmentType,
  phone: l.phone,
  email: l.email,
  maxWeeklyHours: l.maxWeeklyHours,
  maxExamDuties: l.maxExamDuties,
  active: l.active,
  display: displayName(l),
});

export interface PublicationDto {
  publishedBy: string;
  publishedAt: string;
  unitCount: number;
  groupCount: number;
  reopenedAt: string | null;
  reopenedBy: string | null;
}

export const publicationDto = (p: repo.PublicationRow | null): PublicationDto | null =>
  p && {
    publishedBy: p.publishedByName,
    publishedAt: p.publishedAt.toISOString(),
    unitCount: p.unitCount,
    groupCount: p.groupCount,
    reopenedAt: p.reopenedAt?.toISOString() ?? null,
    reopenedBy: p.reopenedByName,
  };

const DAY_ORDER: Record<string, number> = { MON: 0, TUE: 1, WED: 2, THU: 3, FRI: 4 };
const sortMeetings = (meetings: Meeting[]): Meeting[] =>
  [...meetings].sort((a, b) => (DAY_ORDER[a.dayOfWeek] ?? 9) - (DAY_ORDER[b.dayOfWeek] ?? 9) || a.startTime.localeCompare(b.startTime));

export interface UnitDto {
  id: string;
  code: string;
  title: string;
  weeklyHours: number;
  classLength: number;
  roomType: RoomType;
  courses: Array<{ id: string; label: string; departmentCode: string | null; students: number }>;
  servicing: boolean;
  changedSincePublished: boolean;
  groups: Array<{
    id: string;
    key: string;
    label: string;
    members: Array<{ id: string; label: string; departmentCode: string | null; students: number; givenStudents: number | null }>;
    students: number;
    lecturerId: string | null;
    lecturer: string | null;
    lectureHours: number | null;
    practicalHours: number | null;
    cfHours: number | null;
    meetings: Meeting[];
  }>;
}

function unitDto(
  u: UnitRow,
  courses: Map<string, CourseRow>,
  lecturers: Map<string, LecturerRow>,
  times: Record<string, Meeting[]>,
  everPublished: boolean,
): UnitDto {
  const course = (id: string) => {
    const c = courses.get(id);
    return c ? { id, label: courseLabel(c), departmentCode: c.departmentCode, students: c.students } : { id, label: '?', departmentCode: null, students: 0 };
  };
  const taking = u.courseIds.map(course).sort((a, b) => a.label.localeCompare(b.label));
  return {
    id: u.id,
    code: u.code,
    title: u.title,
    weeklyHours: u.weeklyHours,
    classLength: u.classLength,
    roomType: u.roomType,
    courses: taking,
    servicing: taking.some((c) => c.departmentCode && c.departmentCode !== u.departmentCode),
    changedSincePublished: everPublished && u.publishedSignature !== signature(u, courses, lecturers),
    groups: u.groups.map((g) => {
      const l = g.lecturerId ? lecturers.get(g.lecturerId) : undefined;
      return {
        id: g.id,
        key: classKey(u.code, g.label),
        label: g.label,
        members: g.members.map((m) => ({ ...course(m.courseId), givenStudents: m.students })).sort((a, b) => a.label.localeCompare(b.label)),
        students: groupStudents(g, courses),
        lecturerId: g.lecturerId,
        lecturer: l ? displayName(l) : null,
        lectureHours: g.lectureHours,
        practicalHours: g.practicalHours,
        cfHours: g.cfHours,
        meetings: sortMeetings(times[classKey(u.code, g.label)] ?? []),
      };
    }),
  };
}

export interface BoardDto {
  term: GeneratorTerm;
  terms: GeneratorTerm[];
  department: Ctx['department'];
  canEdit: boolean;
  published: boolean;
  publication: PublicationDto | null;
  courses: Array<CourseDto & { usedBy: string[] }>;
  /** Every other department's courses, read-only, for units this department services. */
  otherCourses: CourseDto[];
  units: UnitDto[];
  lecturers: Array<LecturerDto & { groups: number; weeklyHours: number }>;
  problems: Problem[];
  times: { publishedVersion: number | null; error: string | null };
  summary: { courses: number; units: number; groups: number; withLecturer: number; changed: number; problems: number };
}

async function publishedTimes(term: GeneratorTerm): Promise<{ publishedVersion: number | null; classes: Record<string, Meeting[]>; error: string | null }> {
  if (term.publishedVersion === null) return { publishedVersion: null, classes: {}, error: null };
  try {
    return { ...(await termTimes(term.id)), error: null };
  } catch (error) {
    return { publishedVersion: null, classes: {}, error: error instanceof AppError ? error.message : 'The times could not be read.' };
  }
}

/** Everything on the department's Teaching page. */
export async function board(ctx: Ctx): Promise<BoardDto> {
  const [data, latest, times, allTerms] = await Promise.all([
    repo.loadTerm(ctx.term.id, [ctx.department.id]),
    repo.latestPublication(ctx.term.id, ctx.department.id),
    publishedTimes(ctx.term),
    terms(),
  ]);
  const courses = new Map(data.courses.map((c) => [c.id, c]));
  const own = data.units.filter((u) => u.departmentId === ctx.department.id);
  const standing = latest && !latest.reopenedAt ? latest : null;
  const usedBy = new Map<string, string[]>();
  for (const u of data.units) for (const id of u.courseIds) usedBy.set(id, [...(usedBy.get(id) ?? []), u.code]);
  const load = weeklyLoad(data.units, data.lecturers);
  const ownGroups = new Map<string, number>();
  for (const u of own) for (const g of u.groups) if (g.lecturerId) ownGroups.set(g.lecturerId, (ownGroups.get(g.lecturerId) ?? 0) + 1);
  const found = problems(own, data.units, courses, data.lecturers);
  const units = own.map((u) => unitDto(u, courses, data.lecturers, times.classes, latest !== null));
  const ownCourses = data.courses.filter((c) => c.departmentId === ctx.department.id);
  return {
    term: ctx.term,
    terms: allTerms,
    department: ctx.department,
    canEdit: standing === null,
    published: standing !== null,
    publication: publicationDto(latest),
    courses: ownCourses.map((c) => ({ ...courseDto(c), usedBy: (usedBy.get(c.id) ?? []).sort() })),
    otherCourses: data.courses.filter((c) => c.departmentId !== ctx.department.id).map(courseDto),
    units,
    lecturers: [...data.lecturers.values()]
      .filter((l) => l.departmentId === ctx.department.id)
      .map((l) => ({ ...lecturerDto(l), groups: ownGroups.get(l.id) ?? 0, weeklyHours: load.get(person(l)) ?? 0 })),
    problems: found,
    times: { publishedVersion: times.publishedVersion, error: times.error },
    summary: {
      courses: ownCourses.length,
      units: own.length,
      groups: own.reduce((n, u) => n + u.groups.length, 0),
      withLecturer: own.reduce((n, u) => n + u.groups.filter((g) => g.lecturerId).length, 0),
      changed: units.filter((u) => u.changedSincePublished).length,
      problems: found.length,
    },
  };
}

// -- writing ---------------------------------------------------------------------------------------

/** One write: under the department's lock, refused while the list is published, then audited. */
async function write<T>(
  ctx: Ctx,
  work: (client: PoolClient) => Promise<T>,
  options: { whilePublished?: boolean; kind?: PublicationKind } = {},
): Promise<T> {
  return transaction(async (client) => {
    await repo.lockTerm(client, ctx.term.id, ctx.department.id);
    if (!options.whilePublished) await requireOpen(client, ctx, options.kind ?? 'teaching');
    return work(client);
  });
}

const LIST_NAME: Record<PublicationKind, string> = { teaching: 'teaching list', exams: 'exam paper list', invigilators: 'invigilator list' };

async function requireOpen(client: PoolClient, ctx: Ctx, kind: PublicationKind): Promise<void> {
  const latest = await repo.latestPublication(ctx.term.id, ctx.department.id, client, kind);
  if (latest && !latest.reopenedAt) {
    throw new AppError(409, ErrorCode.TEACHING_PUBLISHED, `Your department's ${LIST_NAME[kind]} has been published. Reopen it before changing it.`);
  }
}

export async function audit(ctx: Ctx, action: AuditAction, metadata: Record<string, unknown>): Promise<void> {
  await auditService.record({
    action,
    outcome: 'SUCCESS',
    userId: ctx.userId,
    metadata: { term: ctx.term.id, department: ctx.department.code, ...metadata },
  });
}

const changed = (ctx: Ctx, what: string, id: string, before: unknown, after: unknown) =>
  audit(ctx, AuditAction.TEACHING_CHANGED, { what, id, before, after });

/** Runs `work` so that a failure undoes only its own writes (bulk imports keep the good rows). */
export async function savepoint<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('SAVEPOINT teaching_row');
  try {
    const result = await work();
    await client.query('RELEASE SAVEPOINT teaching_row');
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT teaching_row');
    throw error;
  }
}

export const invalid = (message: string) => new AppError(422, ErrorCode.VALIDATION_FAILED, message);

// -- courses ---------------------------------------------------------------------------------------

export interface CourseInput {
  programme?: string;
  year?: number;
  semester?: number;
  subClass?: string;
  students?: number;
  mode?: CourseMode;
}

/** Checks everything first, so a refused change leaves the course as it was. */
function courseValues(data: TermData, ctx: Ctx, current: repo.CourseValues | null, input: CourseInput, ignoreId: string | null): repo.CourseValues {
  const v: repo.CourseValues = {
    programme: squash(input.programme ?? current?.programme ?? '').toUpperCase(),
    year: input.year ?? current?.year ?? 0,
    semester: input.semester ?? current?.semester ?? 0,
    subClass: squash(input.subClass ?? current?.subClass ?? '').toUpperCase(),
    students: input.students ?? current?.students ?? 0,
    mode: input.mode ?? current?.mode ?? 'regular',
  };
  if (!v.programme) throw invalid('Give the programme.');
  if (!v.year || !v.semester || !v.students) throw invalid("Give the course's year, semester and number of students.");
  const clash = data.courses.find(
    (c) => c.id !== ignoreId && c.programme === v.programme && c.year === v.year && c.semester === v.semester && c.subClass === v.subClass,
  );
  if (clash) {
    const owner = clash.departmentId === ctx.department.id ? 'your department' : clash.departmentCode;
    throw new AppError(409, ErrorCode.TEACHING_TAKEN, `${courseLabel(clash)} is already entered by ${owner}.`);
  }
  return v;
}

function ownCourse(data: TermData, ctx: Ctx, courseId: string): CourseRow {
  const course = data.courses.find((c) => c.id === courseId);
  if (!course) throw AppError.notFound('No such course.');
  if (course.departmentId !== ctx.department.id) {
    throw AppError.forbidden(`${courseLabel(course)} is ${course.departmentCode}'s course; only they edit it.`);
  }
  return course;
}

export async function createCourseIn(client: PoolClient, ctx: Ctx, input: CourseInput): Promise<CourseDto> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  const v = courseValues(data, ctx, null, input, null);
  const id = await repo.insertCourse(client, ctx.term.id, ctx.department.id, v);
  return courseDto({ id, departmentId: ctx.department.id, departmentCode: ctx.department.code, ...v });
}

export async function updateCourseIn(client: PoolClient, ctx: Ctx, courseId: string, input: CourseInput): Promise<{ before: CourseDto; after: CourseDto }> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  const course = ownCourse(data, ctx, courseId);
  const v = courseValues(data, ctx, course, input, course.id);
  await repo.updateCourse(client, course.id, v);
  return { before: courseDto(course), after: courseDto({ ...course, ...v }) };
}

export async function createCourse(ctx: Ctx, input: CourseInput): Promise<CourseDto> {
  const course = await write(ctx, (client) => createCourseIn(client, ctx, input));
  await changed(ctx, 'course.create', course.id, null, course);
  return course;
}

export async function updateCourse(ctx: Ctx, courseId: string, input: CourseInput): Promise<CourseDto> {
  const { before, after } = await write(ctx, (client) => updateCourseIn(client, ctx, courseId, input));
  await changed(ctx, 'course.update', courseId, before, after);
  return after;
}

export async function deleteCourse(ctx: Ctx, courseId: string): Promise<void> {
  const before = await write(ctx, async (client) => {
    const data = await repo.loadTerm(ctx.term.id, [], client);
    const course = ownCourse(data, ctx, courseId);
    const using = data.units.filter((u) => u.courseIds.includes(course.id));
    if (using.length > 0) {
      const names = using.slice(0, 5).map((u) => (u.departmentId === ctx.department.id ? u.code : `${u.code} (${u.departmentCode})`));
      throw new AppError(409, ErrorCode.TEACHING_IN_USE, `${courseLabel(course)} takes ${names.join(', ')}. Remove it from those units first.`);
    }
    await repo.deleteCourse(client, course.id);
    return courseDto(course);
  });
  await changed(ctx, 'course.delete', courseId, before, null);
}

// -- units -----------------------------------------------------------------------------------------

export interface UnitInput {
  code?: string;
  title?: string;
  weeklyHours?: number;
  classLength?: number;
  roomType?: RoomType;
  courseIds?: string[];
}

function ownUnit(data: TermData, ctx: Ctx, unitId: string): UnitRow {
  const unit = data.units.find((u) => u.id === unitId);
  if (!unit || unit.departmentId !== ctx.department.id) throw AppError.notFound('No such unit in your department.');
  return unit;
}

function termCourseIds(data: TermData, ids: string[]): string[] {
  const wanted = [...new Set(ids)];
  const known = new Set(data.courses.map((c) => c.id));
  if (wanted.some((id) => !known.has(id))) throw invalid("A course chosen isn't in this term.");
  return wanted;
}

/** Checks everything first, so a refused change leaves the unit as it was. */
function unitValues(data: TermData, ctx: Ctx, current: UnitRow | null, input: UnitInput): repo.UnitValues {
  const code = squash(input.code ?? current?.code ?? '').toUpperCase();
  const title = squash(input.title ?? current?.title ?? '');
  const weeklyHours = input.weeklyHours ?? current?.weeklyHours ?? 0;
  const classLength = input.classLength ?? current?.classLength ?? 0;
  const roomType = input.roomType ?? current?.roomType ?? 'lecture_hall';
  if (!code || !title) throw invalid("Give the unit's code and title.");
  if (!weeklyHours || !classLength) throw invalid("Give the unit's hours per week and class length.");
  if (!(roomType in ROOM_TYPES)) throw invalid('Room type must be Lecture hall, Lab or Seminar room.');
  if (classLength > weeklyHours) throw invalid("A class can't be longer than the unit's hours per week.");
  const codeKey = compact(code);
  const clash = data.units.find((u) => u.codeKey === codeKey && u.id !== current?.id);
  if (clash) {
    const owner = clash.departmentId === ctx.department.id ? 'your department' : clash.departmentCode;
    throw new AppError(409, ErrorCode.TEACHING_TAKEN, `${clash.code} is already entered by ${owner}.`);
  }
  return { code, codeKey, title, weeklyHours, classLength, roomType };
}

/** A new unit is one whole class of all the courses taking it, until the department splits it. */
export async function createUnitIn(client: PoolClient, ctx: Ctx, input: UnitInput): Promise<{ id: string; code: string }> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  const courseIds = termCourseIds(data, input.courseIds ?? []);
  if (courseIds.length === 0) throw invalid('Choose the courses that take the unit.');
  const v = unitValues(data, ctx, null, input);
  const id = await repo.insertUnit(client, ctx.term.id, ctx.department.id, v, ctx.actor);
  await repo.setUnitCourses(client, id, courseIds);
  await repo.replaceGroups(client, id, [
    { label: '', lecturerId: null, lectureHours: null, practicalHours: null, cfHours: null, members: courseIds.map((courseId) => ({ courseId, students: null })) },
  ]);
  return { id, code: v.code };
}

export async function updateUnitIn(client: PoolClient, ctx: Ctx, unitId: string, input: UnitInput): Promise<{ before: unknown; after: unknown }> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  const unit = ownUnit(data, ctx, unitId);
  const courseIds = input.courseIds?.length ? termCourseIds(data, input.courseIds) : null;
  const v = unitValues(data, ctx, unit, input);
  await repo.updateUnit(client, unit.id, v, ctx.actor);
  if (courseIds) {
    await repo.setUnitCourses(client, unit.id, courseIds);
    const keep = new Set(courseIds);
    const whole = unit.groups.length === 1 && unit.groups[0]!.label === '' ? unit.groups[0]! : null;
    for (const g of unit.groups) {
      const members = g.members.filter((m) => keep.has(m.courseId));
      if (g === whole) {
        const have = new Set(members.map((m) => m.courseId));
        members.push(...courseIds.filter((id) => !have.has(id)).map((courseId) => ({ courseId, students: null })));
      }
      await repo.setMembers(client, g.id, members);
    }
  }
  const audit = (u: { code: string; title: string; weeklyHours: number; classLength: number; roomType: string }, courses: string[]) => ({
    code: u.code, title: u.title, weeklyHours: u.weeklyHours, classLength: u.classLength, roomType: u.roomType, courses: [...courses].sort(),
  });
  return { before: audit(unit, unit.courseIds), after: audit(v, courseIds ?? unit.courseIds) };
}

export async function createUnit(ctx: Ctx, input: UnitInput): Promise<{ id: string; code: string }> {
  const unit = await write(ctx, (client) => createUnitIn(client, ctx, input));
  await changed(ctx, 'unit.create', unit.id, null, input);
  return unit;
}

export async function updateUnit(ctx: Ctx, unitId: string, input: UnitInput): Promise<void> {
  const { before, after } = await write(ctx, (client) => updateUnitIn(client, ctx, unitId, input));
  await changed(ctx, 'unit.update', unitId, before, after);
}

export async function deleteUnit(ctx: Ctx, unitId: string): Promise<void> {
  const code = await write(ctx, async (client) => {
    const unit = ownUnit(await repo.loadTerm(ctx.term.id, [], client), ctx, unitId);
    await repo.deleteUnit(client, unit.id);
    return unit.code;
  });
  await changed(ctx, 'unit.delete', unitId, { code }, null);
}

// -- groups ----------------------------------------------------------------------------------------

export interface GroupInput {
  label?: string;
  members: Array<{ courseId: string; students?: number | null }>;
  /** Absent: a group kept by label keeps its lecturer. */
  lecturerId?: string | null;
  lectureHours?: number | null;
  practicalHours?: number | null;
  cfHours?: number | null;
}

async function lecturerFor(client: PoolClient, ctx: Ctx, lecturerId: string | null | undefined): Promise<string | null> {
  if (!lecturerId) return null;
  const lecturer = await repo.findLecturer(lecturerId, client);
  if (!lecturer) throw AppError.notFound('No such lecturer.');
  if (lecturer.departmentId !== ctx.department.id) throw AppError.forbidden("That lecturer is on another department's list.");
  if (!lecturer.active) throw invalid(`${lecturer.fullName} is marked inactive.`);
  return lecturer.id;
}

/**
 * The unit's classes, all at once: one whole class, or groups A, B, C...
 * Each group's courses must take the unit; a course split between groups
 * gives each group's share of its students. A group kept by label keeps its
 * lecturer and hours unless new ones are given.
 */
export async function setGroupsIn(client: PoolClient, ctx: Ctx, unitId: string, groups: GroupInput[]): Promise<{ before: unknown; after: unknown }> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  const unit = ownUnit(data, ctx, unitId);
  if (groups.length === 0) throw invalid('A unit needs at least one group.');
  const courses = new Map(data.courses.map((c) => [c.id, c]));
  const taking = new Set(unit.courseIds);
  const labels = groups.map((g) => groupLabel(g.label));
  if (new Set(labels).size !== labels.length) throw invalid('Each group needs its own name.');
  if (labels.length > 1 && labels.includes('')) throw invalid('When a unit is split, name every group (A, B, C...).');
  const existing = new Map(unit.groups.map((g) => [g.label, g]));
  // Every group is checked before anything is written, so a refused split leaves the unit as it was.
  const values: repo.GroupValues[] = [];
  for (const [i, g] of groups.entries()) {
    const label = labels[i]!;
    const name = `${unit.code} ${label}`.trim();
    const seen = new Set<string>();
    const members: MemberRow[] = [];
    for (const m of g.members) {
      const course = courses.get(m.courseId);
      if (!course || !taking.has(m.courseId)) throw invalid(`A course in ${name} doesn't take ${unit.code}.`);
      if (seen.has(m.courseId)) throw invalid(`${courseLabel(course)} is in ${name} twice.`);
      seen.add(m.courseId);
      const students = m.students ?? null;
      if (students !== null && !(students >= 1 && students <= course.students)) {
        throw invalid(`${name}: ${courseLabel(course)} has ${course.students} students.`);
      }
      members.push({ courseId: m.courseId, students });
    }
    if (members.length === 0) throw invalid(`Put at least one course in ${name}.`);
    const kept = existing.get(label);
    values.push({
      label,
      lecturerId: 'lecturerId' in g ? await lecturerFor(client, ctx, g.lecturerId) : (kept?.lecturerId ?? null),
      lectureHours: g.lectureHours !== undefined ? g.lectureHours : (kept?.lectureHours ?? null),
      practicalHours: g.practicalHours !== undefined ? g.practicalHours : (kept?.practicalHours ?? null),
      cfHours: g.cfHours !== undefined ? g.cfHours : (kept?.cfHours ?? null),
      members,
    });
  }
  await repo.replaceGroups(client, unit.id, values);
  await repo.touchUnit(client, unit.id, ctx.actor);
  return { before: unit.groups.map((g) => ({ label: g.label, lecturerId: g.lecturerId, members: g.members })), after: values };
}

export async function setGroups(ctx: Ctx, unitId: string, groups: GroupInput[]): Promise<{ id: string; groups: number }> {
  const { before, after } = await write(ctx, (client) => setGroupsIn(client, ctx, unitId, groups));
  await changed(ctx, 'unit.groups', unitId, before, after);
  return { id: unitId, groups: groups.length };
}

export interface GroupPatch {
  lecturerId?: string | null;
  lectureHours?: number | null;
  practicalHours?: number | null;
  cfHours?: number | null;
}

/** A group's lecturer and L/P/CF hours. */
export async function updateGroup(ctx: Ctx, groupId: string, patch: GroupPatch): Promise<void> {
  const { unitId, before, after } = await write(ctx, async (client) => {
    const data = await repo.loadTerm(ctx.term.id, [], client);
    const unit = data.units.find((u) => u.departmentId === ctx.department.id && u.groups.some((g) => g.id === groupId));
    const group = unit?.groups.find((g) => g.id === groupId);
    if (!unit || !group) throw AppError.notFound('No such group in your department.');
    const next = {
      lecturerId: 'lecturerId' in patch ? await lecturerFor(client, ctx, patch.lecturerId) : group.lecturerId,
      lectureHours: patch.lectureHours !== undefined ? patch.lectureHours : group.lectureHours,
      practicalHours: patch.practicalHours !== undefined ? patch.practicalHours : group.practicalHours,
      cfHours: patch.cfHours !== undefined ? patch.cfHours : group.cfHours,
    };
    await repo.updateGroup(client, group.id, next);
    await repo.touchUnit(client, unit.id, ctx.actor);
    const was = { label: group.label, lecturerId: group.lecturerId, lectureHours: group.lectureHours, practicalHours: group.practicalHours, cfHours: group.cfHours };
    return { unitId: unit.id, before: was, after: { label: group.label, ...next } };
  });
  await changed(ctx, 'group.update', unitId, before, after);
}

// -- publishing ------------------------------------------------------------------------------------

/** Sends the department's list to the Director; it stays locked until reopened. */
export async function publish(ctx: Ctx): Promise<BoardDto> {
  const counts = await write(ctx, async (client) => {
    const data = await repo.loadTerm(ctx.term.id, [], client);
    const courses = new Map(data.courses.map((c) => [c.id, c]));
    const own = data.units.filter((u) => u.departmentId === ctx.department.id);
    const found = problems(own, data.units, courses, data.lecturers);
    if (found.length > 0) {
      throw new AppError(409, ErrorCode.TEACHING_NOT_READY, `${found.length} things must be fixed before publishing: ${found[0]!.message}`, {
        details: { problems: found.slice(0, 50) },
      });
    }
    await repo.setPublishedSignatures(client, own.map((u) => ({ unitId: u.id, signature: signature(u, courses, data.lecturers) })));
    const groupCount = own.reduce((n, u) => n + u.groups.length, 0);
    await repo.insertPublication(client, {
      termId: ctx.term.id,
      departmentId: ctx.department.id,
      userId: ctx.userId,
      name: ctx.actor,
      unitCount: own.length,
      groupCount,
    });
    return { units: own.length, groups: groupCount };
  });
  await audit(ctx, AuditAction.TEACHING_PUBLISHED, counts);
  return board(ctx);
}

export async function reopen(ctx: Ctx): Promise<BoardDto> {
  await write(
    ctx,
    async (client) => {
      const latest = await repo.latestPublication(ctx.term.id, ctx.department.id, client);
      if (!latest || latest.reopenedAt) {
        throw new AppError(409, ErrorCode.TEACHING_NOT_PUBLISHED, "Your department's list hasn't been published.");
      }
      await repo.reopenPublication(client, latest.id, ctx.actor);
    },
    { whilePublished: true },
  );
  await audit(ctx, AuditAction.TEACHING_REOPENED, {});
  return board(ctx);
}

// -- lecturers -------------------------------------------------------------------------------------

export interface LecturerInput {
  title?: string;
  fullName?: string;
  staffNumber?: string | null;
  employmentType?: 'full_time' | 'part_time';
  phone?: string;
  email?: string;
  maxWeeklyHours?: number | null;
  maxExamDuties?: number | null;
  active?: boolean;
}

async function lecturerValues(client: PoolClient, ctx: Ctx, current: LecturerRow | null, input: LecturerInput): Promise<repo.LecturerValues> {
  const staff = input.staffNumber !== undefined ? (input.staffNumber ?? '').trim().toUpperCase() || null : (current?.staffNumber ?? null);
  const v: repo.LecturerValues = {
    title: (input.title ?? current?.title ?? '').trim(),
    fullName: squash(input.fullName ?? current?.fullName ?? ''),
    staffNumber: staff,
    employmentType: input.employmentType ?? current?.employmentType ?? 'full_time',
    phone: (input.phone ?? current?.phone ?? '').trim(),
    email: (input.email ?? current?.email ?? '').trim(),
    maxWeeklyHours: input.maxWeeklyHours !== undefined ? input.maxWeeklyHours || null : (current?.maxWeeklyHours ?? null),
    maxExamDuties: input.maxExamDuties !== undefined ? input.maxExamDuties || null : (current?.maxExamDuties ?? null),
    active: input.active ?? current?.active ?? true,
  };
  if (!v.fullName) throw invalid("Give the lecturer's name.");
  if (staff) {
    const clash = (await repo.listLecturers(ctx.department.id, client)).find((l) => l.staffNumber === staff && l.id !== current?.id);
    if (clash) throw new AppError(409, ErrorCode.TEACHING_TAKEN, `${staff} is already on the list as ${clash.fullName}.`);
  }
  return v;
}

async function ownLecturer(client: PoolClient, ctx: Ctx, lecturerId: string): Promise<LecturerRow> {
  const lecturer = await repo.findLecturer(lecturerId, client);
  if (!lecturer || lecturer.departmentId !== ctx.department.id) throw AppError.notFound('No such lecturer on your list.');
  return lecturer;
}

export async function listLecturers(userId: string): Promise<LecturerDto[]> {
  const own = await findOfficerDepartment(userId);
  if (!own) throw AppError.forbidden('Your account is not attached to a department.');
  return (await repo.listLecturers(own.departmentId)).map(lecturerDto);
}

export async function createLecturerIn(client: PoolClient, ctx: Ctx, input: LecturerInput): Promise<LecturerRow> {
  return repo.insertLecturer(client, ctx.department.id, await lecturerValues(client, ctx, null, input));
}

export async function updateLecturerIn(client: PoolClient, ctx: Ctx, lecturer: LecturerRow, input: LecturerInput): Promise<LecturerRow> {
  return repo.updateLecturer(client, lecturer.id, await lecturerValues(client, ctx, lecturer, input));
}

/** Lecturer lists aren't per term, and stay editable while a list is published (the Director imports a copy). */
export async function createLecturer(ctx: Ctx, input: LecturerInput): Promise<LecturerDto> {
  const lecturer = await write(ctx, (client) => createLecturerIn(client, ctx, input), { whilePublished: true });
  await changed(ctx, 'lecturer.create', lecturer.id, null, lecturerDto(lecturer));
  return lecturerDto(lecturer);
}

export async function updateLecturer(ctx: Ctx, lecturerId: string, input: LecturerInput): Promise<LecturerDto> {
  const { before, after } = await write(
    ctx,
    async (client) => {
      const lecturer = await ownLecturer(client, ctx, lecturerId);
      return { before: lecturer, after: await updateLecturerIn(client, ctx, lecturer, input) };
    },
    { whilePublished: true },
  );
  await changed(ctx, 'lecturer.update', lecturerId, lecturerDto(before), lecturerDto(after));
  return lecturerDto(after);
}

export async function deleteLecturer(ctx: Ctx, lecturerId: string): Promise<void> {
  const before = await write(
    ctx,
    async (client) => {
      const lecturer = await ownLecturer(client, ctx, lecturerId);
      const used = await repo.countLecturerGroups(lecturer.id, client);
      if (used > 0) {
        throw new AppError(409, ErrorCode.TEACHING_IN_USE, `${lecturer.fullName} teaches ${used} groups. Change those first, or mark them inactive.`);
      }
      await repo.deleteLecturer(client, lecturer.id);
      return lecturer;
    },
    { whilePublished: true },
  );
  await changed(ctx, 'lecturer.delete', lecturerId, lecturerDto(before), null);
}

/** Bulk writes share the department lock and the publish check. */
export { write as writeTeaching };

// -- what the Generator reads ----------------------------------------------------------------------

/**
 * For the Director's "Import published departments": every published
 * department with its courses, units and groups (lecturer by staff number),
 * the courses those units take (any department's), and the departments that
 * haven't published, with what changed in those that reopened.
 *
 * snake_case and this exact shape on purpose: it is what the Generator's
 * import (app/services/allocator_import.py) reads, unchanged from when the
 * Timetable Allocator served it.
 */
export async function submissions(termId: string): Promise<Record<string, unknown>> {
  const [data, latest, departments] = await Promise.all([repo.loadTerm(termId), repo.latestPublications(termId), repo.listDepartments()]);
  const courses = new Map(data.courses.map((c) => [c.id, c]));
  const byDepartment = new Map<string, UnitRow[]>();
  for (const u of data.units) byDepartment.set(u.departmentId, [...(byDepartment.get(u.departmentId) ?? []), u]);

  const published: Array<Record<string, unknown>> = [];
  const waiting: Array<Record<string, unknown>> = [];
  const needed = new Set<string>();
  for (const d of departments.filter((d) => compact(d.code))) {
    const code = compact(d.code);
    const p = latest.get(d.id);
    const own = byDepartment.get(d.id) ?? [];
    if (!p || p.reopenedAt) {
      waiting.push({
        code,
        name: d.name,
        reopened_at: p?.reopenedAt?.toISOString() ?? null,
        last_published_at: p?.publishedAt.toISOString() ?? null,
        changed_units: p ? own.filter((u) => u.publishedSignature !== signature(u, courses, data.lecturers)).map((u) => u.code).sort() : [],
      });
      continue;
    }
    for (const u of own) for (const id of u.courseIds) needed.add(id);
    for (const c of data.courses) if (c.departmentId === d.id) needed.add(c.id);
    published.push({
      code,
      name: d.name,
      published_at: p.publishedAt.toISOString(),
      published_by: p.publishedByName,
      units: own.map((u) => submittedUnit(u, courses, data.lecturers)),
    });
  }
  return {
    term_id: termId,
    courses: [...needed]
      .map((id) => courses.get(id))
      .filter((c): c is CourseRow => !!c)
      .sort((a, b) => courseLabel(a).localeCompare(courseLabel(b)))
      .map((c) => ({
        id: c.id,
        department_code: c.departmentCode,
        programme: c.programme,
        year: c.year,
        semester: c.semester,
        sub_class: c.subClass,
        label: courseLabel(c),
        students: c.students,
        mode: c.mode,
      })),
    published,
    not_published: waiting,
  };
}

function submittedUnit(u: UnitRow, courses: Map<string, CourseRow>, lecturers: Map<string, LecturerRow>): Record<string, unknown> {
  return {
    id: u.id,
    code: u.code,
    title: u.title,
    weekly_hours: u.weeklyHours,
    class_length: u.classLength,
    room_type: u.roomType,
    course_ids: [...u.courseIds].sort(),
    groups: u.groups.map((g) => {
      const l = g.lecturerId ? lecturers.get(g.lecturerId) : undefined;
      return {
        id: g.id,
        key: classKey(u.code, g.label),
        label: g.label,
        members: g.members.map((m) => ({ course_id: m.courseId, students: memberStudents(m, courses) })),
        students: groupStudents(g, courses),
        lecturer: l ? { staff_number: l.staffNumber, name: displayName(l), employment_type: l.employmentType } : null,
        lecture_hours: g.lectureHours,
        practical_hours: g.practicalHours,
        cf_hours: g.cfHours,
      };
    }),
  };
}

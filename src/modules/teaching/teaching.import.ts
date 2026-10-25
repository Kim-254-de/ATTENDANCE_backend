import type { PoolClient } from 'pg';
import { AppError } from '../../common/errors/index.js';
import { AuditAction } from '../../db/types.js';
import * as repo from './teaching.repository.js';
import { compact, type CourseMode, type CourseRow, type EmploymentType, type LecturerRow, type RoomType } from './teaching.repository.js';
import {
  audit,
  courseLabel,
  createCourseIn,
  createLecturerIn,
  createUnitIn,
  groupLabel,
  savepoint,
  setGroupsIn,
  updateCourseIn,
  updateLecturerIn,
  updateUnitIn,
  writeTeaching,
  type Ctx,
  type GroupInput,
  type LecturerInput,
  type UnitInput,
} from './teaching.service.js';
import * as examsRepo from './exams.repository.js';
import { createPaperIn, savePracticalIn, setNoWrittenExamIn, updatePaperIn, type PaperInput } from './exams.service.js';

/**
 * "Paste from Excel" for the department workbook's tabs:
 *
 *     Courses               Programme | Year | Semester | Sub-class | Students
 *                           (or one "Course" cell: "BSC.CS Y1S1 (A)")
 *     Units                 Code | Title | Hours per week | Class length | Room type | Courses
 *     Groups and lecturers  Unit code | Group | Courses | Students | Lecturer | Staff no. | L | P | CF
 *     Lecturers             Name | Title | FT/PT | Staff no. | Phone | Email | Max hours
 *
 * "Courses" cells list course labels separated by ";" (or "," or new lines),
 * and may name another department's courses (servicing). On the groups tab a
 * unit's rows together replace its groups; "Students" is blank for whole
 * courses, or one number per course listed ("60; 40"). A lecturer not on the
 * department's list yet is added to it. Every row is checked on its own and
 * reported by line; the good rows are kept.
 */

export interface BulkResult {
  created: number;
  updated: number;
  errors: Array<{ line: number; message: string }>;
  errorCount: number;
  message?: string;
}

type Row = Record<string, string>;

/** A pasted row keyed by its column heading in snake case ('Staff no.' -> 'staff_no'), blanks dropped. */
export function cleanRow(raw: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const v = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (v) out[k] = v;
  }
  return out;
}

class RowError extends Error {}
const fail = (message: string): never => {
  throw new RowError(message);
};
const message = (error: unknown): string => {
  if (error instanceof RowError || error instanceof AppError) return error.message;
  throw error;
};

function int(value: string | undefined, what: string, low: number, high: number): number {
  if (!value) return fail(`${what} is required`);
  const n = Math.trunc(Number(value.replace(/,/g, '')));
  if (!Number.isFinite(n)) return fail(`${what} '${value}' is not a whole number`);
  if (n < low || n > high) return fail(`${what} must be from ${low} to ${high}`);
  return n;
}

function hours(value: string | undefined, what: string): number | null {
  if (!value) return null;
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n)) return fail(`${what} '${value}' is not a number`);
  if (n < 0 || n > 500) return fail(`${what} must be from 0 to 500`);
  return n;
}

const list = (value: string | undefined): string[] => (value ?? '').split(/[;,\n]+/).map((p) => p.trim()).filter(Boolean);

const result = (created: number, updated: number, errors: BulkResult['errors'], extra: Partial<BulkResult> = {}): BulkResult => ({
  created,
  updated,
  errors: errors.slice(0, 200),
  errorCount: errors.length,
  ...extra,
});

async function finish(ctx: Ctx, what: string, r: BulkResult): Promise<BulkResult> {
  if (r.created || r.updated) await audit(ctx, AuditAction.TEACHING_CHANGED, { what, created: r.created, updated: r.updated, errors: r.errorCount });
  return r;
}

// -- courses ---------------------------------------------------------------------------------------

const MODE_WORDS: Record<string, CourseMode> = {
  regular: 'regular',
  fulltime: 'regular',
  odel: 'odel',
  odl: 'odel',
  distance: 'odel',
  weekend: 'weekend',
  evening: 'evening',
  schoolbased: 'school_based',
  parttime: 'part_time',
};

/** 'ODEL', 'School-based', blank (regular)... */
function mode(value: string | undefined): CourseMode {
  const word = (value ?? 'regular').toLowerCase().replace(/[^a-z]/g, '');
  return MODE_WORDS[word] ?? fail(`mode '${value}' must be Regular, ODEL, Weekend, Evening, School-based or Part-time`);
}

const LABEL = /^(?<programme>.+?)\s+Y(?<year>\d)\s*S(?<semester>\d)(?:\s*\((?<sub>[^)]*)\))?\s*$/i;

export async function bulkCourses(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(ctx, async (client) => {
    let created = 0;
    let updated = 0;
    const errors: BulkResult['errors'] = [];
    const seen = new Map<string, number>();
    for (const [i, raw] of rows.entries()) {
      const line = i + 1;
      const row = cleanRow(raw);
      try {
        const label = row['course'] ?? row['class'];
        const match = label && !row['programme'] ? LABEL.exec(label) : null;
        if (label && !row['programme'] && !match) fail(`'${label}' should look like 'BSC.CS Y1S1' or 'BSC.CS Y1S1 (A)'`);
        const g = match?.groups;
        const fields = {
          programme: (g ? g['programme']! : (row['programme'] ?? '')).split(/\s+/).filter(Boolean).join(' ').toUpperCase(),
          year: int(g ? g['year'] : row['year'], 'Year', 1, 7),
          semester: int(g ? g['semester'] : row['semester'], 'Semester', 1, 3),
          subClass: (g ? (g['sub'] ?? '') : (row['sub_class'] ?? row['subclass'] ?? '')).trim().toUpperCase().slice(0, 10),
          students: int(row['students'], 'Students', 1, 5000),
          mode: mode(row['mode']),
        };
        if (!fields.programme) fail('Programme is required');
        const cohort = `${fields.programme}|${fields.year}|${fields.semester}|${fields.subClass}`;
        if (seen.has(cohort)) fail(`this course is also on row ${seen.get(cohort)}`);
        seen.set(cohort, line);
        await savepoint(client, async () => {
          const data = await repo.loadTerm(ctx.term.id, [], client);
          const existing = data.courses.find(
            (c) => c.programme === fields.programme && c.year === fields.year && c.semester === fields.semester && c.subClass === fields.subClass,
          );
          if (existing && existing.departmentId === ctx.department.id) {
            await updateCourseIn(client, ctx, existing.id, { students: fields.students, mode: fields.mode });
            updated++;
          } else {
            await createCourseIn(client, ctx, fields);
            created++;
          }
        });
      } catch (error) {
        errors.push({ line, message: message(error) });
      }
    }
    return result(created, updated, errors);
  });
  return finish(ctx, 'courses.bulk', r);
}

// -- units -----------------------------------------------------------------------------------------

const ROOM_TYPE_WORDS: Record<string, RoomType> = {
  'lecture hall': 'lecture_hall',
  hall: 'lecture_hall',
  lecture: 'lecture_hall',
  lab: 'lab',
  laboratory: 'lab',
  'computer lab': 'lab',
  'science lab': 'lab',
  seminar: 'seminar',
  'seminar room': 'seminar',
};

function courseIds(labels: string[], byLabel: Map<string, CourseRow>): string[] {
  return labels.map((label) => byLabel.get(compact(label))?.id ?? fail(`no course '${label}' this term; add it on the Courses tab first`));
}

async function coursesByLabel(client: PoolClient, ctx: Ctx): Promise<Map<string, CourseRow>> {
  const data = await repo.loadTerm(ctx.term.id, [], client);
  return new Map(data.courses.map((c) => [compact(courseLabel(c)), c]));
}

export async function bulkUnits(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(ctx, async (client) => {
    let created = 0;
    let updated = 0;
    const errors: BulkResult['errors'] = [];
    const byLabel = await coursesByLabel(client, ctx);
    const seen = new Map<string, number>();
    for (const [i, raw] of rows.entries()) {
      const line = i + 1;
      const row = cleanRow(raw);
      try {
        const code = row['code'] ?? row['unit_code'] ?? row['course_code'] ?? fail('Code is required');
        if (seen.has(compact(code))) fail(`${code} is also on row ${seen.get(compact(code))}`);
        seen.set(compact(code), line);
        const roomWord = (row['room_type'] ?? 'lecture hall').trim().toLowerCase().replace(/_/g, ' ');
        const roomType = ROOM_TYPE_WORDS[roomWord] ?? fail(`room type '${row['room_type']}' must be Lecture hall, Lab or Seminar room`);
        const weekly = int(row['hours_per_week'] ?? row['weekly_hours'] ?? row['hours'], 'Hours per week', 1, 20);
        const fields: UnitInput = {
          code,
          title: row['title'] ?? row['unit_title'] ?? row['course_title'],
          weeklyHours: weekly,
          classLength: int(row['class_length'] ?? row['session_length'] ?? String(Math.min(weekly, 3)), 'Class length', 1, 6),
          roomType,
        };
        const labels = list(row['courses'] ?? row['classes']);
        if (labels.length) fields.courseIds = courseIds(labels, byLabel);
        await savepoint(client, async () => {
          const data = await repo.loadTerm(ctx.term.id, [], client);
          const existing = data.units.find((u) => u.codeKey === compact(code));
          if (existing && existing.departmentId === ctx.department.id) {
            await updateUnitIn(client, ctx, existing.id, fields);
            updated++;
          } else {
            if (!fields.title) fail('Title is required');
            if (!labels.length) fail('list the courses that take the unit');
            await createUnitIn(client, ctx, fields);
            created++;
          }
        });
      } catch (error) {
        errors.push({ line, message: message(error) });
      }
    }
    return result(created, updated, errors);
  });
  return finish(ctx, 'units.bulk', r);
}

// -- groups and lecturers --------------------------------------------------------------------------

const KIND = /\((FT|PT)\)\s*$/i;
const TITLE = /^(DR|PROF|MR|MRS|MS|MISS|ENG|REV)\.?\s+/i;

/** 'Dr. Joseph Omollo (PT)' -> ['Dr.', 'Joseph Omollo', 'part_time'], as the Word form writes lecturers. */
export function splitName(raw: string): [string, string, EmploymentType] {
  let text = raw.trim();
  let kind: EmploymentType = 'full_time';
  const k = KIND.exec(text);
  if (k) {
    kind = k[1]!.toUpperCase() === 'PT' ? 'part_time' : 'full_time';
    text = text.slice(0, k.index).trim();
  }
  let title = '';
  const t = TITLE.exec(text);
  if (t) {
    title = `${t[1]![0]!.toUpperCase()}${t[1]!.slice(1).toLowerCase()}.`;
    text = text.slice(t[0].length).trim();
  }
  return [title, text, kind];
}

/** "James Ng'ang'a" and 'james  nganga' are one name: letters only, any case. */
const sameName = (a: string, b: string): boolean => a.toLowerCase().replace(/[^a-z]/g, '') === b.toLowerCase().replace(/[^a-z]/g, '');

async function findLecturer(client: PoolClient, ctx: Ctx, staffNumber: string | null, name: string): Promise<LecturerRow | null> {
  const lecturers = await repo.listLecturers(ctx.department.id, client);
  if (staffNumber) {
    const found = lecturers.find((l) => l.staffNumber === staffNumber.trim().toUpperCase());
    if (found) return found;
  }
  // Same name but another staff number: a different person who shares the name.
  return lecturers.find((l) => sameName(l.fullName, name) && !(staffNumber && l.staffNumber)) ?? null;
}

export async function bulkGroups(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(ctx, async (client) => {
    const errors: BulkResult['errors'] = [];
    // A unit's rows, gathered first: together they replace its groups.
    const byUnit = new Map<string, Array<[number, Row]>>();
    for (const [i, raw] of rows.entries()) {
      const row = cleanRow(raw);
      const code = row['unit_code'] ?? row['code'] ?? row['course_code'];
      if (!code) {
        errors.push({ line: i + 1, message: 'Unit code is required' });
        continue;
      }
      byUnit.set(compact(code), [...(byUnit.get(compact(code)) ?? []), [i + 1, row]]);
    }
    let units = 0;
    let groups = 0;
    let lecturersAdded = 0;
    for (const [key, unitRows] of byUnit) {
      const firstLine = unitRows[0]![0];
      const data = await repo.loadTerm(ctx.term.id, [], client);
      const unit = data.units.find((u) => u.codeKey === key);
      if (!unit || unit.departmentId !== ctx.department.id) {
        const code = unitRows[0]![1]['unit_code'] ?? unitRows[0]![1]['code'] ?? key;
        const why = unit ? `${code} is ${unit.departmentCode}'s unit` : `no unit ${code}; add it on the Units tab`;
        errors.push(...unitRows.map(([line]) => ({ line, message: why })));
        continue;
      }
      const byLabel = new Map(data.courses.map((c) => [compact(courseLabel(c)), c]));
      try {
        await savepoint(client, async () => {
          const set: GroupInput[] = [];
          let added = 0;
          for (const [line, row] of unitRows) {
            try {
              const labels = list(row['courses'] ?? row['classes']);
              // No courses listed: the whole class.
              const ids = labels.length ? courseIds(labels, byLabel) : unit.courseIds;
              const counts = list(row['students']);
              if (counts.length && counts.length !== ids.length) fail('give one student number per course listed, or leave Students blank');
              const group: GroupInput = {
                label: groupLabel(row['group']),
                members: ids.map((courseId, n) => ({ courseId, students: counts.length ? int(counts[n], 'Students', 1, 5000) : null })),
                lectureHours: hours(row['l'] ?? row['lecture_hours'], 'L'),
                practicalHours: hours(row['p'] ?? row['practical_hours'], 'P'),
                cfHours: hours(row['cf'] ?? row['cf_hours'], 'CF'),
              };
              const staff = row['staff_no'] ?? row['staff_number'];
              const nameCell = row['lecturer'];
              if (staff || nameCell) {
                const [title, name, kind] = splitName(nameCell ?? '');
                let lecturer = await findLecturer(client, ctx, staff ?? null, name);
                if (!lecturer) {
                  if (!name) fail(`no lecturer with staff number ${staff} on the Lecturers tab`);
                  lecturer = await createLecturerIn(client, ctx, { title, fullName: name, staffNumber: staff ?? null, employmentType: kind });
                  added++;
                }
                group.lecturerId = lecturer.id;
              }
              set.push(group);
            } catch (error) {
              throw new RowError(`row ${line}: ${message(error)}`);
            }
          }
          await setGroupsIn(client, ctx, unit.id, set);
          units++;
          groups += set.length;
          lecturersAdded += added;
        });
      } catch (error) {
        errors.push({ line: firstLine, message: `${unit.code}: ${message(error)}` });
      }
    }
    const extra = lecturersAdded ? `; ${lecturersAdded} lecturers added to your list` : '';
    return result(groups, 0, errors, { message: `Groups set for ${units} units (${groups} groups)${extra}.` });
  });
  return finish(ctx, 'groups.bulk', r);
}

/** The Lecturers tab of the workbook. Lecturer lists stay editable while a list is published. */
export async function bulkLecturers(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(
    ctx,
    async (client) => {
      let created = 0;
      let updated = 0;
      const errors: BulkResult['errors'] = [];
      // Each lecturer once per file: a repeat is a mistake (two people given one
      // staff number), never a reason to overwrite the earlier row.
      const staffRows = new Map<string, [number, string]>();
      const lecturerRows = new Map<string, number>();
      for (const [i, raw] of rows.entries()) {
        const line = i + 1;
        const row = cleanRow(raw);
        try {
          const nameCell = row['full_name'] ?? row['name'] ?? row['lecturer'] ?? fail('name is required');
          const [title, name, parsedKind] = splitName(nameCell);
          const kindCell = (row['employment'] ?? row['ft_pt'] ?? '').toUpperCase();
          const kind: EmploymentType = kindCell ? (kindCell.startsWith('P') ? 'part_time' : 'full_time') : parsedKind;
          const staff = (row['staff_number'] ?? row['staff_no'] ?? '').trim().toUpperCase();
          const max = row['max_hours'] ?? row['max_weekly_hours'];
          const fields: LecturerInput = {
            title: row['title'] ?? title,
            fullName: name,
            staffNumber: staff || null,
            employmentType: kind,
            phone: row['phone'] ?? row['phone_no'] ?? '',
            email: row['email'] ?? '',
            ...(max ? { maxWeeklyHours: Math.trunc(Number(max)) || null } : {}),
          };
          if (staff && staffRows.has(staff)) {
            const [earlier, earlierName] = staffRows.get(staff)!;
            fail(`staff number ${staff} is also on row ${earlier} (${earlierName}); each lecturer needs their own staff number`);
          }
          const existing = await findLecturer(client, ctx, staff || null, name);
          if (existing && lecturerRows.has(existing.id)) fail(`${name} is also on row ${lecturerRows.get(existing.id)}`);
          if (existing && staff && !sameName(existing.fullName, name)) {
            fail(`staff number ${staff} is already on the list as ${existing.fullName}; check the staff number, or change the name on their own record`);
          }
          if (staff) staffRows.set(staff, [line, nameCell]);
          await savepoint(client, async () => {
            if (existing) {
              lecturerRows.set(existing.id, line);
              const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== '')) as LecturerInput;
              await updateLecturerIn(client, ctx, existing, given);
              updated++;
            } else {
              lecturerRows.set((await createLecturerIn(client, ctx, fields)).id, line);
              created++;
            }
          });
        } catch (error) {
          errors.push({ line, message: message(error) });
        }
      }
      return result(created, updated, errors);
    },
    { whilePublished: true },
  );
  return finish(ctx, 'lecturers.bulk', r);
}

// -- exam papers and practicals --------------------------------------------------------------------
//
//     Exam papers   Codes | Title | Written exam | Examiner | Staff no. | Notes
//     Practicals    Unit code | Date | Start | End
//
// "Codes" holds one code, or several for a shared paper ("BITE 131/COSC 130").
// "Written exam" No marks the units as having no written exam. A paper is
// matched to an existing one by its first code, and updated.

export async function bulkPapers(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(
    ctx,
    async (client) => {
      let created = 0;
      let updated = 0;
      let marked = 0;
      const errors: BulkResult['errors'] = [];
      const seen = new Map<string, number>();
      for (const [i, raw] of rows.entries()) {
        const line = i + 1;
        const row = cleanRow(raw);
        try {
          const cell = row['codes'] ?? row['unit_codes'] ?? row['unit_code'] ?? row['code'] ?? fail('Codes is required');
          const data = await repo.loadTerm(ctx.term.id, [], client);
          const units = new Map(data.units.map((u) => [u.codeKey, u]));
          const codes = cell.split(/[/;,]+/).map((c) => c.trim()).filter(Boolean);
          const found = codes.map((code) => {
            const key = compact(code);
            if (seen.has(key)) fail(`${code} is also on row ${seen.get(key)}`);
            return units.get(key) ?? fail(`no unit ${code} this term`);
          });
          for (const code of codes) seen.set(compact(code), line);
          await savepoint(client, async () => {
            if (['no', 'n', 'false', '0'].includes((row['written_exam'] ?? 'yes').trim().toLowerCase())) {
              for (const u of found) await setNoWrittenExamIn(client, ctx, u.id, true);
              marked += found.length;
              return;
            }
            const fields: PaperInput = { unitIds: found.map((u) => u.id) };
            if (row['title']) fields.title = row['title'];
            if (row['notes']) fields.notes = row['notes'];
            const staff = row['staff_no'] ?? row['staff_number'];
            if (staff || row['examiner']) {
              const [, name] = splitName(row['examiner'] ?? '');
              const lecturer = await findLecturer(client, ctx, staff ?? null, name);
              if (!lecturer) fail(`no lecturer ${row['examiner'] ?? staff} on your list; add them on Lecturers`);
              fields.examinerId = lecturer!.id;
            }
            const existing = (await examsRepo.loadExams(ctx.term.id, client)).papers.find((p) => p.unitIds.includes(found[0]!.id));
            if (existing) {
              await updatePaperIn(client, ctx, existing.id, fields);
              updated++;
            } else {
              await createPaperIn(client, ctx, fields);
              created++;
            }
          });
        } catch (error) {
          errors.push({ line, message: message(error) });
        }
      }
      const extra = marked ? `; ${marked} units marked 'no written exam'` : '';
      return result(created, updated, errors, { message: `${created} papers added, ${updated} updated${extra}.` });
    },
    { kind: 'exams' },
  );
  return finish(ctx, 'exam_papers.bulk', r);
}

/** '2026-11-20', '20/11/2026', '20-11-2026', '20.11.2026' -> '2026-11-20'. */
function day(value: string | undefined): string {
  const text = (value ?? '').trim().slice(0, 10);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  const date = y ? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d)) return fail(`date '${value}' should look like 2026-11-20 or 20/11/2026`);
  return date.toISOString().slice(0, 10);
}

/** '08:30', '8.30', '2:30pm', '2pm' -> 'HH:MM'. */
function clock(value: string | undefined, what: string): string {
  const text = (value ?? '').trim().toLowerCase().replace('.', ':').replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm)?$/.exec(text);
  let h = m ? Number(m[1]) : NaN;
  const min = m?.[2] ? Number(m[2]) : 0;
  if (m?.[3] === 'pm' && h < 12) h += 12;
  if (m?.[3] === 'am' && h === 12) h = 0;
  if (!m || h > 23 || min > 59 || (!m[2] && !m[3])) return fail(`${what} '${value}' should look like 08:30 or 2:30pm`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export async function bulkPracticals(ctx: Ctx, rows: Array<Record<string, unknown>>): Promise<BulkResult> {
  const r = await writeTeaching(
    ctx,
    async (client) => {
      let created = 0;
      const errors: BulkResult['errors'] = [];
      const units = new Map((await repo.loadTerm(ctx.term.id, [], client)).units.map((u) => [u.codeKey, u]));
      for (const [i, raw] of rows.entries()) {
        const row = cleanRow(raw);
        try {
          const code = row['unit_code'] ?? row['code'] ?? row['unit'];
          const unit = code ? units.get(compact(code)) : undefined;
          if (!unit) fail(`no unit ${code ?? ''} this term`.trim());
          const input = {
            unitId: unit!.id,
            date: day(row['date']),
            startTime: clock(row['start'] ?? row['start_time'], 'Start'),
            endTime: clock(row['end'] ?? row['end_time'], 'End'),
          };
          await savepoint(client, () => savePracticalIn(client, ctx, null, input));
          created++;
        } catch (error) {
          errors.push({ line: i + 1, message: message(error) });
        }
      }
      return result(created, 0, errors);
    },
    { kind: 'exams' },
  );
  return finish(ctx, 'practicals.bulk', r);
}

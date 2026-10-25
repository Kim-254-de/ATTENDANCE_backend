import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A department's teaching against a real Postgres database, with the
 * Timetable Generator stubbed at `fetch`: officers enter courses, units,
 * groups and lecturers for one of the Generator's terms, publish them, and
 * the Generator reads what was published from the integration endpoint in the
 * shape its import expects.
 */
const TEST_DB = 'attendance_department_teaching_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const GENERATOR = 'https://generator.test.local';
process.env.GENERATOR_BASE_URL = GENERATOR;
process.env.GENERATOR_API_KEY = 'generator-key';

const TERM = 'term-2026-1';
const generator = {
  terms: [{ id: TERM, academic_year: '2026/2027', semester: 1, name: 'September - December 2026', published_version: null as number | null }],
  times: { published_version: null as number | null, classes: {} as Record<string, unknown[]> },
};

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(GENERATOR)) return realFetch(input, init);
  const headers = new Headers(init?.headers);
  if (headers.get('X-API-Key') !== 'generator-key') return new Response('{}', { status: 401 });
  const path = url.slice(GENERATOR.length);
  const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (path === '/api/integrations/attendance/terms') return json(generator.terms);
  if (path === `/api/integrations/attendance/terms/${TERM}/times`) return json(generator.times);
  return new Response('{}', { status: 404 });
});

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string; details?: unknown } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

async function makeOfficer(fullName: string, departmentId: string) {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'DEPARTMENT', 'ACTIVE', NOW()) RETURNING id`,
    [`officer${n}@uni.ac.ke`, fullName]);
  await pool.query(`INSERT INTO department_profiles (user_id, department_id, title) VALUES ($1, $2, 'Dr.')`, [u!.id, departmentId]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'DEPARTMENT' })}`;
}

async function makeDepartment(name: string, code: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [name, code]);
  return d!.id;
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1/departments/teaching${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data),
  patch: (path: string, data?: object) => request(app).patch(`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data),
  put: (path: string, data?: object) => request(app).put(`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data),
  delete: (path: string) => request(app).delete(`/api/v1/departments/teaching${path}`).set('Authorization', auth),
});

interface BoardBody {
  canEdit: boolean;
  published: boolean;
  courses: Array<{ id: string; label: string; usedBy: string[] }>;
  otherCourses: Array<{ id: string; label: string }>;
  units: Array<{ id: string; code: string; servicing: boolean; changedSincePublished: boolean; groups: Array<{ id: string; key: string; label: string; students: number; lecturer: string | null; meetings: unknown[] }> }>;
  lecturers: Array<{ id: string; fullName: string; weeklyHours: number }>;
  problems: Array<{ code: string; message: string }>;
}

let cs: ReturnType<typeof api>;
let edu: ReturnType<typeof api>;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  const csId = await makeDepartment('Computer Science', 'DCOMP');
  const eduId = await makeDepartment('Education', 'DEDU');
  cs = api(await makeOfficer('Dee Officer', csId));
  edu = api(await makeOfficer('Ed Officer', eduId));
}, 60_000);

beforeEach(async () => {
  (await import('../../src/modules/teaching/teaching.service.js')).clearTermsCache();
});

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

describe('a department enters, publishes and the Generator reads it', () => {
  let y1: string;
  let y2: string;
  let unitId: string;
  let peter: string;
  let jane: string;

  it('opens the Generator\'s newest term, empty', async () => {
    const res = await cs.get('');
    expect(res.status).toBe(200);
    const b = body<BoardBody & { term: { id: string } }>(res).data;
    expect(b.term.id).toBe(TERM);
    expect(b.canEdit).toBe(true);
    expect(b.problems.map((p) => p.code)).toEqual(['no_units']);
  });

  it('enters courses, and refuses a cohort twice', async () => {
    const a = await cs.post('/courses', { programme: 'bsc.comp  sci', year: 1, semester: 1, students: 100 });
    expect(a.status).toBe(201);
    expect(body<{ label: string }>(a).data.label).toBe('BSC.COMP SCI Y1S1');
    y1 = body<{ id: string }>(a).data.id;
    y2 = body<{ id: string }>(await cs.post('/courses', { programme: 'BSC.COMP SCI', year: 2, semester: 1, students: 60 })).data.id;

    const again = await edu.post('/courses', { programme: 'BSC.COMP SCI', year: 1, semester: 1, students: 5 });
    expect(again.status).toBe(409);
    expect(body(again).error!.message).toContain('DCOMP');
  });

  it('keeps its own lecturer list', async () => {
    peter = body<{ id: string }>(await cs.post('/lecturers', { title: 'Dr.', fullName: 'Peter Kamami', staffNumber: 'stf/0001' })).data.id;
    jane = body<{ id: string }>(await cs.post('/lecturers', { fullName: 'Jane Otieno', staffNumber: 'STF/0002', employmentType: 'part_time' })).data.id;
    const dup = await cs.post('/lecturers', { fullName: 'Someone Else', staffNumber: 'STF/0001' });
    expect(dup.status).toBe(409);
    const list = body<Array<{ display: string }>>(await cs.get('/lecturers')).data;
    expect(list.map((l) => l.display)).toEqual(['Jane Otieno (PT)', 'Dr. Peter Kamami (FT)']);
  });

  it('adds a unit as one whole class of the courses taking it', async () => {
    const res = await cs.post('/units', { code: 'cosc 103', title: 'Computer Applications', weeklyHours: 3, classLength: 2, courseIds: [y1, y2] });
    expect(res.status).toBe(201);
    unitId = body<{ id: string }>(res).data.id;
    const b = body<BoardBody>(await cs.get('')).data;
    expect(b.units[0]!.code).toBe('COSC 103');
    expect(b.units[0]!.groups.map((g) => [g.key, g.students])).toEqual([['COSC103-MAIN', 160]]);
    expect(b.problems.map((p) => p.code)).toEqual(['no_lecturer']);

    const taken = await edu.post('/units', { code: 'COSC103', title: 'X', weeklyHours: 3, classLength: 1, courseIds: [y1] });
    expect(taken.status).toBe(409);
  });

  it('splits it into groups, checking each course\'s students add up', async () => {
    const bad = await cs.put(`/units/${unitId}/groups`, {
      groups: [
        { label: 'a', members: [{ courseId: y1, students: 50 }], lecturerId: peter },
        { label: 'B', members: [{ courseId: y1, students: 40 }, { courseId: y2 }], lecturerId: jane },
      ],
    });
    expect(bad.status).toBe(200);
    let b = body<BoardBody>(await cs.get('')).data;
    expect(b.units[0]!.groups.map((g) => [g.label, g.students, g.lecturer])).toEqual([
      ['GR A', 50, 'Dr. Peter Kamami (FT)'],
      ['GR B', 100, 'Jane Otieno (PT)'],
    ]);
    expect(b.problems.map((p) => p.code)).toEqual(['split_total']);

    const fixed = await cs.put(`/units/${unitId}/groups`, {
      groups: [
        { label: 'GR A', members: [{ courseId: y1, students: 60 }] },
        { label: 'GR B', members: [{ courseId: y1, students: 40 }, { courseId: y2 }] },
      ],
    });
    expect(fixed.status).toBe(200);
    b = body<BoardBody>(await cs.get('')).data;
    // Kept by label: the lecturers stay.
    expect(b.units[0]!.groups.map((g) => g.lecturer)).toEqual(['Dr. Peter Kamami (FT)', 'Jane Otieno (PT)']);
    expect(b.problems).toEqual([]);
  });

  it('counts a lecturer\'s hours across departments', async () => {
    // Education services Computer Science's first years with Peter: the same staff number on its
    // own list, where it caps him at 4 hours. With Computer Science's 3 that is 5.
    await edu.post('/lecturers', { fullName: 'Peter Kamami', staffNumber: 'STF/0001', maxWeeklyHours: 4 });
    const eduPeter = body<Array<{ id: string }>>(await edu.get('/lecturers')).data[0]!.id;
    const unit = await edu.post('/units', { code: 'EDF 101', title: 'Foundations', weeklyHours: 2, classLength: 2, courseIds: [y1] });
    const eduUnit = body<{ id: string }>(unit).data.id;
    await edu.put(`/units/${eduUnit}/groups`, { groups: [{ label: '', members: [{ courseId: y1 }], lecturerId: eduPeter }] });
    const b = body<BoardBody>(await edu.get('')).data;
    expect(b.units[0]!.servicing).toBe(true);
    expect(b.problems.map((p) => p.code)).toEqual(['over_hours']);
    expect(b.problems[0]!.message).toContain('5 hours a week');
  });

  it('publishes only when nothing is missing, then locks the list', async () => {
    const notReady = await edu.post('/publish');
    expect(notReady.status).toBe(409);
    expect(body(notReady).error!.code).toBe('TEACHING_NOT_READY');

    const res = await cs.post('/publish');
    expect(res.status).toBe(200);
    expect(body<BoardBody>(res).data.published).toBe(true);
    const locked = await cs.post('/courses', { programme: 'BSC.IT', year: 1, semester: 1, students: 30 });
    expect(locked.status).toBe(409);
    expect(body(locked).error!.code).toBe('TEACHING_PUBLISHED');
    // The lecturer list isn't per term, and stays editable.
    expect((await cs.patch(`/lecturers/${jane}`, { phone: '0700 000 000' })).status).toBe(200);
  });

  it('serves the Generator what was published, behind its key', async () => {
    const url = `/api/v1/integrations/generator/terms/${TERM}/submissions`;
    expect((await request(app).get(url)).status).toBe(401);
    const res = await request(app).get(url).set('X-API-Key', 'generator-key');
    expect(res.status).toBe(200);
    const data = body<{
      courses: Array<{ id: string; department_code: string; label: string; students: number }>;
      published: Array<{ code: string; units: Array<{ code: string; course_ids: string[]; groups: Array<{ key: string; members: unknown[]; lecturer: { staff_number: string; name: string } | null }> }> }>;
      not_published: Array<{ code: string }>;
    }>(res).data;
    expect(data.published.map((d) => d.code)).toEqual(['DCOMP']);
    expect(data.not_published.map((d) => d.code)).toEqual(['DEDU']);
    const unit = data.published[0]!.units[0]!;
    expect(unit.course_ids.sort()).toEqual([y1, y2].sort());
    expect(unit.groups.map((g) => [g.key, g.lecturer?.staff_number])).toEqual([['COSC103-GRA', 'STF/0001'], ['COSC103-GRB', 'STF/0002']]);
    expect(unit.groups[1]!.members).toEqual(expect.arrayContaining([{ course_id: y1, students: 40 }, { course_id: y2, students: 60 }]));
    expect(data.courses.map((c) => [c.label, c.department_code])).toEqual([['BSC.COMP SCI Y1S1', 'DCOMP'], ['BSC.COMP SCI Y2S1', 'DCOMP']]);
  });

  it('shows each class\'s day, time and room once the Director publishes', async () => {
    generator.terms[0]!.published_version = 1;
    generator.times = { published_version: 1, classes: { 'COSC103-GRA': [{ day_of_week: 'TUE', start_time: '10:00', end_time: '12:00', room: 'STB 1' }] } };
    const b = body<BoardBody>(await cs.get(`?term=${TERM}`)).data;
    expect(b.units[0]!.groups[0]!.meetings).toEqual([{ dayOfWeek: 'TUE', startTime: '10:00', endTime: '12:00', room: 'STB 1' }]);
    expect(b.units[0]!.groups[1]!.meetings).toEqual([]);
  });

  it('downloads the allocation form as PDF, Word and Excel', async () => {
    for (const [format, type, magic] of [['pdf', 'application/pdf', '%PDF'], ['docx', 'wordprocessingml', 'PK'], ['xlsx', 'spreadsheetml', 'PK']] as const) {
      const res = await cs.get(`/export/${format}`).buffer(true).parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(type);
      expect(res.headers['content-disposition']).toContain(`allocation-DCOMP-September-December-2026.${format}`);
      expect((res.body as Buffer).subarray(0, magic.length).toString()).toBe(magic);
    }
  });

  it('reopens, and marks a unit changed after publishing', async () => {
    expect((await cs.post('/reopen')).status).toBe(200);
    const group = body<BoardBody>(await cs.get('')).data.units[0]!.groups[0]!;
    expect((await cs.patch(`/groups/${group.id}`, { lectureHours: 30 })).status).toBe(200);
    const b = body<BoardBody>(await cs.get('')).data;
    expect(b.units[0]!.changedSincePublished).toBe(true);
    const sub = body<{ not_published: Array<{ code: string; changed_units: string[] }> }>(
      await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/submissions`).set('X-API-Key', 'generator-key'),
    ).data;
    expect(sub.not_published.find((d) => d.code === 'DCOMP')!.changed_units).toEqual(['COSC 103']);
  });

  it('refuses to delete what is still in use', async () => {
    expect(body((await cs.delete(`/courses/${y1}`))).error!.code).toBe('TEACHING_IN_USE');
    expect(body((await cs.delete(`/lecturers/${peter}`))).error!.code).toBe('TEACHING_IN_USE');
    // Another department's course is read-only here.
    expect((await edu.patch(`/courses/${y1}`, { students: 1 })).status).toBe(403);
  });
});

describe('paste from Excel', () => {
  let ict: ReturnType<typeof api>;

  beforeAll(async () => {
    ict = api(await makeOfficer('Ivy Officer', await makeDepartment('Information Technology', 'DIT')));
  });

  it('keeps the good rows and reports the rest by line', async () => {
    const courses = await ict.post('/courses/bulk', {
      rows: [
        { Course: 'BSC.IT Y1S1', Students: 80 },
        { Programme: 'BSC.IT', Year: 2, Semester: 1, Students: '45' },
        { Course: 'nonsense', Students: 3 },
        { Course: 'BSC.IT Y1S1', Students: 81 },
      ],
    });
    expect(body(courses).data).toMatchObject({ created: 2, updated: 0, errorCount: 2 });
    expect(body<{ errors: Array<{ line: number }> }>(courses).data.errors.map((e) => e.line)).toEqual([3, 4]);

    const units = await ict.post('/units/bulk', {
      rows: [
        { Code: 'BIT 110', Title: 'Programming', 'Hours per week': 4, 'Class length': 2, 'Room type': 'Computer lab', Courses: 'BSC.IT Y1S1' },
        { Code: 'BIT 210', Title: 'Databases', 'Hours per week': 3, Courses: 'BSC.IT Y2S1; BSC.NOPE Y1S1' },
      ],
    });
    expect(body(units).data).toMatchObject({ created: 1, errorCount: 1 });

    const groups = await ict.post('/groups/bulk', {
      rows: [
        { 'Unit code': 'BIT110', Group: 'A', Students: '50', Courses: 'BSC.IT Y1S1', Lecturer: 'Dr. Ann Mwangi (PT)', 'Staff no.': 'STF/0100' },
        { 'Unit code': 'BIT110', Group: 'B', Students: '30', Courses: 'BSC.IT Y1S1', 'Staff no.': 'STF/0100' },
      ],
    });
    expect(body(groups).data).toMatchObject({ created: 2, errorCount: 0 });
    const b = body<BoardBody>(await ict.get('')).data;
    expect(b.units[0]!.groups.map((g) => [g.label, g.students, g.lecturer])).toEqual([
      ['GR A', 50, 'Dr. Ann Mwangi (PT)'],
      ['GR B', 30, 'Dr. Ann Mwangi (PT)'],
    ]);
    expect(b.problems).toEqual([]);
  });

  it('reads a workbook back as cells', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Courses');
    sheet.addRow(['Course', 'Students']);
    sheet.addRow(['BSC.IT Y3S1', 70]);
    const file = Buffer.from(await book.xlsx.writeBuffer()).toString('base64');
    const res = await ict.post('/spreadsheet', { file });
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual({ sheets: [{ name: 'Courses', rows: [['Course', 'Students'], ['BSC.IT Y3S1', '70']] }] });
    expect((await ict.post('/spreadsheet', { file: Buffer.from('not a workbook').toString('base64') })).status).toBe(422);
  });
});

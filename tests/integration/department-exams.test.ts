import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A department's exam papers, practicals and invigilators against a real
 * Postgres database, with the Timetable Generator stubbed at `fetch` (its
 * terms, and the exam draft the Director shares). The Generator reads what
 * was published from the integration endpoints, in the shape its exam import
 * expects.
 */
const TEST_DB = 'attendance_department_exams_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const GENERATOR = 'https://generator.test.local';
process.env.GENERATOR_BASE_URL = GENERATOR;
process.env.GENERATOR_API_KEY = 'generator-key';

const TERM = 'term-2026-1';
const generator = {
  draft: { draft: null, papers: [] } as { draft: unknown; papers: Array<Record<string, unknown>> },
};

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith(GENERATOR)) return realFetch(input, init);
  const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const path = url.slice(GENERATOR.length);
  if (path === '/api/integrations/attendance/terms') {
    return json([{ id: TERM, academic_year: '2026/2027', semester: 1, name: 'September - December 2026', published_version: null }]);
  }
  if (path === `/api/integrations/attendance/terms/${TERM}/exam-draft`) return json(generator.draft);
  return new Response('{}', { status: 404 });
});

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

async function makeOfficer(departmentId: string) {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'DEPARTMENT', 'ACTIVE', NOW()) RETURNING id`,
    [`exams${n}@uni.ac.ke`, `Officer ${n}`]);
  await pool.query(`INSERT INTO department_profiles (user_id, department_id, title) VALUES ($1, $2, 'Dr.')`, [u!.id, departmentId]);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  const auth = `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'DEPARTMENT' })}`;
  const at = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (path: string, data?: object) =>
    request(app)[method](`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data);
  return { get: at('get'), post: at('post'), patch: at('patch'), put: at('put'), delete: at('delete') };
}

async function makeDepartment(name: string, code: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [name, code]);
  return d!.id;
}

type Api = Awaited<ReturnType<typeof makeOfficer>>;
let cs: Api;
let edu: Api;
const ids: Record<string, string> = {};

interface ExamBoard {
  canEdit: boolean;
  published: boolean;
  papers: Array<{ id: string; codes: string; title: string; examiner: string | null; classRows: string[]; students: number; changedSincePublished: boolean }>;
  units: Array<{ id: string; code: string; noWrittenExam: boolean; paperId: string | null }>;
  otherUnits: Array<{ id: string; code: string }>;
  practicals: Array<{ unitCode: string; date: string; startTime: string }>;
  problems: Array<{ code: string; message: string }>;
}

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
  cs = await makeOfficer(await makeDepartment('Computer Science', 'DCOMP'));
  edu = await makeOfficer(await makeDepartment('Education', 'DEDU'));

  // Teaching first, as departments enter it: two CS units (one taught by Peter), one Education unit.
  ids.y1 = body<{ id: string }>(await cs.post('/courses', { programme: 'BSC.COMP SCI', year: 1, semester: 1, students: 100 })).data.id;
  ids.odel = body<{ id: string }>(await cs.post('/courses', { programme: 'BSC.COMP SCI', year: 1, semester: 1, subClass: 'D', students: 20, mode: 'odel' })).data.id;
  ids.peter = body<{ id: string }>(await cs.post('/lecturers', { title: 'Dr.', fullName: 'Peter Kamami', staffNumber: 'STF/0001', maxExamDuties: 1 })).data.id;
  ids.jane = body<{ id: string }>(await cs.post('/lecturers', { fullName: 'Jane Otieno', staffNumber: 'STF/0002' })).data.id;
  ids.cosc = body<{ id: string }>(await cs.post('/units', { code: 'COSC 130', title: 'Programming', weeklyHours: 3, classLength: 3, courseIds: [ids.y1, ids.odel] })).data.id;
  ids.proj = body<{ id: string }>(await cs.post('/units', { code: 'COSC 499', title: 'Project', weeklyHours: 2, classLength: 2, courseIds: [ids.y1] })).data.id;
  const groups = body<{ units: Array<{ id: string; groups: Array<{ id: string }> }> }>(await cs.get('')).data.units;
  await cs.patch(`/groups/${groups.find((u) => u.id === ids.cosc)!.groups[0]!.id}`, { lecturerId: ids.peter });
  ids.ed = body<{ id: string }>(await edu.post('/courses', { programme: 'BED.SCI', year: 1, semester: 1, students: 50 })).data.id;
  ids.bite = body<{ id: string }>(await edu.post('/units', { code: 'BITE 131', title: 'ICT in Education', weeklyHours: 3, classLength: 3, courseIds: [ids.ed] })).data.id;
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

describe('exam papers', () => {
  it('starts with every unit needing a paper', async () => {
    const b = body<ExamBoard>(await cs.get('/exams')).data;
    expect(b.problems.map((p) => p.message)).toEqual([
      "COSC 130 is on no paper; add it to one, or mark it 'no written exam'.",
      "COSC 499 is on no paper; add it to one, or mark it 'no written exam'.",
    ]);
    expect(b.otherUnits.map((u) => u.code)).toEqual(['BITE 131']);
  });

  it('makes one shared paper for two departments\' units, examined by the unit\'s lecturer', async () => {
    const res = await cs.post('/exam-papers', { unitIds: [ids.cosc, ids.bite] });
    expect(res.status).toBe(201);
    ids.paper = body<{ id: string }>(res).data.id;
    const b = body<ExamBoard>(await cs.get('/exams')).data;
    expect(b.papers).toEqual([expect.objectContaining({
      codes: 'BITE 131/COSC 130', title: 'Programming', examiner: 'Dr. Peter Kamami (FT)',
      classRows: ['BED.SCI Y1S1', 'BSC.COMP SCI Y1S1', 'BSC.COMP SCI Y1S1 (D)'], students: 170,
    })]);
    // A unit is on one paper only.
    expect(body(await edu.post('/exam-papers', { unitIds: [ids.bite] })).error!.code).toBe('TEACHING_TAKEN');
  });

  it('marks a unit with no written exam, and keeps it off papers', async () => {
    expect((await cs.put(`/units/${ids.proj}/no-written-exam`, { noWrittenExam: true })).status).toBe(200);
    expect(body(await cs.post('/exam-papers', { unitIds: [ids.proj] })).error!.code).toBe('TEACHING_TAKEN');
    expect(body<ExamBoard>(await cs.get('/exams')).data.problems).toEqual([]);
  });

  it('takes practicals on weekdays only', async () => {
    expect((await cs.post('/practicals', { unitId: ids.cosc, date: '2026-11-21', startTime: '09:00', endTime: '11:00' })).status).toBe(422);
    expect((await cs.post('/practicals', { unitId: ids.cosc, date: '2026-11-20', startTime: '09:00', endTime: '11:00' })).status).toBe(201);
    const pasted = await cs.post('/practicals/bulk', { rows: [{ 'Unit code': 'cosc130', Date: '23/11/2026', Start: '2pm', End: '4:30pm' }, { 'Unit code': 'X 1', Date: '2026-11-23' }] });
    expect(body(pasted).data).toMatchObject({ created: 1, errorCount: 1 });
    expect(body<ExamBoard>(await cs.get('/exams')).data.practicals.map((p) => [p.date, p.startTime])).toEqual([['2026-11-20', '09:00'], ['2026-11-23', '14:00']]);
  });

  it('publishes the paper list on its own lock, leaving teaching editable', async () => {
    expect(body<ExamBoard>(await cs.post('/exams/publish')).data.published).toBe(true);
    expect(body(await cs.patch(`/exam-papers/${ids.paper}`, { title: 'X' })).error!.code).toBe('TEACHING_PUBLISHED');
    expect((await cs.post('/courses', { programme: 'BSC.IT', year: 1, semester: 1, students: 9 })).status).toBe(201);
  });

  it('serves the Generator the published papers, with each cohort\'s mode', async () => {
    const res = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key');
    expect(res.status).toBe(200);
    const data = body<{
      courses: Array<{ id: string; label: string; mode: string }>;
      published: Array<{ code: string; papers: Array<{ id: string; codes: string[]; examiner: { staff_number: string }; rows: Array<{ course_id: string; mode: string }> }>; practicals: unknown[] }>;
      not_published: Array<{ code: string }>;
    }>(res).data;
    expect(data.published.map((d) => d.code)).toEqual(['DCOMP']);
    expect(data.not_published.map((d) => d.code)).toEqual(['DEDU']);
    const paper = data.published[0]!.papers[0]!;
    expect([paper.id, paper.codes, paper.examiner.staff_number]).toEqual([ids.paper, ['BITE 131', 'COSC 130'], 'STF/0001']);
    expect(paper.rows.find((r) => r.course_id === ids.odel)!.mode).toBe('odel');
    expect(data.published[0]!.practicals).toHaveLength(2);
  });

  it('writes the moderation letter as PDF and Word', async () => {
    for (const [format, magic] of [['pdf', '%PDF'], ['docx', 'PK']] as const) {
      const res = await cs.get(`/moderation-letter/${format}?moderator=${encodeURIComponent('Prof. A Moderator\nUniversity of Nairobi')}`)
        .buffer(true)
        .parse((r, done) => { const c: Buffer[] = []; r.on('data', (x: Buffer) => c.push(x)); r.on('end', () => done(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      expect((res.body as Buffer).subarray(0, magic.length).toString()).toBe(magic);
    }
  });
});

describe('invigilators', () => {
  it('waits for the Director to share an exam draft', async () => {
    const b = body<{ draft: unknown; canEdit: boolean }>(await cs.get('/invigilators')).data;
    expect([b.draft, b.canEdit]).toEqual([null, false]);
    expect(body(await cs.post('/invigilators/publish')).error!.code).toBe('TEACHING_NOT_READY');
  });

  it('names one per paper, never someone over their duty limit, and serves them to the Generator once published', async () => {
    generator.draft = {
      draft: { id: 'd1', name: 'Draft 1', shared_at: '2026-10-25T08:00:00Z', status: 'shared' },
      papers: [{ paper_ref: ids.paper, codes: ['BITE 131', 'COSC 130'], date: '2026-12-01', session: 0, start_time: '08:30', end_time: '10:30', rooms: ['LH1', 'LH2'] }],
    };
    let b = body<{ canEdit: boolean; papers: Array<{ rooms: string[]; date: string }>; problems: unknown[]; lecturers: Array<{ id: string; own: boolean }> }>(await cs.get('/invigilators')).data;
    expect(b.canEdit).toBe(true);
    expect(b.papers[0]!.rooms).toEqual(['LH1', 'LH2']);
    expect(b.problems).toHaveLength(1);

    expect((await cs.put(`/invigilators/${ids.paper}`, { lecturerId: ids.jane })).status).toBe(200);
    expect((await cs.post('/invigilators/publish')).status).toBe(200);
    // Only once published does the Generator see it.
    const res = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/invigilators`).set('X-API-Key', 'generator-key');
    expect(body(res).data).toEqual({ [ids.paper!]: { '': { staff_number: 'STF/0002', name: 'Jane Otieno (FT)' } } });
    b = body<typeof b>(await cs.get('/invigilators')).data;
    expect(b.problems).toEqual([]);
  });

  it('never puts one person in two rooms at once, nor over their duty limit, whichever list names them', async () => {
    const unit = body<{ id: string }>(await edu.post('/units', { code: 'EDU 140', title: 'Pedagogy', weeklyHours: 3, classLength: 3, courseIds: [ids.ed] })).data.id;
    const same = body<{ id: string }>(await edu.post('/exam-papers', { unitIds: [unit] })).data.id;
    const later = body<{ id: string }>(await edu.post('/exam-papers', { unitIds: [body<{ id: string }>(await edu.post('/units', { code: 'EDU 150', title: 'Assessment', weeklyHours: 3, classLength: 3, courseIds: [ids.ed] })).data.id] })).data.id;
    const paper = (ref: string, date: string, session: number) => ({ paper_ref: ref, codes: [], date, session, start_time: '08:30', end_time: '10:30', rooms: ['LH3'] });
    generator.draft.papers.push(paper(same, '2026-12-01', 0), paper(later, '2026-12-02', 0));

    // Jane (Computer Science's list) already invigilates in that session.
    const busy = await edu.put(`/invigilators/${same}`, { lecturerId: ids.jane });
    expect([busy.status, body(busy).error!.message]).toEqual([409, 'Jane Otieno already invigilates Programming on 2026-12-01 08:30-10:30.']);
    // Peter may take one duty; Education's own copy of him (same staff number) has no limit, but his does.
    await edu.post('/lecturers', { fullName: 'Peter Kamami', staffNumber: 'STF/0001' });
    const eduPeter = body<{ lecturers: Array<{ id: string; own: boolean; staffNumber: string }> }>(await edu.get('/invigilators')).data
      .lecturers.find((l) => l.own && l.staffNumber === 'STF/0001')!.id;
    expect((await edu.put(`/invigilators/${same}`, { lecturerId: eduPeter })).status).toBe(200);
    const over = await edu.put(`/invigilators/${later}`, { lecturerId: ids.peter });
    expect([over.status, body(over).error!.message]).toEqual([409, 'Peter Kamami already has 1 duties; the limit is 1.']);
  });
});

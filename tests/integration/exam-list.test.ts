import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A department uploads its exam list (the Word letter it sends for
 * moderation), reviews it, saves it, and corrects the numbers; the papers'
 * students come from SMARTTT (stubbed at `fetch`) and the Generator reads
 * them in the shape its exam import expects. Real Postgres.
 */
const TEST_DB = 'attendance_exam_list_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const GENERATOR = 'https://generator.test.local';
const SMARTTT = 'https://smarttt.test.local';
process.env.GENERATOR_BASE_URL = GENERATOR;
process.env.GENERATOR_API_KEY = 'generator-key';
process.env.SMARTTT_BASE_URL = SMARTTT;
process.env.SMARTTT_API_KEY = 'smarttt-key';

const TERM = 'term-2026-1';

type Row = { program: string; year_of_study: number; study_semester: number; stream: string; sitting: 'regular' | 'odel'; students: number };
const row = (program: string, year: number, students: number, sitting: 'regular' | 'odel' = 'regular', stream = ''): Row =>
  ({ program, year_of_study: year, study_semester: 1, stream, sitting, students });
/** What SMARTTT answers: synced students per unit code. */
const smarttt = {
  down: false,
  units: {} as Record<string, { name: string; rows: Row[]; lecturers?: Array<{ staff_number: string; name: string }> }>,
  asked: [] as string[][],
};

const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith(GENERATOR)) {
    if (url.slice(GENERATOR.length) === '/api/integrations/attendance/terms') {
      return json({ success: true, data: [{ id: TERM, academic_year: '2026/2027', semester: 1, name: 'September - December 2026', published_version: null }] });
    }
    return new Response('{}', { status: 404 });
  }
  if (url.startsWith(`${SMARTTT}/api/v1/integrations/attendance/unit-enrolment/`)) {
    if (smarttt.down) throw new TypeError('fetch failed');
    const { codes } = JSON.parse(init?.body as string) as { codes: string[] };
    smarttt.asked.push(codes);
    const units: Record<string, unknown> = {};
    const unknown: string[] = [];
    for (const code of codes) {
      const u = smarttt.units[code.replace(/\s+/g, ' ').toUpperCase()];
      if (!u) { unknown.push(code); continue; }
      units[code] = { code, name: u.name, students: u.rows.reduce((n, r) => n + r.students, 0), rows: u.rows, lecturers: u.lecturers ?? [] };
    }
    return json({ term: { id: 'x', academic_year: '2026/2027', semester: 1 }, units, unknown });
  }
  return realFetch(input, init);
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
    [`list${n}@uni.ac.ke`, `Officer ${n}`]);
  await pool.query(`INSERT INTO department_profiles (user_id, department_id, title) VALUES ($1, $2, 'Dr.')`, [u!.id, departmentId]);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  const auth = `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'DEPARTMENT' })}`;
  const at = (method: 'get' | 'post' | 'put') => (path: string, data?: object) =>
    request(app)[method](`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data);
  return { get: at('get'), post: at('post'), put: at('put') };
}

async function makeDepartment(name: string, code: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [name, code]);
  return d!.id;
}

/** A moderation letter like the departments write: a paragraph, then a table of drafts with section rows. */
async function letter(rows: string[][], paragraphs: string[] = []): Promise<string> {
  const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] });
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph('DEPARTMENT OF BASIC SCIENCES'),
        new Paragraph('Dear Madam, this is to forward the following examination drafts.'),
        ...paragraphs.map((p) => new Paragraph(p)),
        new Table({ rows: rows.map((r) => new TableRow({ children: r.map(cell) })) }),
      ],
    }],
  });
  return (await Packer.toBuffer(doc)).toString('base64');
}

type Api = Awaited<ReturnType<typeof makeOfficer>>;
let math: Api;
let cs: Api;
const ids: Record<string, string> = {};

interface Review {
  entries: Array<{
    line: number; codes: string[]; title: string; section: string; sitting: string; students: number | null;
    classRows: Array<{ label: string; students: number }>; unknownCodes: string[]; duplicateOf: number | null;
    otherDepartments: string[]; existingPaperId: string | null; examiner: { lecturerId: string | null; staffNumber: string } | null;
  }>;
  smarttt: { available: boolean; reason: string | null };
  summary: { papers: number; newPapers: number; duplicates: number; unknown: number; noStudents: number };
}
interface Board {
  papers: Array<{
    id: string; codes: string; sitting: string; title: string; examinerId: string | null; listed: boolean; students: number; classRows: string[];
    rows: Array<{ programme: string; year: number; semester: number; stream: string; students: number; smartttStudents: number | null; edited: boolean }>;
  }>;
  problems: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  published: boolean;
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
  math = await makeOfficer(await makeDepartment('Basic Sciences', 'DBSC'));
  cs = await makeOfficer(await makeDepartment('Computer Science', 'DCOMP'));
  ids.ruth = body<{ id: string }>(await math.post('/lecturers', { title: 'Dr.', fullName: 'Ruth Ndungu', staffNumber: 'STF/0100' })).data.id;
  smarttt.units = {
    'MATH 241': {
      name: 'Linear Algebra',
      rows: [row('BSC.MATH', 2, 80), row('BSC.MATH', 2, 12, 'regular', 'B'), row('BED.SCI', 2, 30), row('BSC.MATH', 2, 9, 'odel')],
      lecturers: [{ staff_number: 'STF/0100', name: 'Ruth Ndungu' }],
    },
    'MATH 446': { name: 'Statistical Inference II', rows: [row('BSC.STAT', 4, 40)] },
    'COSC 170': { name: 'Programming', rows: [row('BSC.CS', 1, 100)] },
    'COSC 172': { name: 'Programming II', rows: [row('BSC.CS', 1, 90), row('BSC.MATH', 1, 20)] },
    'MATH 100': { name: 'Nobody synced it', rows: [] },
  };
}, 60_000);

beforeEach(async () => {
  (await import('../../src/modules/teaching/teaching.service.js')).clearTermsCache();
  smarttt.down = false;
});

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

describe('the uploaded exam list', () => {
  it('reads the letter and checks it against SMARTTT without storing anything', async () => {
    const file = await letter([
      ['S.NO', 'UNIT CODE', 'UNIT TITLE'],
      ['1', 'Math 241', 'Linear Algebra'],
      ['2', 'MATH 446', 'Statistical Inference II'],
      ['3', 'COSC 0170/172', 'Programming'],
      ['4', 'Math 241', 'Linear Algebra again'],
      ['', 'ODEL / PART-TIME DRAFTS', ''],
      ['5', 'Math 241', 'Linear Algebra'],
      ['6', 'MATH 999', 'Not a unit'],
      ['7', 'MATH 100', 'Nobody synced it'],
    ]);
    const res = await math.post('/exam-list/read', { file });
    expect(res.status).toBe(200);
    const r = body<Review>(res).data;
    expect(r.entries.map((e) => [e.codes.join('/'), e.sitting, e.students])).toEqual([
      ['MATH 241', 'regular', 122], // the ODEL students sit the ODEL paper listed below
      ['MATH 446', 'regular', 40],
      ['COSC 0170/COSC 172', 'regular', 110],
      ['MATH 241', 'regular', 122],
      ['MATH 241', 'odel', 9],
      ['MATH 999', 'odel', 0],
      ['MATH 100', 'odel', 0],
    ]);
    const first = r.entries[0]!;
    expect(first.classRows).toEqual([
      { label: 'BED.SCI Y2S1', students: 30 }, { label: 'BSC.MATH Y2S1', students: 80 }, { label: 'BSC.MATH Y2S1 (B)', students: 12 },
    ]);
    expect(first.examiner).toEqual({ staffNumber: 'STF/0100', name: 'Ruth Ndungu', lecturerId: ids.ruth });
    expect(r.entries[3]!.duplicateOf).toBe(1);
    expect(r.entries[2]!.unknownCodes).toEqual(['COSC 0170']);
    expect(r.entries[4]!.section).toBe('ODEL / PART-TIME DRAFTS');
    expect(r.summary).toEqual({ papers: 6, newPapers: 6, duplicates: 1, unknown: 2, noStudents: 2 });
    expect((await pool.query(`SELECT 1 FROM teaching_exam_papers`)).rowCount).toBe(0);
  });

  it('refuses a file that is not a Word document', async () => {
    const res = await math.post('/exam-list/read', { file: Buffer.from('not a docx').toString('base64') });
    expect(res.status).toBe(422);
    expect(body(res).error!.message).toMatch(/not a Word document/);
  });

  it('saves the papers with their students from SMARTTT, and the examiner from the timetable', async () => {
    const res = await math.post('/exam-list', {
      papers: [
        { codes: ['MATH 241'], title: 'Linear Algebra', sitting: 'regular' },
        { codes: ['MATH 241'], title: 'Linear Algebra', sitting: 'odel' },
        { codes: ['MATH 446'], title: 'Statistical Inference II', sitting: 'regular' },
        { codes: ['MATH 100'], title: 'Nobody synced it', sitting: 'regular' },
      ],
    });
    expect(res.status).toBe(200);
    const data = body<{ created: number; updated: number; board: Board }>(res).data;
    expect([data.created, data.updated]).toEqual([4, 0]);
    const papers = Object.fromEntries(data.board.papers.map((p) => [`${p.codes}|${p.sitting}`, p]));
    expect(papers['MATH 241|regular']).toMatchObject({ listed: true, students: 122, examinerId: ids.ruth });
    expect(papers['MATH 241|odel']).toMatchObject({ students: 9, classRows: ['BSC.MATH Y2S1 (ODEL)'] });
    expect(papers['MATH 446|regular']!.examinerId).toBeNull(); // nobody on the list teaches it: optional
    // The paper nobody synced doesn't stop publishing (part-time students may never sync): it is a warning.
    expect(data.board.problems).toEqual([]);
    expect(data.board.warnings.map((p) => p.code)).toEqual(['no_students']);
    ids.m241 = papers['MATH 241|regular']!.id;
    ids.m100 = papers['MATH 100|regular']!.id;
  });

  it('saving the list again updates titles instead of adding papers', async () => {
    const res = await math.post('/exam-list', { papers: [{ codes: ['math 241'], title: 'Linear Algebra I', sitting: 'regular' }] });
    const data = body<{ created: number; updated: number; board: Board }>(res).data;
    expect([data.created, data.updated]).toEqual([0, 1]);
    expect(data.board.papers.find((p) => p.id === ids.m241)!.title).toBe('Linear Algebra I');
    expect(data.board.papers).toHaveLength(4);
  });

  it('lets the department correct the numbers, which a new count from SMARTTT keeps', async () => {
    const res = await math.put(`/exam-papers/${ids.m241}/rows`, {
      rows: [
        { programme: 'BSC.MATH', year: 2, semester: 1, stream: '', students: 95 }, // more sit it than synced
        { programme: 'BSC.MATH', year: 2, semester: 1, stream: 'B', students: 12 },
        { programme: 'BSC.ACT', year: 2, semester: 1, stream: '', students: 15 }, // a class SMARTTT didn't have
        // BED.SCI left out: nobody from it sits this paper
      ],
    });
    expect(res.status).toBe(200);
    let paper = body<Board>(res).data.papers.find((p) => p.id === ids.m241)!;
    expect(paper.students).toBe(122);
    expect(paper.rows.map((r) => [r.programme, r.stream, r.students, r.smartttStudents, r.edited])).toEqual([
      ['BED.SCI', '', 0, 30, true],
      ['BSC.ACT', '', 15, null, true],
      ['BSC.MATH', '', 95, 80, true],
      ['BSC.MATH', 'B', 12, 12, false],
    ]);
    // More students sync; the count is read again. Only the untouched row follows SMARTTT.
    smarttt.units['MATH 241']!.rows = [row('BSC.MATH', 2, 85), row('BSC.MATH', 2, 14, 'regular', 'B'), row('BED.SCI', 2, 31), row('BSC.MATH', 2, 9, 'odel')];
    paper = body<Board>(await math.post('/exam-papers/recount')).data.papers.find((p) => p.id === ids.m241)!;
    expect(paper.rows.map((r) => [r.programme, r.stream, r.students, r.smartttStudents])).toEqual([
      ['BED.SCI', '', 0, 31],
      ['BSC.ACT', '', 15, null],
      ['BSC.MATH', '', 95, 85],
      ['BSC.MATH', 'B', 14, 14],
    ]);
    await math.put(`/exam-papers/${ids.m100}/rows`, { rows: [{ programme: 'BSC.MATH', year: 1, semester: 1, stream: '', students: 60 }] });
  });

  it('sends a paper nobody has synced to the Director anyway, with no class rows', async () => {
    const saved = body<{ board: Board }>(await math.post('/exam-list', { papers: [{ codes: ['MATH 100'], title: 'Nobody synced it', sitting: 'odel' }] })).data;
    const nobody = saved.board.papers.find((p) => p.codes === 'MATH 100' && p.sitting === 'odel')!;
    expect([nobody.students, nobody.rows]).toEqual([0, []]);
    expect(saved.board.warnings.map((w) => w.message)).toEqual([
      'Nobody has synced MATH 100 (ODEL) in SMARTTT yet. It still goes to the Director and gets a date; enter its students under Numbers so it gets a room.',
    ]);
  });

  it('says so when SMARTTT is down, and keeps the last numbers', async () => {
    smarttt.down = true;
    expect((await math.post('/exam-papers/recount')).status).toBe(503);
    const r = body<Review>(await math.post('/exam-list/read', { file: await letter([['1', 'MATH 446', 'Stats']]) })).data;
    expect(r.smarttt.available).toBe(false);
    expect(r.entries[0]!.students).toBeNull();
  });

  it('flags a code another department has listed', async () => {
    await cs.post('/exam-list', { papers: [{ codes: ['COSC 172', 'COSC 170'], title: 'Programming', sitting: 'regular' }] });
    const r = body<Review>(await math.post('/exam-list/read', { file: await letter([['1', 'COSC 172', 'Programming II']]) })).data;
    expect(r.entries[0]!.otherDepartments).toEqual(['DCOMP']);
  });

  it('gives the Generator one class row per class however many papers it sits, with fresh counts', async () => {
    expect((await math.post('/exams/publish')).status).toBe(200);
    expect((await cs.post('/exams/publish')).status).toBe(200);
    smarttt.units['MATH 446']!.rows = [row('BSC.STAT', 4, 44)];
    const res = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key');
    expect(res.status).toBe(200);
    const data = body<{
      courses: Array<{ id: string; label: string; students: number; mode: string; department_code: string }>;
      published: Array<{ code: string; papers: Array<{ codes: string[]; sitting: string; students: number; rows: Array<{ course_id: string; students: number }> }> }>;
    }>(res).data;
    const byLabel = Object.fromEntries(data.courses.map((c) => [c.label, c]));
    // BSC.MATH Y1S1 sits MATH 100 (60) and COSC 172 (20): one class row, at its bigger number.
    expect(byLabel['BSC.MATH Y1S1']).toMatchObject({ id: 'listed:BSCMATH|1|1|', students: 60 });
    expect(byLabel['BSC.MATH Y2S1 (ODEL)']!.mode).toBe('odel');
    const mathPapers = data.published.find((d) => d.code === 'DBSC')!.papers;
    const stats = mathPapers.find((p) => p.codes.join() === 'MATH 446')!;
    expect(stats.students).toBe(44); // re-read when the Generator imported
    const nobody = mathPapers.find((p) => p.codes.join() === 'MATH 100' && p.sitting === 'odel')!;
    expect([nobody.students, nobody.rows]).toEqual([0, []]);
    const cosc = data.published.find((d) => d.code === 'DCOMP')!.papers[0]!;
    expect(cosc.codes).toEqual(['COSC 170', 'COSC 172']);
    expect(cosc.rows.map((r) => [r.course_id, r.students])).toEqual([['listed:BSCCS|1|1|', 100], ['listed:BSCMATH|1|1|', 20]]);
  });

  it('keeps the list locked once published', async () => {
    const res = await math.put(`/exam-papers/${ids.m241}/rows`, { rows: [] });
    expect(res.status).toBe(409);
  });
});

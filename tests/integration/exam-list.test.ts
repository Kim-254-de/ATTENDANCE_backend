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
  if (url.startsWith(`${SMARTTT}/api/v1/integrations/attendance/programs/`)) {
    return json({ programs: [{ code: 'BSC.NURS', name: 'BSc Nursing' }, { code: 'BSC.HRIM', name: 'BSc Health Records' }, { code: 'BSC.MATH', name: 'BSc Mathematics' }] });
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
  const at = (method: 'get' | 'post' | 'put' | 'delete') => (path: string, data?: object) =>
    request(app)[method](`/api/v1/departments/teaching${path}`).set('Authorization', auth).send(data);
  return { get: at('get'), post: at('post'), put: at('put'), delete: at('delete') };
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
    secondListingOf: number | null; switchesPaperId: string | null;
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
    'NURS 111': { name: 'Anatomy', rows: [row('BSC.NURS', 1, 20, 'regular', 'A'), row('BSC.NURS', 1, 5, 'regular', 'B')] },
    'NURS 112': { name: 'Physiology', rows: [] },
    'NURS 113': { name: 'Biochemistry', rows: [row('BSC.NURS', 1, 0)] },
    'HRIM 111': { name: 'Records', rows: [row('BSC.HRIM', 2, 3)] },
    'BOTA 473': { name: 'Plant Biochemistry', rows: [row('BSC.BOT', 4, 7)] },
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
    expect(r.summary).toEqual({ papers: 6, newPapers: 6, duplicates: 1, unknown: 2, noStudents: 2, noClasses: 2, secondListings: 0, toOdel: 0 });
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
      'Nobody has synced MATH 100 (ODEL) in SMARTTT and the master timetable has no class for it. It still goes to the Director and gets a date; add its classes and students under Numbers so it gets a room and can\'t clash.',
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

  it('tells the Generator which classes are only guessed from the code', async () => {
    const res = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key');
    const data = body<{ published: Array<{ code: string; papers: Array<{ codes: string[]; rows: Array<{ guessed: boolean }> }> }> }>(res).data;
    for (const paper of data.published.flatMap((d) => d.papers)) {
      for (const r of paper.rows) expect(r.guessed).toBe(false); // SMARTTT's, or a class the department named
    }
  });

  it('keeps the list locked once published', async () => {
    const res = await math.put(`/exam-papers/${ids.m241}/rows`, { rows: [] });
    expect(res.status).toBe(409);
    expect((await math.delete('/exam-list')).status).toBe(409);
  });

  it('removes the uploaded list as a whole once reopened', async () => {
    expect((await cs.post('/exams/reopen')).status).toBe(200);
    const before = body<Board>(await cs.get('/exams')).data.papers;
    expect(before.some((p) => p.listed)).toBe(true);
    const res = await cs.delete('/exam-list');
    expect(res.status).toBe(200);
    const data = body<{ deleted: number; board: Board }>(res).data;
    expect(data.deleted).toBe(before.filter((p) => p.listed).length);
    expect(data.board.papers.filter((p) => p.listed)).toEqual([]);
    expect(data.board.papers).toHaveLength(before.filter((p) => !p.listed).length);
    // The other department's list is untouched.
    expect(body<Board>(await math.get('/exams')).data.papers.some((p) => p.listed)).toBe(true);
  });

  it("takes many papers' numbers in one save, all or none", async () => {
    expect((await math.post('/exams/reopen')).status).toBe(200);
    const papers = body<Board>(await math.get('/exams')).data.papers;
    const nobody = papers.find((p) => p.codes === 'MATH 100' && p.sitting === 'odel')!;
    const stats = papers.find((p) => p.codes === 'MATH 446')!;
    const row = (programme: string, year: number, students: number) => ({ programme, year, semester: 1, stream: '', students });
    // One bad paper (a unit-built id that isn't the department's) and nothing is saved.
    const bad = await math.put('/exam-papers/rows', {
      papers: [{ paperId: nobody.id, rows: [row('MATH', 1, 25)] }, { paperId: '00000000-0000-4000-8000-000000000000', rows: [] }],
    });
    expect(bad.status).toBe(404);
    expect(body<Board>(await math.get('/exams')).data.papers.find((p) => p.id === nobody.id)!.students).toBe(0);

    const res = await math.put('/exam-papers/rows', {
      papers: [{ paperId: nobody.id, rows: [row('MATH', 1, 25)] }, { paperId: stats.id, rows: [row('BSC.STAT', 4, 50)] }],
    });
    expect(res.status).toBe(200);
    const after = body<Board>(res).data;
    expect(after.papers.find((p) => p.id === nobody.id)!.students).toBe(25);
    expect(after.papers.find((p) => p.id === stats.id)!.rows.map((r) => [r.students, r.smartttStudents, r.edited])).toEqual([[50, 44, true]]);
    expect(after.warnings.some((w) => w.message.includes('MATH 100'))).toBe(false);

    // MATH Y1S1 is what the page fills in from "MATH 100"; BSC.STAT is a class the department named.
    expect((await math.post('/exams/publish')).status).toBe(200);
    const read = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key');
    const sent = body<{ published: Array<{ code: string; papers: Array<{ id: string; rows: Array<{ guessed: boolean }> }> }> }>(read).data
      .published.find((d) => d.code === 'DBSC')!.papers;
    expect(sent.find((p) => p.id === nobody.id)!.rows.map((r) => r.guessed)).toEqual([true]);
    expect(sent.find((p) => p.id === stats.id)!.rows.map((r) => r.guessed)).toEqual([false]);
  });
  describe('classes from the master timetable', () => {
    const generatorFeed = async () => {
      const read = await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key');
      return body<{
        courses: Array<{ id: string; label: string; students: number }>;
        published: Array<{ code: string; papers: Array<{ id: string; rows: Array<{ course_id: string; students: number; guessed: boolean }> }> }>;
      }>(read).data;
    };

    it('reach the Generator with no number yet, known classes and not guesses', async () => {
      expect((await math.post('/exams/reopen')).status).toBe(200);
      smarttt.units['STAT 300'] = { name: 'Regression', rows: [row('BSC.STAT', 3, 0), row('BED.SCI', 3, 0, 'regular', '1')] };
      const r = body<Review>(await math.post('/exam-list/read', { file: await letter([['1', 'STAT 300', 'Regression']]) })).data;
      expect(r.entries[0]).toMatchObject({ students: 0, classRows: [{ label: 'BED.SCI Y3S1 (1)', students: 0 }, { label: 'BSC.STAT Y3S1', students: 0 }] });
      expect(r.summary).toMatchObject({ noStudents: 1, noClasses: 0 });

      const saved = body<{ board: Board }>(await math.post('/exam-list', { papers: [{ codes: ['STAT 300'], title: 'Regression', sitting: 'regular' }] })).data.board;
      const paper = saved.papers.find((p) => p.codes === 'STAT 300')!;
      ids.stat = paper.id;
      expect(paper.rows.map((x) => [x.programme, x.students, x.smartttStudents, x.edited])).toEqual([['BED.SCI', 0, 0, false], ['BSC.STAT', 0, 0, false]]);
      expect(paper.classRows).toHaveLength(2);
      expect(saved.warnings.map((w) => w.message)).toContain(
        'STAT 300 has 2 classes on the master timetable and no student number yet. Its classes are kept from clashing and it gets a date; enter its students under Numbers so it gets a room.',
      );

      expect((await math.post('/exams/publish')).status).toBe(200);
      const feed = await generatorFeed();
      const sent = feed.published.flatMap((d) => d.papers).find((p) => p.id === ids.stat)!;
      expect(sent.rows.map((x) => [x.course_id, x.students, x.guessed])).toEqual([
        ['listed:BEDSCI|3|1|1', 0, false],
        ['listed:BSCSTAT|3|1|', 0, false],
      ]);
      expect(feed.courses.map((c) => c.id)).toEqual(expect.arrayContaining(['listed:BEDSCI|3|1|1', 'listed:BSCSTAT|3|1|']));
    });

    it('stay off a paper once the department removes them, and take a number when someone syncs', async () => {
      expect((await math.post('/exams/reopen')).status).toBe(200);
      const res = await math.put(`/exam-papers/${ids.stat}/rows`, { rows: [{ programme: 'BSC.STAT', year: 3, semester: 1, stream: '', students: 0 }] });
      expect(res.status).toBe(200);
      expect(body<Board>(res).data.papers.find((p) => p.id === ids.stat)!.classRows).toEqual(['BSC.STAT Y3S1']);

      smarttt.units['STAT 300']!.rows = [row('BSC.STAT', 3, 18), row('BED.SCI', 3, 0, 'regular', '1')];
      const paper = body<Board>(await math.post('/exam-papers/recount')).data.papers.find((p) => p.id === ids.stat)!;
      expect(paper.rows.map((x) => [x.programme, x.students, x.edited])).toEqual([['BED.SCI', 0, true], ['BSC.STAT', 18, false]]);
      expect(paper.classRows).toHaveLength(1);
    });

    it('replace a guessed class, which passes them the number typed for it', async () => {
      smarttt.units['GEOL 210'] = { name: 'Rocks', rows: [] };
      const saved = body<{ board: Board }>(await math.post('/exam-list', { papers: [{ codes: ['GEOL 210'], title: 'Rocks', sitting: 'regular' }] })).data.board;
      const id = saved.papers.find((p) => p.codes === 'GEOL 210')!.id;
      await math.put(`/exam-papers/${id}/rows`, { rows: [{ programme: 'GEOL', year: 2, semester: 1, stream: '', students: 41 }] });

      smarttt.units['GEOL 210']!.rows = [row('BSC.GEOL', 2, 0), row('BSC.CHEM', 2, 0), row('GEOL.X', 2, 0)];
      const paper = body<Board>(await math.post('/exam-papers/recount')).data.papers.find((p) => p.id === id)!;
      expect(paper.students).toBe(41);
      expect(paper.rows.map((x) => [x.programme, x.students, x.edited])).toEqual([
        ['BSC.CHEM', 14, true], ['BSC.GEOL', 14, true], ['GEOL.X', 13, true],
      ]);
    });

    it('replace a guessed class outright when they have synced students', async () => {
      smarttt.units['GEOL 220'] = { name: 'Maps', rows: [] };
      const saved = body<{ board: Board }>(await math.post('/exam-list', { papers: [{ codes: ['GEOL 220'], title: 'Maps', sitting: 'regular' }] })).data.board;
      const id = saved.papers.find((p) => p.codes === 'GEOL 220')!.id;
      await math.put(`/exam-papers/${id}/rows`, { rows: [{ programme: 'GEOL', year: 2, semester: 1, stream: '', students: 41 }] });
      smarttt.units['GEOL 220']!.rows = [row('BSC.GEOL', 2, 30)];
      const paper = body<Board>(await math.post('/exam-papers/recount')).data.papers.find((p) => p.id === id)!;
      expect(paper.rows.map((x) => [x.programme, x.students])).toEqual([['BSC.GEOL', 30]]);
    });
  });
});

describe("a letter's headings name classes and their numbers", () => {
  const NAMED = [
    ['', 'BACHELOR OF SCIENCE NURSING (SEPTEMBER 2026 INTAKE) Y1S1 (107 STUDENTS) MISHECK 0793315005', ''],
    ['1', 'NURS 111', 'Anatomy'],
    ['2', 'NURS 112', 'Physiology'],
    ['', 'BSc Health Records (Sep 2025) (14 students)', ''],
    ['3', 'HRIM 111', 'Records'],
    ['4', 'NURS 112', 'Physiology'],
    ['', 'SERVICING UNITS', ''],
    ['5', 'BOTA 473', 'Plant Biochemistry'],
  ];
  const nursing = { programme: 'BSC.NURS', year: 1, semester: 1, students: 107 };
  let health: Api;
  const paper = (board: Board, code: string) => board.papers.find((p) => p.codes === code)!;
  const shown = (board: Board, code: string) => paper(board, code).rows.filter((r) => r.students > 0).map((r) => [r.programme, r.stream, r.students]);

  it('reads a heading as a class, whatever else it says', async () => {
    const { classOf } = await import('../../src/modules/teaching/exam-list.read.js');
    expect(classOf('BACHELOR OF SCIENCE NURSING (SEPTEMBER 2026 INTAKE) Y1S1 (107 STUDENTS) MISHECK 0793315005')).toEqual({ name: 'BACHELOR OF SCIENCE NURSING', year: 1, semester: 1, students: 107 });
    expect(classOf('Basic Science: BSc Medical Biochemistry YEAR 3 SEMESTER 1 GSS (2 STUDENTS)')).toEqual({ name: 'BSc Medical Biochemistry', year: 3, semester: 1, students: 2 });
    expect(classOf('BSC ENVIRONMENTAL SCIENCE Y1S1 2026 INTAKE 3 STUDENTS SSP')?.students).toBe(3);
    expect(classOf('BSc Records (Sep 2026) (14 students)')).toEqual({ name: 'BSc Records', year: null, semester: null, students: 14 });
    expect(classOf('BSc Nursing Y2S1')?.students).toBeNull();
    expect(classOf('BSc Nursing Y2S1 (0 students)')?.students).toBeNull();
    for (const h of ['SERVICING UNITS', 'CERTIFICATE IN ANIMAL HEALTH', 'ODEL/PART-TIME DRAFTS']) expect(classOf(h)).toBeNull();
  });

  it("lists the letter's classes matched to programmes, stores nothing, and a paper sits every class naming it", async () => {
    health = await makeOfficer(await makeDepartment('Nursing', 'DNUR'));
    const res = await health.post('/exam-list/read', { file: await letter(NAMED) });
    const data = body<Review & { classes: Array<{ id: string; programme: string; year: number | null; semester: number | null; students: number; name: string }>; programmes: unknown[] }>(res).data;
    expect(data.programmes).toHaveLength(3);
    expect(data.classes.map((c) => [c.programme, c.year, c.semester, c.students])).toEqual([['BSC.NURS', 1, 1, 107], ['BSC.HRIM', 2, 1, 14]]); // year and semester from the timetable
    const lines = data.entries as unknown as Array<{ codes: string[]; letterClasses: string[] }>;
    expect(lines.find((e) => e.codes[0] === 'NURS 112')!.letterClasses).toHaveLength(2);
    expect(lines.find((e) => e.codes[0] === 'BOTA 473')!.letterClasses).toEqual([]);
    expect(body<Board>(await health.get('/exams')).data.papers).toHaveLength(0);
  });

  it('a first upload that read no numbers is overwritten by the second, a typed number too, and SMARTTT keeps out', async () => {
    const save = (papers: object[]) => health.post('/exam-list', { papers });
    await save([{ codes: ['NURS 111'], title: 'Anatomy', sitting: 'regular' }, { codes: ['NURS 113'], title: 'Biochemistry', sitting: 'regular' }]);
    let board = body<Board>(await health.get('/exams')).data;
    expect(paper(board, 'NURS 111').students).toBe(25);
    await health.put(`/exam-papers/${paper(board, 'NURS 113').id}/rows`, { rows: [{ programme: 'BSC.NURS', year: 1, semester: 1, stream: '', students: 60 }] });

    const res = await save([
      { codes: ['NURS 111'], title: 'Anatomy', sitting: 'regular', classes: [nursing] },
      { codes: ['NURS 113'], title: 'Biochemistry', sitting: 'regular', classes: [nursing] },
    ]);
    expect(body<{ updated: number }>(res).data.updated).toBe(2);
    board = body<Board>(await health.get('/exams')).data;
    expect(shown(board, 'NURS 111')).toEqual([['BSC.NURS', '', 107]]); // not 107 + the streams' 25
    expect(paper(board, 'NURS 111').students).toBe(107);
    expect(paper(board, 'NURS 113').students).toBe(107);

    board = body<Board>(await health.post('/exam-papers/recount')).data;
    expect(paper(board, 'NURS 111').students).toBe(107);
  });

  it('a class the letter gives no number for keeps what it has, and can be entered by hand', async () => {
    const save = (classes?: object[]) => health.post('/exam-list', { papers: [{ codes: ['HRIM 111'], title: 'Records', sitting: 'regular', ...(classes ? { classes } : {}) }] });
    await save();
    let board = body<Board>(await health.get('/exams')).data;
    const id = paper(board, 'HRIM 111').id;
    expect(paper(board, 'HRIM 111').students).toBe(3);
    await health.put(`/exam-papers/${id}/rows`, { rows: [{ programme: 'BSC.HRIM', year: 2, semester: 1, stream: '', students: 12 }, { programme: 'BSC.X', year: 1, semester: 1, stream: '', students: 4 }] });
    await save();
    board = body<Board>(await health.get('/exams')).data;
    expect(paper(board, 'HRIM 111').students).toBe(16);
    // A number for one class leaves the other class alone.
    await save([{ programme: 'BSC.HRIM', year: 2, semester: 1, students: 14 }]);
    board = body<Board>(await health.get('/exams')).data;
    expect(shown(board, 'HRIM 111')).toEqual(expect.arrayContaining([['BSC.HRIM', '', 14], ['BSC.X', '', 4]]));
    expect(paper(board, 'HRIM 111').students).toBe(18);
  });

  it('adds a class SMARTTT has no row for, keeps an ODEL class apart, and works with SMARTTT down', async () => {
    const res = await health.post('/exam-list', { papers: [{ codes: ['NURS 112'], title: 'Physiology', sitting: 'regular', classes: [nursing, { programme: 'BSC.HRIM', year: 2, semester: 1, students: 14 }] }] });
    expect(res.status).toBeLessThan(300);
    let board = body<Board>(await health.get('/exams')).data;
    expect(paper(board, 'NURS 112').students).toBe(121);
    await health.post('/exam-list', { papers: [{ codes: ['NURS 112'], title: 'Physiology', sitting: 'odel', classes: [{ ...nursing, students: 9 }] }] });
    board = body<Board>(await health.get('/exams')).data;
    const odel = board.papers.find((p) => p.codes === 'NURS 112' && p.sitting === 'odel')!;
    expect(odel.rows.map((r) => [r.stream, r.students])).toEqual([['ODEL', 9]]);
    smarttt.down = true;
    await health.post('/exam-list', { papers: [{ codes: ['NURS 112'], title: 'Physiology', sitting: 'regular', classes: [{ ...nursing, students: 110 }] }] });
    board = body<Board>(await health.get('/exams')).data;
    expect(board.papers.find((p) => p.codes === 'NURS 112' && p.sitting === 'regular')!.students).toBe(124);
  });

  it('refuses a class with no programme or no students', async () => {
    const bad = (c: object) => health.post('/exam-list', { papers: [{ codes: ['NURS 111'], title: 'Anatomy', sitting: 'regular', classes: [c] }] });
    expect((await bad({ programme: '', year: 1, semester: 1, students: 5 })).status).toBe(400);
    expect((await bad({ programme: 'X', year: 1, semester: 1, students: 0 })).status).toBe(400);
  });
});


describe('a unit listed twice, and a letter changed to ODEL', () => {
  let bot: Api;
  type Entry = Review['entries'][number];
  const read = async (rows: string[][]) => {
    const res = await bot.post('/exam-list/read', { file: await letter([['S.NO', 'UNIT CODE', 'UNIT TITLE'], ...rows]) });
    expect(res.status).toBe(200);
    return body<Review & { entries: Entry[]; summary: Review['summary'] & { secondListings: number; toOdel: number } }>(res).data;
  };
  const saved = (r: { entries: Entry[] }) =>
    r.entries
      .filter((e) => e.duplicateOf === null)
      .map((e) => ({ codes: e.codes, title: e.title, sitting: e.sitting, ...(e.switchesPaperId ? { replacesPaperId: e.switchesPaperId } : {}) }));

  beforeAll(async () => {
    bot = await makeOfficer(await makeDepartment('Plant Sciences', 'DPLS'));
  });

  it('takes the second listing as the ODEL paper and a third as a duplicate', async () => {
    const r = await read([
      ['1', 'BOTA 473', 'Plant Biochemistry'],
      ['2', 'HRIM 111', 'Records'],
      ['3', 'BOTA 473', 'Plant Biochemistry'],
      ['4', 'BOTA 473', 'Plant Biochemistry'],
    ]);
    expect(r.entries.map((e) => [e.line, e.sitting, e.secondListingOf, e.duplicateOf])).toEqual([
      [1, 'regular', null, null],
      [2, 'regular', null, null],
      [3, 'odel', 1, null],
      [4, 'regular', null, 1],
    ]);
    expect(r.summary).toMatchObject({ papers: 3, duplicates: 1, secondListings: 1, toOdel: 0 });
  });

  it('keeps one paper when a listing is under a class heading, as in a course allocation', async () => {
    const r = await read([
      ['', 'BSc Plant Science Y4S1 (30 students)', ''],
      ['1', 'BOTA 473', 'Plant Biochemistry'],
      ['', 'SERVICING UNITS', ''],
      ['2', 'BOTA 473', 'Plant Biochemistry'],
    ]);
    expect(r.entries.map((e) => [e.sitting, e.secondListingOf, e.duplicateOf])).toEqual([['regular', null, null], ['regular', null, 1]]);
  });

  it('reads ODEL in a title as the ODEL paper', async () => {
    const r = await read([['1', 'HRIM 111', 'Records'], ['2', 'HRIM 111', 'Records ODEL'], ['3', 'BOTA 473', 'Plant Biochemistry-Odel']]);
    expect(r.entries.map((e) => [e.sitting, e.secondListingOf])).toEqual([['regular', null], ['odel', null], ['odel', null]]);
  });

  it('switches a regular paper to ODEL when the letter now lists it only as ODEL, keeping the paper', async () => {
    const first = await bot.post('/exam-list', { papers: [{ codes: ['BOTA 473'], title: 'Plant Biochemistry', sitting: 'regular' }] });
    expect(first.status).toBe(200);
    const before = body<{ board: Board }>(first).data.board.papers.find((p) => p.codes === 'BOTA 473')!;
    const examiner = body<{ id: string }>(await bot.post('/lecturers', { title: 'Dr.', fullName: 'Jane Mbae', staffNumber: 'STF/0777' })).data.id;
    expect((await bot.post('/exam-list', { papers: [{ codes: ['BOTA 473'], title: 'Plant Biochemistry', sitting: 'regular', examinerId: examiner }] })).status).toBe(200);

    const r = await read([['', 'ODEL / PART-TIME DRAFTS', ''], ['1', 'BOTA 473', 'Plant Biochemistry']]);
    expect(r.entries[0]).toMatchObject({ sitting: 'odel', existingPaperId: null, switchesPaperId: before.id });
    expect(r.summary).toMatchObject({ newPapers: 1, toOdel: 1 });
    const res = await bot.post('/exam-list', { papers: saved(r) });
    expect(res.status).toBe(200);
    const data = body<{ created: number; updated: number; switched: number; board: Board }>(res).data;
    expect([data.created, data.updated, data.switched]).toEqual([0, 0, 1]);
    const bota = data.board.papers.filter((p) => p.codes === 'BOTA 473');
    expect(bota).toHaveLength(1);
    expect(bota[0]).toMatchObject({ id: before.id, sitting: 'odel', examinerId: examiner });
    // Read again, it's the ODEL paper already there: nothing more to switch.
    expect((await read([['1', 'BOTA 473 odel', 'Plant Biochemistry']])).entries[0]).toMatchObject({ existingPaperId: before.id, switchesPaperId: null });
  });

  it("adds the ODEL paper a letter's second listing gives, leaving the regular paper as it was", async () => {
    await bot.post('/exam-list', { papers: [{ codes: ['HRIM 111'], title: 'Records', sitting: 'regular' }] });
    const regular = body<Board>(await bot.get('/exams')).data.papers.find((p) => p.codes === 'HRIM 111' && p.sitting === 'regular')!;
    const r = await read([['1', 'HRIM 111', 'Records'], ['2', 'HRIM 111', 'Records']]);
    expect(r.entries.map((e) => [e.sitting, e.existingPaperId, e.switchesPaperId])).toEqual([
      ['regular', regular.id, null],
      ['odel', null, null],
    ]);
    const data = body<{ created: number; updated: number; switched: number; board: Board }>(await bot.post('/exam-list', { papers: saved(r) })).data;
    expect([data.created, data.updated, data.switched]).toEqual([1, 1, 0]);
    const hrim = data.board.papers.filter((p) => p.codes === 'HRIM 111').map((p) => [p.id === regular.id, p.sitting]);
    expect(hrim.sort()).toEqual([[false, 'odel'], [true, 'regular']]);
  });

  it('refuses to switch a paper that is also listed as regular, or one not on the list', async () => {
    const regular = body<Board>(await bot.get('/exams')).data.papers.find((p) => p.codes === 'HRIM 111' && p.sitting === 'regular')!;
    const both = await bot.post('/exam-list', {
      papers: [
        { codes: ['HRIM 111'], title: 'Records', sitting: 'regular' },
        { codes: ['HRIM 111'], title: 'Records', sitting: 'odel', replacesPaperId: regular.id },
      ],
    });
    expect(both.status).toBe(422);
    expect(body(both).error!.message).toMatch(/also listed as a regular paper/);
    const unknown = await bot.post('/exam-list', { papers: [{ codes: ['MATH 446'], title: 'X', sitting: 'odel', replacesPaperId: randomUUID() }] });
    expect(unknown.status).toBe(422);
  });
});

describe("the Director uploads a department's letter on the Generator", () => {
  let director: string;
  let records: Api;
  const generator = (path: string, data: object, key = 'generator-key') =>
    request(app).post(`/api/v1/integrations/generator/terms/${TERM}${path}`).set('X-API-Key', key).send(data);

  beforeAll(async () => {
    records = await makeOfficer(await makeDepartment('Health Records', 'DHRM'));
    const { rows: [u] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
       VALUES ('director@uni.ac.ke', 'x', 'Dee Director', 'TIMETABLING', 'ACTIVE', NOW()) RETURNING id`);
    director = u!.id;
  });

  it('reads the letter with the same review a department gets, storing nothing', async () => {
    const file = await letter([['S.NO', 'UNIT CODE', 'UNIT TITLE'], ['1', 'HRIM 111', 'Records'], ['2', 'HRIM 111', 'Records again']]);
    expect((await generator('/exam-list/read', { account_id: director, department_code: 'DHRM', file }, 'wrong')).status).toBe(401);
    expect((await generator('/exam-list/read', { account_id: director, department_code: 'NOPE', file })).status).toBe(404);
    const res = await generator('/exam-list/read', { account_id: director, department_code: 'dhrm', file });
    expect(res.status).toBe(200);
    const r = body<Review>(res).data;
    // The same rules as a department's upload: a unit listed twice is its ODEL paper (secondListingOf).
    expect(r.entries.map((e) => [e.codes.join('/'), e.sitting, e.secondListingOf])).toEqual([['HRIM 111', 'regular', null], ['HRIM 111', 'odel', 1]]);
    expect(body<Board>(await records.get('/exams')).data.papers).toEqual([]);
  });

  it("saves into the department's list and publishes it, so the Generator imports it", async () => {
    const res = await generator('/exam-list', { account_id: director, department_code: 'DHRM', papers: [{ codes: ['HRIM 111'], title: 'Records', sitting: 'regular' }] });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ created: 1, updated: 0, published: 1 });
    const own = body<Board>(await records.get('/exams')).data;
    expect(own.published).toBe(true);
    expect(own.papers.map((p) => [p.codes, p.listed, p.students])).toEqual([['HRIM 111', true, 3]]);
    const exams = body<{ published: Array<{ code: string; papers: Array<{ codes: string[] }> }> }>(
      await request(app).get(`/api/v1/integrations/generator/terms/${TERM}/exams`).set('X-API-Key', 'generator-key')).data;
    expect(exams.published.find((d) => d.code === 'DHRM')!.papers.map((p) => p.codes)).toEqual([['HRIM 111']]);
  });

  it('works on a published list too, where the department itself must reopen first', async () => {
    expect((await records.post('/exam-list', { papers: [{ codes: ['HRIM 111'], title: 'Health Records', sitting: 'regular' }] })).status).toBe(409);
    const res = await generator('/exam-list', { account_id: director, department_code: 'DHRM', papers: [{ codes: ['HRIM 111'], title: 'Health Records', sitting: 'regular' }] });
    expect(body(res).data).toMatchObject({ created: 0, updated: 1, published: 1 });
    const own = body<Board & { publication: { publishedBy?: string; name?: string } | null }>(await records.get('/exams')).data;
    expect(own.papers[0]!.title).toBe('Health Records');
    expect(JSON.stringify(own.publication)).toContain('Dee Director');
  });
});

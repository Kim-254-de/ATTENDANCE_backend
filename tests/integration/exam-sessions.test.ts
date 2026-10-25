import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Exam sessions against a real Postgres database: SMARTTT pushes the term's
 * exam rooms and its mode, invigilators open their rooms, students check in
 * only where they are seated, and teaching classes are refused in exam mode.
 */
const TEST_DB = 'attendance_exam_sessions_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const KEY = 'smarttt-exam-key';
process.env.SMARTTT_API_KEY = KEY;

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string; details?: Record<string, unknown> } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

async function makeUser(role: 'LECTURER' | 'STUDENT') {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`exam-${role.toLowerCase()}${n}@uni.ac.ke`, `${role} ${n}`, role]);
  const code = role === 'LECTURER' ? `STF/E${n}` : `SCT211-${String(n).padStart(4, '0')}/2022`;
  if (role === 'LECTURER') {
    await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, code]);
  } else {
    await pool.query(
      `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at) VALUES ($1, $2, 'ERP', NOW())`,
      [u!.id, code]);
  }
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, code, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

type User = Awaited<ReturnType<typeof makeUser>>;

/** Today on campus, as SMARTTT dates its papers. */
const campusToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
const campusTomorrow = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date(Date.now() + 86_400_000));

const push = (data: object, key = KEY) =>
  request(app).post('/api/v1/integrations/smarttt/exam-sessions').set('X-API-Key', key).send(data);
const mode = (data: object) => request(app).post('/api/v1/integrations/smarttt/term-mode').set('X-API-Key', KEY).send(data);
const as = (u: User) => ({
  get: (path: string) => request(app).get(`/api/v1/exams${path}`).set('Authorization', u.auth),
  post: (path: string, data: object = {}) => request(app).post(`/api/v1/exams${path}`).set('Authorization', u.auth).send(data),
});

let main: User;
let extra: User;
let other: User;
let inLh1: User;
let inLh2: User;
let outsider: User;

function session(room: string, invigilator: User, role: 'main' | 'extra', regs: string[], date = campusToday()) {
  return {
    key: `COSC 130|${room}|${date}`,
    paper_key: `COSC 130|${date}`,
    unit_codes: ['COSC 130'],
    title: 'Programming',
    date,
    start_time: '00:00',
    end_time: '23:59',
    room,
    candidates: [],
    registration_numbers: regs,
    invigilator_staff_number: invigilator.code,
    role,
    main_invigilator_staff_number: main.code,
  };
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
  main = await makeUser('LECTURER');
  extra = await makeUser('LECTURER');
  other = await makeUser('LECTURER');
  inLh1 = await makeUser('STUDENT');
  inLh2 = await makeUser('STUDENT');
  outsider = await makeUser('STUDENT');
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

describe('SMARTTT pushes', () => {
  it('refuses a wrong or missing key', async () => {
    expect((await push({ term_id: '1', version: 1, sessions: [] }, 'wrong')).status).toBe(401);
    expect((await request(app).post('/api/v1/integrations/smarttt/term-mode').send({ term_id: '1', mode: 'exams' })).status).toBe(401);
  });

  it('stores the term’s exam rooms, and withdraws rooms gone from the next version', async () => {
    const first = await push({
      term_id: '1',
      version: 1,
      sessions: [session('LH1', main, 'main', [inLh1.code.toLowerCase()]), session('LH2', extra, 'extra', [inLh2.code]), session('LH3', other, 'extra', [])],
    });
    expect(first.status).toBe(200);
    expect(body(first).data).toEqual({ upserted: 3, withdrawn: 0 });
    const second = await push({
      term_id: '1',
      version: 2,
      sessions: [session('LH1', main, 'main', [inLh1.code]), session('LH2', extra, 'extra', [inLh2.code])],
    });
    expect(body(second).data).toEqual({ upserted: 2, withdrawn: 1 });
    expect(body<unknown[]>(await as(other).get('/sessions/mine')).data).toEqual([]);
    const mine = body<Array<{ room: string; role: string; candidates: number }>>(await as(main).get('/sessions/mine')).data;
    expect(mine).toMatchObject([{ room: 'LH1', role: 'main', candidates: 1 }]);
  });
});

describe('exam rooms', () => {
  const idOf = async (u: User) => body<Array<{ id: string }>>(await as(u).get('/sessions/mine')).data[0]!.id;

  it('opens only for its own invigilator', async () => {
    const lh1 = await idOf(main);
    expect((await as(extra).post(`/sessions/${lh1}/open`, { geofence: 'OFF' })).status).toBe(403);
    const opened = await as(main).post(`/sessions/${lh1}/open`, { geofence: 'OFF' });
    expect(opened.status).toBe(200);
    expect(body(opened).data).toMatchObject({ status: 'OPEN', geofence: 'OFF' });
  });

  it('can’t be opened outside its slot', async () => {
    await push({
      term_id: '2',
      version: 1,
      sessions: [session('LH9', other, 'main', [], campusTomorrow())],
    });
    const id = await idOf(other);
    const res = await as(other).post(`/sessions/${id}/open`, { geofence: 'OFF' });
    expect(res.status).toBe(403);
  });

  it('checks a student in to their own room only, naming the right one', async () => {
    const lh1 = await idOf(main);
    const lh2 = await idOf(extra);
    await as(extra).post(`/sessions/${lh2}/open`, { geofence: 'OFF' });
    const code = body<{ payload: string }>(await as(main).get(`/sessions/${lh1}/code`)).data.payload;

    const wrong = await as(inLh2).post('/check-in', { payload: code });
    expect(wrong.status).toBe(403);
    expect(body(wrong).error).toMatchObject({ code: 'EXAM_WRONG_ROOM', details: { room: 'LH2' } });

    const stranger = await as(outsider).post('/check-in', { payload: code });
    expect(body(stranger).error?.code).toBe('EXAM_NOT_CANDIDATE');

    const ok = await as(inLh1).post('/check-in', { payload: code });
    expect(ok.status).toBe(200);
    expect(body(ok).data).toMatchObject({ room: 'LH1', checkedIn: true });
    expect((await as(inLh1).post('/check-in', { payload: code })).status).toBe(409);
  });

  it('reports one room to its invigilator and every room to the main one', async () => {
    const lh1 = await idOf(main);
    const lh2 = await idOf(extra);
    const own = body<{ rooms: Array<{ room: string; sat: string[]; absent: string[] }> }>(await as(extra).get(`/sessions/${lh2}/report`)).data;
    expect(own.rooms).toEqual([{ room: 'LH2', role: 'extra', sat: [], absent: [inLh2.code] }]);
    const all = body<{ rooms: Array<{ room: string; sat: string[]; absent: string[] }> }>(await as(main).get(`/sessions/${lh1}/report`)).data;
    expect(all.rooms).toEqual([
      { room: 'LH1', role: 'main', sat: [inLh1.code], absent: [] },
      { room: 'LH2', role: 'extra', sat: [], absent: [inLh2.code] },
    ]);
    expect((await as(other).get(`/sessions/${lh1}/report`)).status).toBe(403);
  });

  it('stops taking check-ins once closed', async () => {
    const lh2 = await idOf(extra);
    const code = body<{ payload: string }>(await as(extra).get(`/sessions/${lh2}/code`)).data.payload;
    expect(body(await as(extra).post(`/sessions/${lh2}/close`)).data).toMatchObject({ status: 'CLOSED' });
    expect((await as(inLh2).post('/check-in', { payload: code })).status).toBe(409);
  });
});

describe('exam mode', () => {
  const openClass = (u: User) =>
    request(app).post('/api/v1/sessions').set('Authorization', u.auth).send({ unitId: randomUUID(), geofence: 'OFF' });

  it('refuses teaching classes while a term is in exam mode, and allows them once closed', async () => {
    expect(body(await openClass(main)).error?.code).not.toBe('EXAM_MODE');
    expect((await mode({ term_id: '1', mode: 'exams', switched_at: new Date().toISOString() })).status).toBe(200);
    const refused = await openClass(main);
    expect(refused.status).toBe(403);
    expect(body(refused).error?.code).toBe('EXAM_MODE');
    await mode({ term_id: '1', mode: 'teaching', closed_at: new Date().toISOString() });
    expect(body(await openClass(main)).error?.code).not.toBe('EXAM_MODE');
  });
});

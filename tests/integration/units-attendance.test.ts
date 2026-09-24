import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Units, allocations and check-in against a real Postgres database, with the
 * ERP's student records stubbed at the fetch boundary.
 */
const TEST_DB = 'attendance_units_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let linkAllocationsToStudent: (userId: string, reg: string) => Promise<number>;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

/** A signed-in user of either role, returned as a bearer token. */
async function makeUser(role: 'LECTURER' | 'STUDENT') {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${n}@uni.ac.ke`, `${role === 'LECTURER' ? 'Dr. Test' : 'Student'} ${n}`, role]);
  if (role === 'LECTURER') {
    await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, `STF/U${n}`]);
  }
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  const token = await signAccessToken({ userId: u!.id, sessionId, role });
  return { id: u!.id, auth: `Bearer ${token}` };
}

/** The ERP's student records, as far as these tests are concerned. */
const erpStudents: Record<string, { status: string; fullName: string } | 'DOWN'> = {
  'REG/001': { status: 'active', fullName: 'Ama Mensah' },
  'REG/002': { status: 'active', fullName: 'Kofi Boateng' },
  'REG/OLD': { status: 'graduated', fullName: 'Old Grad' },
};

function stubErp() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const reg = decodeURIComponent(url.split('/students/')[1] ?? '');
    const found = erpStudents[reg];
    if (found === 'DOWN') return Promise.resolve(new Response('down', { status: 503 }));
    if (!found) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(Response.json({ registrationNumber: reg, fullName: found.fullName, status: found.status }));
  });
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.ERP_MAX_RETRIES = '0';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  ({ linkAllocationsToStudent } = await import('../../src/modules/unit/index.js'));
});

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
  patch: (path: string, data?: object) => request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(data),
});

async function makeUnit(lecturer: { auth: string }, code = `TEST ${uniq()}`) {
  const res = await api(lecturer.auth).post('/units', { code, name: 'Testing Unit' });
  expect(res.status).toBe(201);
  return body<{ id: string; code: string }>(res).data;
}

describe('units', () => {
  it('lets a lecturer add a unit, normalising the code, and lists it with counts', async () => {
    const lecturer = await makeUser('LECTURER');
    const res = await api(lecturer.auth).post('/units', { code: '  cosc   100 ', name: 'Intro to Computing' });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ code: 'COSC 100', name: 'Intro to Computing', studentCount: 0, pendingCount: 0 });

    const list = await api(lecturer.auth).get('/units');
    expect(body<unknown[]>(list).data).toEqual([expect.objectContaining({ code: 'COSC 100' })]);
  });

  it('refuses a code already in use, saying whose it is', async () => {
    const a = await makeUser('LECTURER');
    const b = await makeUser('LECTURER');
    await makeUnit(a, 'DUPE 1');

    const again = await api(a.auth).post('/units', { code: 'dupe 1', name: 'Again' });
    expect(again.status).toBe(409);
    expect(body(again).error?.message).toMatch(/already added/);

    const other = await api(b.auth).post('/units', { code: 'DUPE 1', name: 'Mine' });
    expect(other.status).toBe(409);
    expect(body(other).error?.message).toMatch(/another lecturer/);
  });

  it('is lecturer-only, and a lecturer cannot see another lecturer\'s students', async () => {
    const student = await makeUser('STUDENT');
    expect((await api(student.auth).post('/units', { code: 'NOPE 1', name: 'x' })).status).toBe(403);

    const owner = await makeUser('LECTURER');
    const other = await makeUser('LECTURER');
    const unit = await makeUnit(owner);
    expect((await api(other.auth).get(`/units/${unit.id}/students`)).status).toBe(403);
  });
});

describe('allocating students by registration number', () => {
  it('verifies each number against the ERP and reports per-number results', async () => {
    stubErp();
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);

    const res = await api(lecturer.auth).post(`/units/${unit.id}/students`, {
      registrationNumbers: ['reg/001', 'REG/OLD', 'REG/404', 'REG/001'],
    });
    expect(res.status).toBe(200);
    expect(body<unknown[]>(res).data).toEqual([
      { registrationNumber: 'REG/001', status: 'ADDED', fullName: 'Ama Mensah' },
      { registrationNumber: 'REG/OLD', status: 'INACTIVE', fullName: 'Old Grad' },
      { registrationNumber: 'REG/404', status: 'NOT_FOUND', fullName: null },
    ]);

    const again = await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/001'] });
    expect(body<Array<{ status: string }>>(again).data[0]!.status).toBe('ALREADY_ALLOCATED');

    const students = body<Array<{ registrationNumber: string; status: string; hasAccount: boolean }>>(
      await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(students).toEqual([expect.objectContaining({ registrationNumber: 'REG/001', status: 'ACTIVE', hasAccount: false })]);
  });

  it('fails closed when the ERP is down', async () => {
    erpStudents['REG/DOWN'] = 'DOWN';
    stubErp();
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    const res = await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/DOWN'] });
    expect(body<Array<{ status: string }>>(res).data[0]!.status).toBe('UNAVAILABLE');
    expect(body<unknown[]>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data).toEqual([]);
  });

  it('restores a dropped student instead of duplicating them', async () => {
    stubErp();
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/002'] });
    const [allocation] = body<Array<{ id: string }>>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;

    const drop = await api(lecturer.auth).patch(`/units/${unit.id}/students/${allocation!.id}`, { status: 'DROPPED' });
    expect(body(drop).data).toMatchObject({ status: 'DROPPED' });

    const readd = await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/002'] });
    expect(body<Array<{ status: string }>>(readd).data[0]!.status).toBe('RESTORED');
    expect(body<unknown[]>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data).toHaveLength(1);
  });

  it('links lecturer-made allocations to a student account once one exists', async () => {
    stubErp();
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/001'] });
    const student = await makeUser('STUDENT');

    expect(await linkAllocationsToStudent(student.id, 'reg/001')).toBeGreaterThanOrEqual(1);
    const [row] = body<Array<{ hasAccount: boolean }>>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(row!.hasAccount).toBe(true);
  });
});

describe('self-enrolment and check-in', () => {
  async function openSession(lecturer: { auth: string }, unitId: string) {
    const res = await api(lecturer.auth).post('/sessions', {
      unitId, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(res.status).toBe(201);
    const sessionId = body<{ id: string }>(res).data.id;
    const qr = body<{ payload: string; checkedIn: number; enrolled: number }>(
      await api(lecturer.auth).get(`/sessions/${sessionId}/qr`)).data;
    return { sessionId, qr };
  }

  it('a request stays PENDING, and cannot check in, until the lecturer approves it', async () => {
    const lecturer = await makeUser('LECTURER');
    const student = await makeUser('STUDENT');
    const unit = await makeUnit(lecturer);

    const enrol = await api(student.auth).post('/units/enrol', { code: unit.code.toLowerCase() });
    expect(enrol.status).toBe(200);
    expect(body(enrol).data).toMatchObject({ unitId: unit.id, status: 'PENDING' });
    expect(body((await api(student.auth).post('/units/enrol', { code: unit.code }))).data).toMatchObject({ status: 'PENDING' });

    const { sessionId, qr } = await openSession(lecturer, unit.id);
    expect(qr).toMatchObject({ checkedIn: 0, enrolled: 0 });
    const early = await api(student.auth).post('/attendance/check-in', { payload: qr.payload });
    expect(early.status).toBe(403);

    const [pending] = body<Array<{ id: string; status: string }>>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(pending!.status).toBe('PENDING');
    await api(lecturer.auth).patch(`/units/${unit.id}/students/${pending!.id}`, { status: 'ACTIVE' });

    const checkIn = await api(student.auth).post('/attendance/check-in', { payload: qr.payload });
    expect(checkIn.status).toBe(201);
    expect(body(checkIn).data).toMatchObject({ sessionId, unitCode: unit.code });

    const twice = await api(student.auth).post('/attendance/check-in', { payload: qr.payload });
    expect(twice.status).toBe(409);

    const live = body<{ checkedIn: number; enrolled: number }>(await api(lecturer.auth).get(`/sessions/${sessionId}/qr`)).data;
    expect(live).toMatchObject({ checkedIn: 1, enrolled: 1 });

    const attendance = await api(lecturer.auth).get(`/attendance/sessions/${sessionId}`);
    const list = body<{ checkedIn: number; attendees: Array<{ studentUserId: string; fullName: string }> }>(attendance).data;
    expect(list.checkedIn).toBe(1);
    expect(list.attendees).toEqual([expect.objectContaining({ studentUserId: student.id })]);
    expect(list.attendees[0]!.fullName).toMatch(/^Student/);
  });

  it('only the session\'s lecturer sees its attendance, and lecturers cannot check in', async () => {
    const lecturer = await makeUser('LECTURER');
    const other = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    const { sessionId, qr } = await openSession(lecturer, unit.id);

    expect((await api(other.auth).get(`/attendance/sessions/${sessionId}`)).status).toBe(403);
    expect((await api(lecturer.auth).post('/attendance/check-in', { payload: qr.payload })).status).toBe(403);
  });

  it('a student the lecturer dropped cannot re-enrol themselves', async () => {
    const lecturer = await makeUser('LECTURER');
    const student = await makeUser('STUDENT');
    const unit = await makeUnit(lecturer);
    await api(student.auth).post('/units/enrol', { code: unit.code });
    const [row] = body<Array<{ id: string }>>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    await api(lecturer.auth).patch(`/units/${unit.id}/students/${row!.id}`, { status: 'DROPPED' });

    const res = await api(student.auth).post('/units/enrol', { code: unit.code });
    expect(res.status).toBe(403);
  });

  it('an unknown unit code is a 404', async () => {
    const student = await makeUser('STUDENT');
    expect((await api(student.auth).post('/units/enrol', { code: 'NO SUCH 1' })).status).toBe(404);
  });
});

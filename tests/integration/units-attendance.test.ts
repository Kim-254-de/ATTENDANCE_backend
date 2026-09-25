import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Units, allocations and check-in against a real Postgres database, with the
 * ERP's student and course (timetable) records stubbed at the fetch boundary.
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

/** A signed-in user of either role, returned as a bearer token; lecturers also get their ERP staff number. */
async function makeUser(role: 'LECTURER' | 'STUDENT') {
  const n = uniq();
  const staffNumber = role === 'LECTURER' ? `STF/U${n}` : null;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${n}@uni.ac.ke`, `${role === 'LECTURER' ? 'Dr. Test' : 'Student'} ${n}`, role]);
  if (staffNumber) {
    await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, staffNumber]);
  }
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  const token = await signAccessToken({ userId: u!.id, sessionId, role });
  return { id: u!.id, auth: `Bearer ${token}`, staffNumber };
}

/** The ERP's student directory, as far as these tests are concerned — used to fill in a roster's names. */
const erpStudents: Record<string, { status: string; fullName: string } | 'DOWN'> = {
  'REG/001': { status: 'active', fullName: 'Ama Mensah' },
  'REG/002': { status: 'active', fullName: 'Kofi Boateng' },
  'REG/OLD': { status: 'graduated', fullName: 'Old Grad' },
};

/**
 * The ERP's issued timetable, as far as these tests are concerned: any course
 * code is FOUND with today's all-day schedule (see SCHEDULE below) unless
 * listed here as DOWN or unassigned to nobody in particular ('' means
 * "not found on the timetable"). Keyed by normalised code; tests assign a
 * lecturer's staff number here to exercise the auto-verify path.
 */
const erpCourseStaff: Record<string, string | null | 'DOWN' | 'NOT_FOUND'> = {};

/**
 * Who the ERP currently enrols in each course — a unit's real roster, keyed
 * by normalised code. A course not listed here has an empty roster, same as
 * a course nobody's enrolled in yet; DOWN/NOT_FOUND simulate a sync failure.
 */
const erpEnrollments: Record<string, string[] | 'DOWN' | 'NOT_FOUND'> = {};

/** Stubs every ERP lookup the unit module makes: courses, their rosters, and the student directory. */
function stubErp() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('/courses/') && url.endsWith('/students')) {
      const code = decodeURIComponent(url.split('/courses/')[1]!.replace(/\/students$/, ''));
      const roster = erpEnrollments[code] ?? [];
      if (roster === 'DOWN') return Promise.resolve(new Response('down', { status: 503 }));
      if (roster === 'NOT_FOUND') return Promise.resolve(new Response('{}', { status: 404 }));
      const results = roster.map((reg) => {
        const found = erpStudents[reg];
        return { registrationNumber: reg, fullName: found && found !== 'DOWN' ? found.fullName : `Student ${reg}`, status: 'active' };
      });
      return Promise.resolve(Response.json({ count: results.length, results }));
    }
    if (url.includes('/courses/')) {
      const code = decodeURIComponent(url.split('/courses/')[1] ?? '');
      const assignment = code in erpCourseStaff ? erpCourseStaff[code] : null;
      if (assignment === 'DOWN') return Promise.resolve(new Response('down', { status: 503 }));
      if (assignment === 'NOT_FOUND') return Promise.resolve(new Response('{}', { status: 404 }));
      return Promise.resolve(Response.json({
        code, name: `${code} Course`, staffNumber: assignment,
        dayOfWeek: SCHEDULE.dayOfWeek, startTime: SCHEDULE.startTime, endTime: SCHEDULE.endTime, status: 'active',
      }));
    }
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

// Every unit creation now looks the code up against the ERP, so this must be
// live for every test, not just the ones about student allocation.
beforeEach(stubErp);
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

/**
 * Every unit needs an issued slot now, and session.service.ts only allows
 * activating a class inside it. Spanning today's whole day keeps tests free
 * to run at any time of day without tripping that gate.
 */
const SCHEDULE = { dayOfWeek: new Date().getDay(), startTime: '00:00', endTime: '23:59' };

/** A real admin verifies a unit before it can activate a class; these tests stand in for that. */
async function verifyUnit(unitId: string) {
  await pool.query(`UPDATE units SET status = 'VERIFIED' WHERE id = $1`, [unitId]);
}

async function makeUnit(lecturer: { auth: string }, code = `TEST ${uniq()}`) {
  const res = await api(lecturer.auth).post('/units', { code });
  expect(res.status).toBe(201);
  const unit = body<{ id: string; code: string }>(res).data;
  await verifyUnit(unit.id);
  return unit;
}

describe('units', () => {
  it('lets a lecturer add a unit by code, normalising it, with the name/schedule taken from the ERP', async () => {
    const lecturer = await makeUser('LECTURER');
    const res = await api(lecturer.auth).post('/units', { code: '  cosc   100 ' });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ code: 'COSC 100', name: 'COSC 100 Course', studentCount: 0, pendingCount: 0 });

    const list = await api(lecturer.auth).get('/units');
    expect(body<unknown[]>(list).data).toEqual([expect.objectContaining({ code: 'COSC 100' })]);
  });

  it('refuses a code that does not exist on the ERP timetable', async () => {
    const lecturer = await makeUser('LECTURER');
    erpCourseStaff['NO SUCH 1'] = 'NOT_FOUND';
    const res = await api(lecturer.auth).post('/units', { code: 'NO SUCH 1' });
    expect(res.status).toBe(404);
  });

  it('fails closed when the ERP timetable is unreachable', async () => {
    const lecturer = await makeUser('LECTURER');
    erpCourseStaff['DOWN 1'] = 'DOWN';
    const res = await api(lecturer.auth).post('/units', { code: 'DOWN 1' });
    expect(res.status).toBe(503);
  });

  it('is VERIFIED immediately when the ERP timetable already lists this lecturer, no admin involved', async () => {
    const lecturer = await makeUser('LECTURER');
    erpCourseStaff['AUTO 1'] = lecturer.staffNumber;
    const res = await api(lecturer.auth).post('/units', { code: 'AUTO 1' });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ status: 'VERIFIED' });

    // VERIFIED means usable at once — no dev:verify-unit step needed.
    const activate = await api(lecturer.auth).post('/sessions', {
      unitId: body<{ id: string }>(res).data.id, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(activate.status).toBe(201);
  });

  it('refuses a code already in use, saying whose it is', async () => {
    const a = await makeUser('LECTURER');
    const b = await makeUser('LECTURER');
    await makeUnit(a, 'DUPE 1');

    const again = await api(a.auth).post('/units', { code: 'dupe 1' });
    expect(again.status).toBe(409);
    expect(body(again).error?.message).toMatch(/already added/);

    const other = await api(b.auth).post('/units', { code: 'DUPE 1' });
    expect(other.status).toBe(409);
    expect(body(other).error?.message).toMatch(/another lecturer/);
  });

  it('is lecturer-only, and a lecturer cannot see another lecturer\'s students', async () => {
    const student = await makeUser('STUDENT');
    expect((await api(student.auth).post('/units', { code: 'NOPE 1' })).status).toBe(403);

    const owner = await makeUser('LECTURER');
    const other = await makeUser('LECTURER');
    const unit = await makeUnit(owner);
    expect((await api(other.auth).get(`/units/${unit.id}/students`)).status).toBe(403);
  });

  it('lands PENDING_VERIFICATION when the ERP timetable does not list this lecturer, and cannot activate a class until an admin verifies it', async () => {
    const lecturer = await makeUser('LECTURER');
    const created = await api(lecturer.auth).post('/units', { code: 'PEND 1' });
    expect(body(created).data).toMatchObject({ status: 'PENDING_VERIFICATION' });
    const unitId = body<{ id: string }>(created).data.id;

    const blocked = await api(lecturer.auth).post('/sessions', {
      unitId, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(blocked.status).toBe(403);

    await pool.query(`UPDATE units SET status = 'VERIFIED' WHERE id = $1`, [unitId]);

    const allowed = await api(lecturer.auth).post('/sessions', {
      unitId, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(allowed.status).toBe(201);
  });
});

describe('the roster, synced from the ERP', () => {
  it('reflects who the ERP enrols, with their real names, and is read-only to the lecturer', async () => {
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    erpEnrollments[unit.code] = ['REG/001', 'REG/002'];

    const students = body<Array<{ registrationNumber: string; fullName: string; status: string; source: string; hasAccount: boolean }>>(
      await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(students).toEqual([
      expect.objectContaining({ registrationNumber: 'REG/001', fullName: 'Ama Mensah', status: 'ACTIVE', source: 'ERP', hasAccount: false }),
      expect.objectContaining({ registrationNumber: 'REG/002', fullName: 'Kofi Boateng', status: 'ACTIVE', source: 'ERP' }),
    ]);

    // The endpoints a lecturer used to change the roster with are gone.
    expect((await api(lecturer.auth).post(`/units/${unit.id}/students`, { registrationNumbers: ['REG/001'] })).status).toBe(404);
    expect((await api(lecturer.auth).patch(`/units/${unit.id}/students/${randomUUID()}`, { status: 'DROPPED' })).status).toBe(404);
    expect((await api(lecturer.auth).post('/units/enrol', { code: unit.code })).status).toBe(404);
  });

  it('re-syncing does not duplicate anyone, and drops whoever the ERP no longer enrols', async () => {
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    erpEnrollments[unit.code] = ['REG/001', 'REG/002'];
    await api(lecturer.auth).get(`/units/${unit.id}/students`);

    erpEnrollments[unit.code] = ['REG/001'];
    const students = body<Array<{ registrationNumber: string; status: string }>>(
      await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(students).toHaveLength(2); // kept, not deleted — past attendance keeps its context
    expect(students.find((s) => s.registrationNumber === 'REG/001')!.status).toBe('ACTIVE');
    expect(students.find((s) => s.registrationNumber === 'REG/002')!.status).toBe('DROPPED');
  });

  it('fails soft: an ERP outage leaves the last-synced roster readable', async () => {
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    erpEnrollments[unit.code] = ['REG/001'];
    await api(lecturer.auth).get(`/units/${unit.id}/students`);

    erpEnrollments[unit.code] = 'DOWN';
    const res = await api(lecturer.auth).get(`/units/${unit.id}/students`);
    expect(res.status).toBe(200);
    expect(body<Array<{ registrationNumber: string; status: string }>>(res).data).toEqual([
      expect.objectContaining({ registrationNumber: 'REG/001', status: 'ACTIVE' }),
    ]);
  });

  it('links an ERP-synced allocation to a student account once one exists', async () => {
    const lecturer = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    erpEnrollments[unit.code] = ['REG/001'];
    await api(lecturer.auth).get(`/units/${unit.id}/students`);
    const student = await makeUser('STUDENT');

    expect(await linkAllocationsToStudent(student.id, 'reg/001')).toBeGreaterThanOrEqual(1);
    const [row] = body<Array<{ hasAccount: boolean }>>(await api(lecturer.auth).get(`/units/${unit.id}/students`)).data;
    expect(row!.hasAccount).toBe(true);
  });
});

describe('check-in', () => {
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

  /** What the ERP sync writes, without going through it — these tests are about check-in, not the sync. */
  async function allocate(unitId: string, studentUserId: string, status: 'ACTIVE' | 'DROPPED' = 'ACTIVE') {
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, student_user_id, registration_number, full_name, status, source)
       VALUES ($1, $2, $3, 'Test Student', $4, 'ERP')`,
      [unitId, studentUserId, `REG/A${uniq()}`, status],
    );
  }

  it('only a student the ERP puts on the unit can check in, once each', async () => {
    const lecturer = await makeUser('LECTURER');
    const student = await makeUser('STUDENT');
    const unit = await makeUnit(lecturer);

    const { sessionId, qr } = await openSession(lecturer, unit.id);
    expect(qr).toMatchObject({ checkedIn: 0, enrolled: 0 });

    // Not on the unit's roster: a structurally valid code still gets them nowhere.
    const early = await api(student.auth).post('/attendance/check-in', { payload: qr.payload });
    expect(early.status).toBe(403);

    await allocate(unit.id, student.id);

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

  it('a student the ERP no longer enrols (DROPPED) cannot check in', async () => {
    const lecturer = await makeUser('LECTURER');
    const student = await makeUser('STUDENT');
    const unit = await makeUnit(lecturer);
    await allocate(unit.id, student.id, 'DROPPED');

    const { qr } = await openSession(lecturer, unit.id);
    expect((await api(student.auth).post('/attendance/check-in', { payload: qr.payload })).status).toBe(403);
  });

  it('only the session\'s lecturer sees its attendance, and lecturers cannot check in', async () => {
    const lecturer = await makeUser('LECTURER');
    const other = await makeUser('LECTURER');
    const unit = await makeUnit(lecturer);
    const { sessionId, qr } = await openSession(lecturer, unit.id);

    expect((await api(other.auth).get(`/attendance/sessions/${sessionId}`)).status).toBe(403);
    expect((await api(lecturer.auth).post('/attendance/check-in', { payload: qr.payload })).status).toBe(403);
  });
});

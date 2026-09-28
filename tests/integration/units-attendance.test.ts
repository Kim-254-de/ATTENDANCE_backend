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
      unitId: body<{ id: string }>(res).data.id, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(), geofence: 'OFF',
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
      unitId, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(), geofence: 'OFF',
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
  // Geofence off: these tests are about who may check in, not from where (see 'geofence' below).
  async function openSession(lecturer: { auth: string }, unitId: string) {
    const res = await api(lecturer.auth).post('/sessions', {
      unitId, closesAt: new Date(Date.now() + 60 * 60_000).toISOString(), geofence: 'OFF',
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

  it('answers a QR code that is not ours with 400, not 500', async () => {
    const student = await makeUser('STUDENT');

    // Scanning the wrong thing is the ordinary case in a lecture hall. None of
    // these carry a UUID where the session id belongs, so each one used to reach
    // Postgres as a malformed uuid and come back a 500.
    const notOurs = [
      'https://example.com/menu',
      'v1.notauuid.123.abcd',
      'WIFI:S:campus;T:WPA;P:secret;;',
      'v1..123.abcd',
    ];

    for (const payload of notOurs) {
      const res = await api(student.auth).post('/attendance/check-in', { payload });
      expect(res.status, `payload: ${payload}`).toBe(400);
    }
  });
});

describe('geofence', () => {
  const LH = { latitude: -0.3703, longitude: 35.9322 };
  /** The lecturer's phone, a few metres from the room's surveyed point. */
  const PHONE = { latitude: -0.37035, longitude: 35.93225, accuracy: 12 };

  interface Geofence { mode: string; radiusMetres: number | null; roomCode: string | null; anchorAccuracyMetres: number | null; hasCentre: boolean }
  const fence = (res: request.Response) => body<{ geofence: Geofence }>(res).data.geofence;

  /** Puts the unit's slot in a room, surveyed or not. */
  async function placeInRoom(unitId: string, surveyed: boolean) {
    const code = `LH${uniq()}`;
    await pool.query(`UPDATE unit_schedule SET room_code = $2 WHERE unit_id = $1`, [unitId, code]);
    if (surveyed) {
      await pool.query(
        `INSERT INTO rooms (code, latitude, longitude, surveyed_accuracy_m, surveyed_at) VALUES ($1, $2, $3, 4, NOW())`,
        [code, LH.latitude, LH.longitude]);
    }
    return code;
  }

  const activate = (lecturer: { auth: string }, unitId: string, extra: object = {}) =>
    api(lecturer.auth).post('/sessions', { unitId, ...extra });

  const storedCentre = async (sessionId: string) => (await pool.query<{ geofence_mode: string; geofence_lat: number | null; geofence_lng: number | null }>(
    `SELECT geofence_mode, geofence_lat, geofence_lng FROM attendance_sessions WHERE id = $1`, [sessionId])).rows[0]!;

  const geofenceAudits = async (sessionId: string) => (await pool.query<{ user_id: string; metadata: Record<string, unknown> }>(
    `SELECT user_id, metadata FROM audit_logs
      WHERE action = 'ATTENDANCE_SESSION_GEOFENCE_CHANGED' AND metadata->>'sessionId' = $1 ORDER BY created_at`,
    [sessionId])).rows;

  describe('at activation', () => {
    it('is fenced to a surveyed room, whatever the lecturer\'s device says', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      const room = await placeInRoom(unit.id, true);

      const res = await activate(lecturer, unit.id, { location: { ...PHONE, accuracy: 25 } });
      expect(res.status).toBe(201);
      expect(fence(res)).toEqual({ mode: 'ROOM', radiusMetres: 20, roomCode: room, anchorAccuracyMetres: 4, hasCentre: true });
      const sessionId = body<{ id: string }>(res).data.id;
      expect(await storedCentre(sessionId)).toEqual({ geofence_mode: 'ROOM', geofence_lat: LH.latitude, geofence_lng: LH.longitude });

      // Also a surveyed room with no reading at all, e.g. activating from a laptop.
      const unit2 = await makeUnit(lecturer);
      await pool.query(`UPDATE unit_schedule SET room_code = $2 WHERE unit_id = $1`, [unit2.id, room]);
      expect(fence(await activate(lecturer, unit2.id))).toMatchObject({ mode: 'ROOM' });
    });

    it('falls back to the lecturer\'s device in an unsurveyed room', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      const room = await placeInRoom(unit.id, false);

      const res = await activate(lecturer, unit.id, { location: PHONE });
      expect(res.status).toBe(201);
      expect(fence(res)).toEqual({ mode: 'LECTURER_DEVICE', radiusMetres: 20, roomCode: room, anchorAccuracyMetres: 12, hasCentre: true });
      expect(await storedCentre(body<{ id: string }>(res).data.id)).toMatchObject({ geofence_lat: PHONE.latitude, geofence_lng: PHONE.longitude });
    });

    it('refuses to activate when the lecturer\'s reading is too vague, and opens nothing', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      await placeInRoom(unit.id, false);

      const res = await activate(lecturer, unit.id, { location: { ...PHONE, accuracy: 45 } });
      expect(res.status).toBe(422);
      expect(body(res).error).toMatchObject({ code: 'GEOFENCE_ANCHOR_UNAVAILABLE' });
      expect(body(res).error!.message).toMatch(/about 45 m.*phone.*geofence off/);
      expect((res.body as { error: { details: unknown } }).error.details)
        .toEqual({ reason: 'TOO_IMPRECISE', accuracyMetres: 45, maxAccuracyMetres: 30 });

      const { rows } = await pool.query(`SELECT 1 FROM attendance_sessions WHERE unit_id = $1`, [unit.id]);
      expect(rows).toHaveLength(0);
    });

    it('refuses to activate with no room and no reading', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);

      const res = await activate(lecturer, unit.id);
      expect(res.status).toBe(422);
      expect(body(res).error).toMatchObject({ code: 'GEOFENCE_ANCHOR_UNAVAILABLE' });
    });

    it('lets the lecturer switch the fence off, and still keeps a centre for later when there is one', async () => {
      const lecturer = await makeUser('LECTURER');
      const bare = await makeUnit(lecturer);
      const off = await activate(lecturer, bare.id, { geofence: 'OFF' });
      expect(off.status).toBe(201);
      expect(fence(off)).toEqual({ mode: 'OFF', radiusMetres: null, roomCode: null, anchorAccuracyMetres: null, hasCentre: false });

      const surveyed = await makeUnit(lecturer);
      await placeInRoom(surveyed.id, true);
      expect(fence(await activate(lecturer, surveyed.id, { geofence: 'OFF' }))).toMatchObject({ mode: 'OFF', hasCentre: true, radiusMetres: 20 });
    });

    it('rejects a malformed reading', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      for (const location of [{ ...PHONE, latitude: 91 }, { ...PHONE, accuracy: -1 }, { latitude: 0, longitude: 0 }, { ...PHONE, altitude: 3 }]) {
        expect((await activate(lecturer, unit.id, { location })).status).toBe(400);
      }
      expect((await activate(lecturer, unit.id, { geofence: 'MAYBE' })).status).toBe(400);
    });

    it('shows the fence on the live code', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      const room = await placeInRoom(unit.id, true);
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id)).data.id;

      const qr = await api(lecturer.auth).get(`/sessions/${sessionId}/qr`);
      expect(body<{ session: { geofence: Geofence } }>(qr).data.session.geofence)
        .toEqual({ mode: 'ROOM', radiusMetres: 20, roomCode: room, anchorAccuracyMetres: 4, hasCentre: true });
    });
  });

  describe('PATCH /sessions/:id/geofence', () => {
    async function deviceSession() {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      await placeInRoom(unit.id, false);
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id, { location: PHONE })).data.id;
      const patch = (data: object, who = lecturer) => api(who.auth).patch(`/sessions/${sessionId}/geofence`, data);
      return { lecturer, unit, sessionId, patch };
    }

    it('switches off and back on, reusing the centre, and audits each change with the lecturer', async () => {
      const { lecturer, sessionId, patch } = await deviceSession();

      const off = await patch({ mode: 'OFF' });
      expect(off.status).toBe(200);
      expect(fence(off)).toMatchObject({ mode: 'OFF', hasCentre: true });
      expect(await storedCentre(sessionId)).toMatchObject({ geofence_mode: 'OFF', geofence_lat: PHONE.latitude });

      // Already off: nothing to change, nothing audited.
      expect((await patch({ mode: 'OFF' })).status).toBe(200);

      const on = await patch({ mode: 'ON' });
      expect(on.status).toBe(200);
      expect(fence(on)).toMatchObject({ mode: 'LECTURER_DEVICE', anchorAccuracyMetres: 12 });
      expect(await storedCentre(sessionId)).toMatchObject({ geofence_lat: PHONE.latitude, geofence_lng: PHONE.longitude });

      const audits = await geofenceAudits(sessionId);
      expect(audits.map((a) => [a.user_id, a.metadata['from'], a.metadata['to'], a.metadata['recaptured']])).toEqual([
        [lecturer.id, 'LECTURER_DEVICE', 'OFF', false],
        [lecturer.id, 'OFF', 'LECTURER_DEVICE', false],
      ]);
    });

    it('re-captures the lecturer\'s position, but never with a vague reading', async () => {
      const { sessionId, patch } = await deviceSession();
      const moved = { latitude: -0.3710, longitude: 35.9330, accuracy: 6 };

      const res = await patch({ mode: 'ON', location: moved });
      expect(res.status).toBe(200);
      expect(fence(res)).toMatchObject({ mode: 'LECTURER_DEVICE', anchorAccuracyMetres: 6 });
      expect(await storedCentre(sessionId)).toMatchObject({ geofence_lat: moved.latitude, geofence_lng: moved.longitude });
      expect((await geofenceAudits(sessionId)).at(-1)!.metadata).toMatchObject({ recaptured: true });

      const vague = await patch({ mode: 'ON', location: { ...moved, latitude: -0.5, accuracy: 80 } });
      expect(vague.status).toBe(422);
      expect(body(vague).error).toMatchObject({ code: 'GEOFENCE_ANCHOR_UNAVAILABLE' });
      expect(await storedCentre(sessionId)).toMatchObject({ geofence_lat: moved.latitude }); // unchanged
    });

    it('keeps a surveyed room\'s centre: a lecturer cannot move the fence off it', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      await placeInRoom(unit.id, true);
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id)).data.id;

      const res = await api(lecturer.auth).patch(`/sessions/${sessionId}/geofence`, {
        mode: 'ON', location: { latitude: -1.28, longitude: 36.82, accuracy: 5 },
      });
      expect(fence(res)).toMatchObject({ mode: 'ROOM' });
      expect(await storedCentre(sessionId)).toMatchObject({ geofence_lat: LH.latitude, geofence_lng: LH.longitude });
    });

    it('cannot switch on a session that never had a centre without a reading', async () => {
      const lecturer = await makeUser('LECTURER');
      const unit = await makeUnit(lecturer);
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id, { geofence: 'OFF' })).data.id;
      const patch = (data: object) => api(lecturer.auth).patch(`/sessions/${sessionId}/geofence`, data);

      expect((await patch({ mode: 'ON' })).status).toBe(422);
      const on = await patch({ mode: 'ON', location: PHONE });
      expect(on.status).toBe(200);
      expect(fence(on)).toMatchObject({ mode: 'LECTURER_DEVICE', radiusMetres: 20 });
    });

    it('is the session lecturer\'s alone, and not after the class is closed', async () => {
      const { sessionId, patch } = await deviceSession();
      const other = await makeUser('LECTURER');
      const student = await makeUser('STUDENT');

      expect((await patch({ mode: 'OFF' }, other)).status).toBe(403);
      expect((await patch({ mode: 'OFF' }, student)).status).toBe(403);
      expect(await geofenceAudits(sessionId)).toHaveLength(0);

      expect((await patch({ mode: 'MAYBE' })).status).toBe(400);
      expect((await patch({ mode: 'OFF', location: PHONE })).status).toBe(400);
    });

    it('refuses changes to a closed session', async () => {
      const { lecturer, sessionId, patch } = await deviceSession();
      await api(lecturer.auth).patch(`/sessions/${sessionId}/status`, { status: 'CLOSED' });
      expect((await patch({ mode: 'OFF' })).status).toBe(409);
    });
  });

  describe('check-in', () => {
    /** `metres` due north of the room's centre. */
    const north = (metres: number) => ({ latitude: LH.latitude + (metres / 6_371_008.8) * (180 / Math.PI), longitude: LH.longitude });
    const reading = (metres: number, extra: object = {}) => ({ ...north(metres), accuracy: 8, capturedAt: Date.now(), ...extra });

    /** A class in a surveyed room with one student on its roster. */
    async function fencedClass() {
      const lecturer = await makeUser('LECTURER');
      const student = await makeUser('STUDENT');
      const unit = await makeUnit(lecturer);
      const room = await placeInRoom(unit.id, true);
      await pool.query(
        `INSERT INTO unit_allocations (unit_id, student_user_id, registration_number, full_name, status, source)
         VALUES ($1, $2, $3, 'Test Student', 'ACTIVE', 'ERP')`, [unit.id, student.id, `REG/G${uniq()}`]);
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id)).data.id;
      const qr = async () => body<{ payload: string; checkedIn: number; refusedOutsideFence: number }>(
        await api(lecturer.auth).get(`/sessions/${sessionId}/qr`)).data;
      const checkIn = async (location?: object, who = student) =>
        api(who.auth).post('/attendance/check-in', { payload: (await qr()).payload, ...(location ? { location } : {}) });
      return { lecturer, student, unit, room, sessionId, qr, checkIn };
    }

    const record = async (sessionId: string) => (await pool.query(
      `SELECT geofence_result, distance_m, location_accuracy_m FROM attendance_records WHERE session_id = $1`, [sessionId])).rows[0];
    const rejections = async (sessionId: string) => (await pool.query<{ reason: string; metadata: Record<string, unknown> }>(
      `SELECT reason, metadata FROM audit_logs WHERE action = 'ATTENDANCE_SCAN_REJECTED' AND metadata->>'sessionId' = $1 ORDER BY created_at`,
      [sessionId])).rows;

    it('records a student inside the room with their distance, never their coordinates', async () => {
      const { sessionId, checkIn } = await fencedClass();

      const res = await checkIn(reading(12));
      expect(res.status).toBe(201);
      expect(body<{ distanceMetres: number }>(res).data.distanceMetres).toBeCloseTo(12, 0);
      const row = await record(sessionId);
      expect(row).toMatchObject({ geofence_result: 'INSIDE', location_accuracy_m: 8 });
      expect(row.distance_m).toBeCloseTo(12, 0);

      const { rows: [columns] } = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.columns
          WHERE table_name = 'attendance_records' AND column_name ~ '(lat|lng|lon)'`);
      expect(columns!.n).toBe(0);
    });

    it('lets in a reading whose accuracy could put it inside the fence', async () => {
      const { checkIn } = await fencedClass();
      expect((await checkIn(reading(35, { accuracy: 16 }))).status).toBe(201);
    });

    it('refuses a student outside the room, tells them how far away they are, and counts them for the lecturer', async () => {
      const { room, sessionId, qr, checkIn } = await fencedClass();

      const res = await checkIn(reading(140));
      expect(res.status).toBe(403);
      expect(body(res).error).toMatchObject({ code: 'OUTSIDE_GEOFENCE' });
      expect(body(res).error!.message).toContain(`about 140 m from ${room}`);
      expect((res.body as { error: { details: Record<string, unknown> } }).error.details)
        .toMatchObject({ reason: 'OUTSIDE_GEOFENCE', roomCode: room, radiusMetres: 20, distanceMetres: 140, accuracyMetres: 8 });
      expect(await record(sessionId)).toBeUndefined();

      const [rejection] = await rejections(sessionId);
      expect(rejection!.reason).toBe('OUTSIDE_GEOFENCE');
      expect(rejection!.metadata).toMatchObject({ geofenceMode: 'ROOM', accuracyMetres: 8 });
      expect(rejection!.metadata['distanceMetres']).toBeCloseTo(140, 0);
      expect(JSON.stringify(rejection!.metadata)).not.toMatch(/latitude|longitude/);

      await checkIn(reading(300)); // the same student twice still counts once
      expect((await qr()).refusedOutsideFence).toBe(1);

      // They walk in and rescan: recorded, and no longer counted as refused.
      expect((await checkIn(reading(5))).status).toBe(201);
      expect(await qr()).toMatchObject({ checkedIn: 1, refusedOutsideFence: 0 });
    });

    it('refuses before the class-list check, so a friend at home is refused for where they are', async () => {
      const { sessionId, qr } = await fencedClass();
      const friend = await makeUser('STUDENT');
      const res = await api(friend.auth).post('/attendance/check-in', { payload: (await qr()).payload, location: reading(2000) });
      expect(res.status).toBe(403);
      expect(body(res).error).toMatchObject({ code: 'OUTSIDE_GEOFENCE' });
      expect((await qr()).refusedOutsideFence).toBe(1);
      expect((await rejections(sessionId)).map((r) => r.reason)).toEqual(['OUTSIDE_GEOFENCE']);
    });

    it('asks for a location, a fresh one, and a precise one', async () => {
      const { sessionId, checkIn } = await fencedClass();

      const none = await checkIn();
      expect(none.status).toBe(422);
      expect(body(none).error).toMatchObject({ code: 'LOCATION_REQUIRED' });

      const stale = await checkIn(reading(5, { capturedAt: Date.now() - 5 * 60_000 }));
      expect(stale.status).toBe(422);
      expect(body(stale).error).toMatchObject({ code: 'LOCATION_STALE' });

      const vague = await checkIn(reading(5, { accuracy: 120 }));
      expect(vague.status).toBe(422);
      expect(body(vague).error).toMatchObject({ code: 'LOCATION_TOO_IMPRECISE' });
      expect(body(vague).error!.message).toMatch(/window/);

      expect((await rejections(sessionId)).map((r) => r.reason))
        .toEqual(['LOCATION_REQUIRED', 'LOCATION_STALE', 'LOCATION_TOO_IMPRECISE']);

      // An ISO timestamp works as well as epoch milliseconds.
      expect((await checkIn(reading(5, { capturedAt: new Date().toISOString() }))).status).toBe(201);
    });

    it('refuses a location the phone reports as faked, even from the middle of the room', async () => {
      const { sessionId, checkIn } = await fencedClass();
      const res = await checkIn(reading(0, { isMocked: true }));
      expect(res.status).toBe(403);
      expect(body(res).error).toMatchObject({ code: 'LOCATION_MOCKED' });
      expect((await rejections(sessionId))[0]!.metadata).toMatchObject({ isMocked: true });
    });

    it('rejects a malformed reading', async () => {
      const { checkIn } = await fencedClass();
      for (const bad of [
        reading(5, { capturedAt: 'yesterday' }),
        reading(5, { capturedAt: undefined }),
        reading(5, { isMocked: 'no' }),
        { ...reading(5), latitude: -91 },
        { ...reading(5), speed: 3 },
      ]) {
        expect((await checkIn(bad)).status).toBe(400);
      }
    });

    it('checks nothing when the fence is off, including partway through the class', async () => {
      const { lecturer, sessionId, checkIn } = await fencedClass();
      const other = await makeUser('STUDENT');
      await pool.query(
        `INSERT INTO unit_allocations (unit_id, student_user_id, registration_number, status, source)
         SELECT unit_id, $2, 'REG/OFF' || $3, 'ACTIVE', 'ERP' FROM attendance_sessions WHERE id = $1`,
        [sessionId, other.id, uniq()]);

      expect((await checkIn(reading(500))).status).toBe(403);
      await api(lecturer.auth).patch(`/sessions/${sessionId}/geofence`, { mode: 'OFF' });

      const res = await checkIn();
      expect(res.status).toBe(201);
      expect(body<{ distanceMetres: number | null }>(res).data.distanceMetres).toBeNull();
      expect(await record(sessionId)).toEqual({ geofence_result: 'NOT_CHECKED', distance_m: null, location_accuracy_m: null });

      // A reading sent anyway is ignored, not stored.
      expect((await checkIn(reading(500), other)).status).toBe(201);
    });

    it('tells the portal each unit\'s room and whether it is surveyed', async () => {
      const lecturer = await makeUser('LECTURER');
      const surveyed = await makeUnit(lecturer);
      const unsurveyed = await makeUnit(lecturer);
      const roomless = await makeUnit(lecturer);
      const surveyedRoom = await placeInRoom(surveyed.id, true);
      const plainRoom = await placeInRoom(unsurveyed.id, false);

      const units = body<Array<{ id: string; room: unknown }>>(await api(lecturer.auth).get('/units')).data;
      const roomOf = (id: string) => units.find((u) => u.id === id)!.room;
      expect(roomOf(surveyed.id)).toEqual({ code: surveyedRoom, surveyed: true });
      expect(roomOf(unsurveyed.id)).toEqual({ code: plainRoom, surveyed: false });
      expect(roomOf(roomless.id)).toBeNull();

      // The unit to activate right now carries it too. Every test unit's slot spans today,
      // so ask as a lecturer with only the surveyed one.
      const solo = await makeUser('LECTURER');
      const only = await makeUnit(solo);
      await pool.query(`UPDATE unit_schedule SET room_code = $2 WHERE unit_id = $1`, [only.id, surveyedRoom]);
      const current = body<{ id: string; room: unknown }>(await api(solo.auth).get('/units/current')).data;
      expect(current).toMatchObject({ id: only.id, room: { code: surveyedRoom, surveyed: true } });
    });

    it('shows distances on the attendee list and the CSV, and the fence mode on reports', async () => {
      const { lecturer, sessionId, checkIn } = await fencedClass();
      expect((await checkIn(reading(12))).status).toBe(201);

      const list = body<{ attendees: Array<{ distanceMetres: number | null; geofenceResult: string }> }>(
        await api(lecturer.auth).get(`/attendance/sessions/${sessionId}`)).data;
      expect(list.attendees).toHaveLength(1);
      expect(list.attendees[0]!.geofenceResult).toBe('INSIDE');
      expect(list.attendees[0]!.distanceMetres).toBeCloseTo(12, 0);

      const reports = body<Array<{ id: string; geofenceMode: string }>>(await api(lecturer.auth).get('/reports/sessions')).data;
      expect(reports.find((r) => r.id === sessionId)).toMatchObject({ geofenceMode: 'ROOM' });

      const csv = await api(lecturer.auth).get(`/reports/sessions/${sessionId}/export`);
      expect(csv.status).toBe(200);
      const [header, row] = csv.text.split('\n');
      expect(header).toBe('Registration Number,Full Name,Status,Recorded At,Distance (m)');
      expect(row).toMatch(/,Present,[^,]+,12$/);

      // With the fence off: no distance, and the report says so.
      await api(lecturer.auth).patch(`/sessions/${sessionId}/geofence`, { mode: 'OFF' });
      const after = body<Array<{ id: string; geofenceMode: string }>>(await api(lecturer.auth).get('/reports/sessions')).data;
      expect(after.find((r) => r.id === sessionId)).toMatchObject({ geofenceMode: 'OFF' });
    });

    it('leaves the distance blank for check-ins made with the fence off, and for absentees', async () => {
      const lecturer = await makeUser('LECTURER');
      const student = await makeUser('STUDENT');
      const absentee = await makeUser('STUDENT');
      const unit = await makeUnit(lecturer);
      for (const who of [student, absentee]) {
        await pool.query(
          `INSERT INTO unit_allocations (unit_id, student_user_id, registration_number, full_name, status, source)
           VALUES ($1, $2, $3, $4, 'ACTIVE', 'ERP')`, [unit.id, who.id, `REG/C${uniq()}`, `Z ${who.id}`]);
      }
      const sessionId = body<{ id: string }>(await activate(lecturer, unit.id, { geofence: 'OFF' })).data.id;
      const { payload } = body<{ payload: string }>(await api(lecturer.auth).get(`/sessions/${sessionId}/qr`)).data;
      expect((await api(student.auth).post('/attendance/check-in', { payload })).status).toBe(201);

      const list = body<{ attendees: Array<{ distanceMetres: number | null; geofenceResult: string }> }>(
        await api(lecturer.auth).get(`/attendance/sessions/${sessionId}`)).data;
      expect(list.attendees[0]).toMatchObject({ distanceMetres: null, geofenceResult: 'NOT_CHECKED' });

      const rows = (await api(lecturer.auth).get(`/reports/sessions/${sessionId}/export`)).text.split('\n').slice(1);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.includes(',Present,'))).toMatch(/,Present,[^,]+,$/);
      expect(rows.find((r) => r.includes(',Absent,'))).toMatch(/,Absent,,$/);
    });

    it('applies the same rule on POST /sessions/scan', async () => {
      const { student, qr } = await fencedClass();
      const scan = async (location?: object) => api(student.auth).post('/sessions/scan', { payload: (await qr()).payload, location });
      expect((await scan(reading(140))).status).toBe(403);
      const ok = await scan(reading(3));
      expect(ok.status).toBe(200);
      expect(body<{ geofence: { result: string } }>(ok).data.geofence).toMatchObject({ result: 'INSIDE' });
    });
  });
});

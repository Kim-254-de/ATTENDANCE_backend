import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atCampusTime, campusClock } from '../../src/common/utils/campus-time.js';

/**
 * Department oversight against a real Postgres database.
 *
 * The fixture is built to make every reported figure checkable by hand: two
 * departments, one of which has a punctual lecturer and a late one, with
 * attendance rates chosen so the averages are exact rather than approximate.
 * Sessions are inserted directly so `scheduled_start_at` can be set to known
 * values; one session is also opened through the real `POST /sessions` route,
 * to prove the activation path actually writes that column.
 */
const TEST_DB = 'attendance_department_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

/** A signed-in user of any role, as a bearer token. requireAuth re-reads the role from the session row. */
async function makeUser(role: 'LECTURER' | 'STUDENT' | 'DEPARTMENT', fullName: string) {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${n}@uni.ac.ke`, fullName, role]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

async function makeFaculty(name: string): Promise<string> {
  const { rows: [f] } = await pool.query<{ id: string }>(
    `INSERT INTO faculties (name) VALUES ($1) RETURNING id`, [name]);
  return f!.id;
}

async function makeDepartment(name: string, facultyId: string | null): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId]);
  return d!.id;
}

/** A lecturer with a profile row attached to a department — the only route a unit has to a department. */
async function makeLecturer(fullName: string, departmentId: string) {
  const user = await makeUser('LECTURER', fullName);
  const staffNumber = `STF/D${uniq()}`;
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, (SELECT name FROM departments WHERE id = $3))`,
    [user.id, staffNumber, departmentId]);
  return { ...user, staffNumber, fullName };
}

async function makeOfficer(fullName: string, departmentId: string) {
  const user = await makeUser('DEPARTMENT', fullName);
  await pool.query(
    `INSERT INTO department_profiles (user_id, department_id, title) VALUES ($1, $2, 'Dr.')`,
    [user.id, departmentId]);
  return user;
}

async function makeUnit(code: string, lecturerUserId: string): Promise<string> {
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, $2, $3, 'VERIFIED') RETURNING id`,
    [code, `${code} Course`, lecturerUserId]);
  return u!.id;
}

async function allocate(unitId: string, studentUserId: string, registrationNumber: string, fullName: string) {
  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 'ERP') RETURNING id`,
    [unitId, registrationNumber, studentUserId, fullName]);
  return a!.id;
}

/** A finished class meeting with a known schedule and a known actual start. */
async function makeSession(args: {
  unitId: string;
  lecturerUserId: string;
  scheduledStartAt: Date | null;
  opensAt: Date;
}): Promise<string> {
  const { rows: [s] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds, scheduled_start_at)
     VALUES ($1, $2, $3, 'CLOSED', $4::timestamptz, $4::timestamptz + INTERVAL '1 hour', 60, $5) RETURNING id`,
    [args.unitId, args.lecturerUserId, randomUUID(), args.opensAt, args.scheduledStartAt]);
  return s!.id;
}

async function recordAttendance(sessionId: string, studentUserId: string, allocationId: string) {
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_user_id, allocation_id) VALUES ($1, $2, $3)`,
    [sessionId, studentUserId, allocationId]);
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
});

// --- the fixture -----------------------------------------------------------

/** A week ago, so every seeded session is safely in the past whatever the clock says. */
const BASE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const after = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

interface Fixture {
  facultyName: string;
  departmentName: string;
  officer: { id: string; auth: string };
  otherOfficer: { id: string; auth: string };
  punctual: { id: string; auth: string; staffNumber: string; fullName: string };
  late: { id: string; auth: string; staffNumber: string; fullName: string };
  outsider: { id: string; auth: string; staffNumber: string; fullName: string };
  unitA1: string;
  unitA2: string;
  student1: { id: string };
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const facultyName = 'Faculty of Science and Technology';
  const facultyId = await makeFaculty(facultyName);
  const departmentName = 'Department of Computer Science';
  const deptA = await makeDepartment(departmentName, facultyId);
  const deptB = await makeDepartment('Department of Mathematics', facultyId);

  const officer = await makeOfficer('CS Officer', deptA);
  const otherOfficer = await makeOfficer('Maths Officer', deptB);

  const punctual = await makeLecturer('Dr. Punctual', deptA);
  const late = await makeLecturer('Dr. Late', deptA);
  const outsider = await makeLecturer('Dr. Elsewhere', deptB);

  const unitA1 = await makeUnit('CSC 101', punctual.id);
  const unitA2 = await makeUnit('CSC 202', late.id);
  const unitB1 = await makeUnit('MAT 101', outsider.id);

  const student1 = await makeUser('STUDENT', 'Ama Mensah');
  const student2 = await makeUser('STUDENT', 'Kofi Boateng');
  const student3 = await makeUser('STUDENT', 'Zawadi Mwangi');
  const student4 = await makeUser('STUDENT', 'Maths Student');

  const a11 = await allocate(unitA1, student1.id, 'REG/001', 'Ama Mensah');
  const a12 = await allocate(unitA1, student2.id, 'REG/002', 'Kofi Boateng');
  const a23 = await allocate(unitA2, student3.id, 'REG/003', 'Zawadi Mwangi');
  const b14 = await allocate(unitB1, student4.id, 'REG/004', 'Maths Student');

  // Punctual: both sessions inside the 5-minute grace. Rates 100% and 50% -> avg 75.
  const s1 = await makeSession({ unitId: unitA1, lecturerUserId: punctual.id, scheduledStartAt: BASE, opensAt: after(1) });
  const s2 = await makeSession({ unitId: unitA1, lecturerUserId: punctual.id, scheduledStartAt: after(120), opensAt: after(123) });
  await recordAttendance(s1, student1.id, a11);
  await recordAttendance(s1, student2.id, a12);
  await recordAttendance(s2, student1.id, a11);

  // Late: one session 20 minutes past its slot (100% attended), and one with no
  // schedule at all (0% attended) that every timekeeping figure must ignore.
  const s3 = await makeSession({ unitId: unitA2, lecturerUserId: late.id, scheduledStartAt: BASE, opensAt: after(20) });
  await makeSession({ unitId: unitA2, lecturerUserId: late.id, scheduledStartAt: null, opensAt: after(240) });
  await recordAttendance(s3, student3.id, a23);

  // Another department entirely: a perfectly attended, perfectly punctual
  // session that must never reach department A's figures.
  const sB = await makeSession({ unitId: unitB1, lecturerUserId: outsider.id, scheduledStartAt: BASE, opensAt: BASE });
  await recordAttendance(sB, student4.id, b14);

  return { facultyName, departmentName, officer, otherOfficer, punctual, late, outsider, unitA1, unitA2, student1 };
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
  fx = await seed();
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

// ---------------------------------------------------------------------------

describe('the DEPARTMENT role', () => {
  it('widens the users.role CHECK constraint rather than relying on it being absent', async () => {
    const { rows: [constraint] } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'users_role_check'
            AND pg_get_constraintdef(oid) LIKE '%DEPARTMENT%') AS ok`);
    expect(constraint!.ok).toBe(true);

    await expect(pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, status)
       VALUES ('nope@uni.ac.ke', 'x', 'Nope', 'JANITOR', 'ACTIVE')`,
    )).rejects.toThrow(/users_role_check/);
  });

  it('resolves a department officer at sign-in, with their department', async () => {
    const { rows: [u] } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`, [fx.officer.id]);
    expect(u).toBeDefined();

    const { findAccountForLogin } = await import('../../src/modules/auth/auth.session.repository.js');
    const { rows: [account] } = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [fx.officer.id]);
    const candidate = await findAccountForLogin(account!.email);

    expect(candidate?.role).toBe('DEPARTMENT');
    expect(candidate?.account).toMatchObject({ role: 'department', departmentName: fx.departmentName });
  });

  it('populates req.auth.department per request, the way it does lecturer and student', async () => {
    const { findSession } = await import('../../src/modules/auth/auth.session.repository.js');
    const { rows: [s] } = await pool.query<{ id: string }>(
      `SELECT id FROM auth_sessions WHERE user_id = $1`, [fx.officer.id]);
    const session = await findSession(s!.id);

    expect(session?.department).toMatchObject({ role: 'department', departmentName: fx.departmentName });
    expect(session?.lecturer).toBeNull();
    expect(session?.student).toBeNull();
  });

  it('refuses every department route to a lecturer holding a valid token', async () => {
    for (const path of ['/departments/me', '/departments/overview', '/departments/lecturers',
      '/departments/students', '/departments/units', '/departments/timekeeping']) {
      const res = await api(fx.punctual.auth).get(path);
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/v1/departments/overview')).status).toBe(401);
  });
});

describe('GET /departments/me', () => {
  it('names the officer\'s department and the faculty above it', async () => {
    const res = await api(fx.officer.auth).get('/departments/me');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      departmentName: fx.departmentName,
      facultyName: fx.facultyName,
    });
  });

  it('gives a different officer their own department, not this one', async () => {
    const res = await api(fx.otherOfficer.auth).get('/departments/me');
    expect(body(res).data).toMatchObject({ departmentName: 'Department of Mathematics' });
  });
});

describe('GET /departments/overview', () => {
  it('counts and averages the whole department, and nothing outside it', async () => {
    const res = await api(fx.officer.auth).get('/departments/overview');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      departmentName: fx.departmentName,
      lecturerCount: 2,
      unitCount: 2,
      // Three distinct students across the department's two units; the fourth
      // belongs to Mathematics.
      studentCount: 3,
      sessionsHeld: 4,
      // Per-session rates 100, 50, 100, 0 -> 62.5. The other department's
      // perfectly attended session would drag this to 70 if it leaked in.
      avgAttendanceRate: 62.5,
      // 3 of 4 sessions have a schedule; 2 of those 3 opened inside the grace.
      onTimeRate: 66.7,
      graceMinutes: 5,
    });
  });

  it('reports the other department separately', async () => {
    const res = await api(fx.otherOfficer.auth).get('/departments/overview');
    expect(body(res).data).toMatchObject({
      lecturerCount: 1,
      unitCount: 1,
      studentCount: 1,
      sessionsHeld: 1,
      avgAttendanceRate: 100,
      onTimeRate: 100,
    });
  });
});

describe('GET /departments/lecturers', () => {
  it('reports each lecturer\'s teaching load, attendance and punctuality', async () => {
    const res = await api(fx.officer.auth).get('/departments/lecturers');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows.map((r) => r['fullName'])).toEqual(['Dr. Late', 'Dr. Punctual']);

    expect(rows.find((r) => r['fullName'] === 'Dr. Punctual')).toMatchObject({
      userId: fx.punctual.id,
      staffNumber: fx.punctual.staffNumber,
      unitsTaught: 1,
      studentsTaught: 2,
      avgAttendanceRate: 75,
      sessionsHeld: 2,
      avgLateMinutes: 2, // 1 and 3 minutes
      onTimeRate: 100,
    });

    expect(rows.find((r) => r['fullName'] === 'Dr. Late')).toMatchObject({
      userId: fx.late.id,
      unitsTaught: 1,
      studentsTaught: 1,
      avgAttendanceRate: 50,
      sessionsHeld: 2,
      // Only the scheduled session counts; the unscheduled one is not "0 minutes late".
      avgLateMinutes: 20,
      onTimeRate: 0,
    });
  });

  it('never lists a lecturer from another department', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get('/departments/lecturers')).data;
    expect(rows.map((r) => r['userId'])).not.toContain(fx.outsider.id);
  });
});

describe('GET /departments/lecturers/:lecturerUserId', () => {
  it('drills into one of its own lecturers, with per-unit rates and session timekeeping', async () => {
    const res = await api(fx.officer.auth).get(`/departments/lecturers/${fx.punctual.id}`);
    expect(res.status).toBe(200);
    const data = body<{
      lecturer: Record<string, unknown>;
      units: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
    }>(res).data;

    expect(data.lecturer).toMatchObject({ userId: fx.punctual.id, staffNumber: fx.punctual.staffNumber });
    expect(data.units).toHaveLength(1);
    expect(data.units[0]).toMatchObject({ unitCode: 'CSC 101', activeStudents: 2, sessionsHeld: 2, avgAttendanceRate: 75 });

    // Newest first: the 11:00-slot session, then the 09:00 one.
    expect(data.sessions.map((s) => s['lateMinutes'])).toEqual([3, 1]);
    expect(data.sessions[0]).toMatchObject({ unitCode: 'CSC 101', present: 1, total: 2, attendanceRate: 50 });
    expect(data.sessions[1]).toMatchObject({ present: 2, total: 2, attendanceRate: 100 });
    expect(data.sessions[0]!['scheduledStartAt']).toBe(after(120).toISOString());
  });

  it('reports a session with no schedule as having no lateMinutes rather than zero', async () => {
    const data = body<{ sessions: Array<Record<string, unknown>> }>(
      await api(fx.officer.auth).get(`/departments/lecturers/${fx.late.id}`)).data;

    const unscheduled = data.sessions.find((s) => s['scheduledStartAt'] === null);
    expect(unscheduled).toBeDefined();
    expect(unscheduled!['lateMinutes']).toBeNull();
    expect(data.sessions.find((s) => s['scheduledStartAt'] !== null)!['lateMinutes']).toBe(20);
  });

  it('404s on a lecturer in another department instead of confirming they exist', async () => {
    const res = await api(fx.officer.auth).get(`/departments/lecturers/${fx.outsider.id}`);
    expect(res.status).toBe(404);
    expect(body(res).error?.code).toBe('NOT_FOUND');
  });

  it('404s on a user who is not a lecturer at all', async () => {
    expect((await api(fx.officer.auth).get(`/departments/lecturers/${fx.student1.id}`)).status).toBe(404);
  });

  it('rejects a non-uuid lecturer id before it reaches a query', async () => {
    const res = await api(fx.officer.auth).get('/departments/lecturers/not-a-uuid');
    expect(res.status).toBe(400);
    expect(body(res).error?.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /departments/students', () => {
  it('lists one row per (student, unit) across the department, with the owning lecturer', async () => {
    const res = await api(fx.officer.auth).get('/departments/students');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['fullName'])).not.toContain('Maths Student');

    expect(rows.find((r) => r['registrationNumber'] === 'REG/001')).toMatchObject({
      unitCode: 'CSC 101', lecturerName: 'Dr. Punctual', sessionsHeld: 2, sessionsAttended: 2, attendanceRate: 100,
    });
    expect(rows.find((r) => r['registrationNumber'] === 'REG/002')).toMatchObject({
      sessionsHeld: 2, sessionsAttended: 1, attendanceRate: 50,
    });
    expect(rows.find((r) => r['registrationNumber'] === 'REG/003')).toMatchObject({
      unitCode: 'CSC 202', lecturerName: 'Dr. Late', sessionsHeld: 2, sessionsAttended: 1, attendanceRate: 50,
    });
  });
});

describe('GET /departments/units', () => {
  it('lists the department\'s units with their aggregate rate and lecturer', async () => {
    const res = await api(fx.officer.auth).get('/departments/units');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows.map((r) => r['unitCode'])).toEqual(['CSC 101', 'CSC 202']);
    expect(rows[0]).toMatchObject({
      unitCode: 'CSC 101', lecturerName: 'Dr. Punctual', activeStudents: 2, sessionsHeld: 2, avgAttendanceRate: 75,
    });
    expect(rows[1]).toMatchObject({
      unitCode: 'CSC 202', lecturerName: 'Dr. Late', activeStudents: 1, sessionsHeld: 2, avgAttendanceRate: 50,
    });
  });
});

describe('GET /departments/timekeeping', () => {
  it('reports every measurable session, newest first, and excludes the unscheduled one', async () => {
    const res = await api(fx.officer.auth).get('/departments/timekeeping');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    // 3 of the department's 4 sessions have a scheduled start. Newest first by
    // when the class actually opened: +123 min, then +20, then +1.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r['lateMinutes'])).toEqual([3, 20, 1]);
    expect(rows.map((r) => r['onTime'])).toEqual([true, false, true]);
    expect(rows[1]).toMatchObject({ unitCode: 'CSC 202', lecturerName: 'Dr. Late' });
    expect(rows[1]!['scheduledStartAt']).toBe(BASE.toISOString());
    expect(rows[1]!['opensAt']).toBe(after(20).toISOString());
  });

  it('filters by lecturer', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/departments/timekeeping?lecturerUserId=${fx.punctual.id}`)).data;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r['lecturerUserId'] === fx.punctual.id)).toBe(true);
  });

  it('filters by unit', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/departments/timekeeping?unitId=${fx.unitA2}`)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unitCode: 'CSC 202', lateMinutes: 20 });
  });

  it('honours limit', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get('/departments/timekeeping?limit=1')).data;
    expect(rows).toHaveLength(1);
  });

  it('cannot be widened to another department\'s lecturer through the filter', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/departments/timekeeping?lecturerUserId=${fx.outsider.id}`)).data;
    expect(rows).toEqual([]);
  });

  it('rejects an unknown query parameter and an out-of-range limit', async () => {
    expect((await api(fx.officer.auth).get('/departments/timekeeping?departmentId=whatever')).status).toBe(400);
    expect((await api(fx.officer.auth).get('/departments/timekeeping?limit=500')).status).toBe(400);
    expect((await api(fx.officer.auth).get('/departments/timekeeping?limit=0')).status).toBe(400);
  });
});

describe('activating a class records its scheduled start', () => {
  it('stores the matched slot\'s start on the session, and the department can read it back', async () => {
    const now = new Date();
    const { dayOfWeek } = campusClock(now, 'Africa/Nairobi');
    // Spans the whole campus day, so this passes whatever time the suite runs at.
    await pool.query(
      `INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time, room_code)
       VALUES ($1, $2, '00:00', '23:59', 'LH1')`,
      [fx.unitA1, dayOfWeek]);

    const res = await api(fx.punctual.auth).post('/sessions', { unitId: fx.unitA1, geofence: 'OFF' });
    expect(res.status).toBe(201);
    const sessionId = body<{ id: string }>(res).data.id;

    const { rows: [row] } = await pool.query<{ scheduled_start_at: Date | null }>(
      `SELECT scheduled_start_at FROM attendance_sessions WHERE id = $1`, [sessionId]);
    expect(row!.scheduled_start_at).not.toBeNull();
    expect(row!.scheduled_start_at!.toISOString())
      .toBe(atCampusTime(now, '00:00', 'Africa/Nairobi').toISOString());

    // And it shows up in the department's punctuality log.
    const log = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/departments/timekeeping?unitId=${fx.unitA1}`)).data;
    expect(log.map((r) => r['sessionId'])).toContain(sessionId);
  });
});

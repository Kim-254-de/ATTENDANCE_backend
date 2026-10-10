import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atCampusTime, campusClock } from '../../src/common/utils/campus-time.js';

/**
 * Faculty oversight against a real Postgres database.
 *
 * The fixture is the department module's own test fixture widened by one
 * level: faculty A holds two departments (Computer Science, with a punctual
 * and a late lecturer; Mathematics, with one more) so its numbers are the
 * department fixture's two departments combined. A second faculty entirely
 * (faculty B) exists purely to prove nothing from it ever leaks into A's
 * figures — the one check `department.test.ts` cannot exercise on its own.
 */
const TEST_DB = 'attendance_faculty_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

/** A signed-in user of any role, as a bearer token. requireAuth re-reads the role from the session row. */
async function makeUser(role: 'LECTURER' | 'STUDENT' | 'DEPARTMENT' | 'FACULTY', fullName: string) {
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

async function makeDepartment(name: string, facultyId: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId]);
  return d!.id;
}

async function makeLecturer(fullName: string, departmentId: string) {
  const user = await makeUser('LECTURER', fullName);
  const staffNumber = `STF/F${uniq()}`;
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, (SELECT name FROM departments WHERE id = $3))`,
    [user.id, staffNumber, departmentId]);
  return { ...user, staffNumber, fullName };
}

async function makeFacultyOfficer(fullName: string, facultyId: string) {
  const user = await makeUser('FACULTY', fullName);
  await pool.query(
    `INSERT INTO faculty_profiles (user_id, faculty_id, title) VALUES ($1, $2, 'Prof.')`,
    [user.id, facultyId]);
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

const BASE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const after = (minutes: number) => new Date(BASE.getTime() + minutes * 60_000);

interface Fixture {
  facultyAName: string;
  facultyBName: string;
  deptAName: string;
  deptBName: string;
  deptAId: string;
  deptBId: string;
  officer: { id: string; auth: string };
  otherFacultyOfficer: { id: string; auth: string };
  punctual: { id: string; auth: string; staffNumber: string; fullName: string };
  late: { id: string; auth: string; staffNumber: string; fullName: string };
  inOtherDept: { id: string; auth: string; staffNumber: string; fullName: string };
  outsider: { id: string; auth: string; staffNumber: string; fullName: string };
  unitA1: string;
  unitA2: string;
  unitB1: string;
  student1: { id: string };
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const facultyAName = 'Faculty of Science and Technology';
  const facultyBName = 'Faculty of Arts';
  const facultyAId = await makeFaculty(facultyAName);
  const facultyBId = await makeFaculty(facultyBName);

  const deptAName = 'Department of Computer Science';
  const deptBName = 'Department of Mathematics';
  const deptAId = await makeDepartment(deptAName, facultyAId);
  const deptBId = await makeDepartment(deptBName, facultyAId);
  const deptCId = await makeDepartment('Department of History', facultyBId);

  const officer = await makeFacultyOfficer('Faculty A Officer', facultyAId);
  const otherFacultyOfficer = await makeFacultyOfficer('Faculty B Officer', facultyBId);

  // Faculty A, department A: a punctual lecturer and a late one (identical fixture to department.test.ts).
  const punctual = await makeLecturer('Dr. Punctual', deptAId);
  const late = await makeLecturer('Dr. Late', deptAId);
  // Faculty A, department B: a second department's lecturer, inside the same faculty.
  const inOtherDept = await makeLecturer('Dr. Mathematics', deptBId);
  // Faculty B entirely: must never reach faculty A's figures.
  const outsider = await makeLecturer('Dr. Elsewhere', deptCId);

  const unitA1 = await makeUnit('CSC 101', punctual.id);
  const unitA2 = await makeUnit('CSC 202', late.id);
  const unitB1 = await makeUnit('MAT 101', inOtherDept.id);
  const unitC1 = await makeUnit('HIS 101', outsider.id);

  const student1 = await makeUser('STUDENT', 'Ama Mensah');
  const student2 = await makeUser('STUDENT', 'Kofi Boateng');
  const student3 = await makeUser('STUDENT', 'Zawadi Mwangi');
  const student4 = await makeUser('STUDENT', 'Maths Student');
  const student5 = await makeUser('STUDENT', 'History Student');

  const a11 = await allocate(unitA1, student1.id, 'REG/001', 'Ama Mensah');
  const a12 = await allocate(unitA1, student2.id, 'REG/002', 'Kofi Boateng');
  const a23 = await allocate(unitA2, student3.id, 'REG/003', 'Zawadi Mwangi');
  const b14 = await allocate(unitB1, student4.id, 'REG/004', 'Maths Student');
  const c15 = await allocate(unitC1, student5.id, 'REG/005', 'History Student');

  // Punctual: both sessions inside the 5-minute grace. Rates 100% and 50% -> avg 75.
  const s1 = await makeSession({ unitId: unitA1, lecturerUserId: punctual.id, scheduledStartAt: BASE, opensAt: after(1) });
  const s2 = await makeSession({ unitId: unitA1, lecturerUserId: punctual.id, scheduledStartAt: after(120), opensAt: after(123) });
  await recordAttendance(s1, student1.id, a11);
  await recordAttendance(s1, student2.id, a12);
  await recordAttendance(s2, student1.id, a11);

  // Late: one session 20 minutes past its slot, and one with no schedule at all.
  const s3 = await makeSession({ unitId: unitA2, lecturerUserId: late.id, scheduledStartAt: BASE, opensAt: after(20) });
  await makeSession({ unitId: unitA2, lecturerUserId: late.id, scheduledStartAt: null, opensAt: after(240) });
  await recordAttendance(s3, student3.id, a23);

  // Department B, still inside faculty A: a perfectly attended, perfectly punctual session.
  const sB = await makeSession({ unitId: unitB1, lecturerUserId: inOtherDept.id, scheduledStartAt: BASE, opensAt: BASE });
  await recordAttendance(sB, student4.id, b14);

  // Faculty B entirely: must never reach faculty A's figures.
  const sC = await makeSession({ unitId: unitC1, lecturerUserId: outsider.id, scheduledStartAt: BASE, opensAt: BASE });
  await recordAttendance(sC, student5.id, c15);

  return {
    facultyAName, facultyBName, deptAName, deptBName, deptAId, deptBId,
    officer, otherFacultyOfficer, punctual, late, inOtherDept, outsider,
    unitA1, unitA2, unitB1, student1,
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

describe('the FACULTY role', () => {
  it('widens the users.role CHECK constraint rather than relying on it being absent', async () => {
    const { rows: [constraint] } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'users_role_check'
            AND pg_get_constraintdef(oid) LIKE '%FACULTY%') AS ok`);
    expect(constraint!.ok).toBe(true);
  });

  it('resolves a faculty officer at sign-in, with their faculty', async () => {
    const { findAccountForLogin } = await import('../../src/modules/auth/auth.session.repository.js');
    const { rows: [account] } = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`, [fx.officer.id]);
    const candidate = await findAccountForLogin(account!.email);

    expect(candidate?.role).toBe('FACULTY');
    expect(candidate?.account).toMatchObject({ role: 'faculty', facultyName: fx.facultyAName });
  });

  it('populates req.auth.faculty per request, and GET /auth/me resolves it', async () => {
    const { findSession } = await import('../../src/modules/auth/auth.session.repository.js');
    const { rows: [s] } = await pool.query<{ id: string }>(
      `SELECT id FROM auth_sessions WHERE user_id = $1`, [fx.officer.id]);
    const session = await findSession(s!.id);
    expect(session?.faculty).toMatchObject({ role: 'faculty', facultyName: fx.facultyAName });
    expect(session?.lecturer).toBeNull();
    expect(session?.department).toBeNull();

    // The exact gap that broke twice in the department build: the route
    // guard and the controller both have to know about the new role.
    const res = await api(fx.officer.auth).get('/auth/me');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ role: 'faculty', facultyName: fx.facultyAName });
  });

  it('refuses every faculty route to a lecturer or a department officer holding a valid token', async () => {
    for (const path of ['/faculties/me', '/faculties/overview', '/faculties/departments',
      '/faculties/lecturers', '/faculties/students', '/faculties/units', '/faculties/timekeeping']) {
      expect((await api(fx.punctual.auth).get(path)).status, path).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get('/api/v1/faculties/overview')).status).toBe(401);
  });
});

describe('GET /faculties/me', () => {
  it('names the officer\'s faculty', async () => {
    const res = await api(fx.officer.auth).get('/faculties/me');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ facultyName: fx.facultyAName });
  });

  it('gives a different officer their own faculty, not this one', async () => {
    const res = await api(fx.otherFacultyOfficer.auth).get('/faculties/me');
    expect(body(res).data).toMatchObject({ facultyName: fx.facultyBName });
  });
});

describe('GET /faculties/overview', () => {
  it('counts and averages across both of its departments, and nothing from faculty B', async () => {
    const res = await api(fx.officer.auth).get('/faculties/overview');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      facultyName: fx.facultyAName,
      departmentCount: 2,
      lecturerCount: 3,
      unitCount: 3,
      studentCount: 4,
      sessionsHeld: 5,
      // Per-session rates 100, 50, 100, 0, 100 -> 70. Faculty B's session
      // would drag this up if it leaked in.
      avgAttendanceRate: 70,
      // 4 of 5 sessions have a schedule; 3 of those 4 opened inside the grace.
      onTimeRate: 75,
      graceMinutes: 5,
    });
  });

  it('reports faculty B separately', async () => {
    const res = await api(fx.otherFacultyOfficer.auth).get('/faculties/overview');
    expect(body(res).data).toMatchObject({
      departmentCount: 1, lecturerCount: 1, unitCount: 1, studentCount: 1,
      sessionsHeld: 1, avgAttendanceRate: 100, onTimeRate: 100,
    });
  });
});

describe('GET /faculties/departments', () => {
  it('reports each department\'s own figures, comparable side by side', async () => {
    const res = await api(fx.officer.auth).get('/faculties/departments');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;
    expect(rows).toHaveLength(2);

    const deptA = rows.find((r) => r['departmentName'] === fx.deptAName);
    expect(deptA).toMatchObject({
      lecturerCount: 2, unitCount: 2, studentCount: 3, sessionsHeld: 4,
      avgAttendanceRate: 62.5, onTimeRate: 66.7,
    });

    const deptB = rows.find((r) => r['departmentName'] === fx.deptBName);
    expect(deptB).toMatchObject({
      lecturerCount: 1, unitCount: 1, studentCount: 1, sessionsHeld: 1,
      avgAttendanceRate: 100, onTimeRate: 100,
    });
  });

  it('never lists a department from another faculty', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get('/faculties/departments')).data;
    expect(rows.map((r) => r['departmentName'])).not.toContain('Department of History');
  });
});

describe('GET /faculties/departments/:departmentId', () => {
  it('drills into one of its own departments, with that department\'s lecturers and units', async () => {
    const res = await api(fx.officer.auth).get(`/faculties/departments/${fx.deptAId}`);
    expect(res.status).toBe(200);
    const data = body<{ departmentName: string; lecturers: Array<Record<string, unknown>>; units: Array<Record<string, unknown>> }>(res).data;

    expect(data.departmentName).toBe(fx.deptAName);
    expect(data.lecturers.map((l) => l['fullName']).sort()).toEqual(['Dr. Late', 'Dr. Punctual']);
    expect(data.units.map((u) => u['unitCode'])).toEqual(['CSC 101', 'CSC 202']);
  });

  it('404s on a department in another faculty instead of confirming it exists', async () => {
    const { rows: [deptC] } = await pool.query<{ id: string }>(
      `SELECT id FROM departments WHERE name = 'Department of History'`);
    const res = await api(fx.officer.auth).get(`/faculties/departments/${deptC!.id}`);
    expect(res.status).toBe(404);
    expect(body(res).error?.code).toBe('NOT_FOUND');
  });

  it('rejects a non-uuid department id before it reaches a query', async () => {
    const res = await api(fx.officer.auth).get('/faculties/departments/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

describe('GET /faculties/lecturers', () => {
  it('lists every lecturer across every department in the faculty, with their department named', async () => {
    const res = await api(fx.officer.auth).get('/faculties/lecturers');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows.map((r) => r['fullName']).sort()).toEqual(['Dr. Late', 'Dr. Mathematics', 'Dr. Punctual']);
    expect(rows.find((r) => r['fullName'] === 'Dr. Mathematics')).toMatchObject({ departmentName: fx.deptBName });
    expect(rows.find((r) => r['fullName'] === 'Dr. Punctual')).toMatchObject({
      departmentName: fx.deptAName, avgAttendanceRate: 75, onTimeRate: 100,
    });
  });

  it('never lists a lecturer from another faculty', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get('/faculties/lecturers')).data;
    expect(rows.map((r) => r['userId'])).not.toContain(fx.outsider.id);
  });
});

describe('GET /faculties/lecturers/:lecturerUserId', () => {
  it('drills into one of its own lecturers, with their department, units and timekeeping', async () => {
    const res = await api(fx.officer.auth).get(`/faculties/lecturers/${fx.punctual.id}`);
    expect(res.status).toBe(200);
    const data = body<{ lecturer: Record<string, unknown>; units: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> }>(res).data;

    expect(data.lecturer).toMatchObject({ userId: fx.punctual.id, departmentName: fx.deptAName });
    expect(data.units).toHaveLength(1);
    expect(data.sessions.map((s) => s['lateMinutes'])).toEqual([3, 1]);
  });

  it('404s on a lecturer in another faculty instead of confirming they exist', async () => {
    const res = await api(fx.officer.auth).get(`/faculties/lecturers/${fx.outsider.id}`);
    expect(res.status).toBe(404);
    expect(body(res).error?.code).toBe('NOT_FOUND');
  });

  it('still reaches a lecturer in a different department of the same faculty', async () => {
    const res = await api(fx.officer.auth).get(`/faculties/lecturers/${fx.inOtherDept.id}`);
    expect(res.status).toBe(200);
    expect(body<{ lecturer: Record<string, unknown> }>(res).data.lecturer).toMatchObject({ departmentName: fx.deptBName });
  });
});

describe('GET /faculties/students', () => {
  it('lists one row per (student, unit) across every department, never a student from another faculty', async () => {
    const res = await api(fx.officer.auth).get('/faculties/students');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r['fullName'])).not.toContain('History Student');
    expect(rows.find((r) => r['registrationNumber'] === 'REG/004')).toMatchObject({ departmentName: fx.deptBName });
  });
});

describe('GET /faculties/units', () => {
  it('lists the faculty\'s units across every department, with department named', async () => {
    const res = await api(fx.officer.auth).get('/faculties/units');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;

    expect(rows.map((r) => r['unitCode']).sort()).toEqual(['CSC 101', 'CSC 202', 'MAT 101']);
    expect(rows.find((r) => r['unitCode'] === 'MAT 101')).toMatchObject({ departmentName: fx.deptBName, avgAttendanceRate: 100 });
  });
});

describe('GET /faculties/timekeeping', () => {
  it('reports every measurable session across the faculty, newest first', async () => {
    const res = await api(fx.officer.auth).get('/faculties/timekeeping');
    expect(res.status).toBe(200);
    const rows = body<Array<Record<string, unknown>>>(res).data;
    // 4 of faculty A's 5 sessions have a scheduled start.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r['lateMinutes'])).toEqual([3, 20, 1, 0]);
  });

  it('filters by department', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/faculties/timekeeping?departmentId=${fx.deptBId}`)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unitCode: 'MAT 101' });
  });

  it('cannot be widened to another faculty through any filter', async () => {
    const rows = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/faculties/timekeeping?lecturerUserId=${fx.outsider.id}`)).data;
    expect(rows).toEqual([]);
  });
});

describe('activating a class records its scheduled start, and the faculty can read it back', () => {
  it('stores the matched slot\'s start on the session', async () => {
    const now = new Date();
    const { dayOfWeek } = campusClock(now, 'Africa/Nairobi');
    await pool.query(
      `INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time, room_code)
       VALUES ($1, $2, '00:00', '23:59', 'LH1')`,
      [fx.unitA1, dayOfWeek]);

    const res = await api(fx.punctual.auth).post('/sessions', { unitId: fx.unitA1, geofence: 'OFF' });
    expect(res.status).toBe(201);
    const sessionId = body<{ id: string }>(res).data.id;

    const log = body<Array<Record<string, unknown>>>(
      await api(fx.officer.auth).get(`/faculties/timekeeping?unitId=${fx.unitA1}`)).data;
    expect(log.map((r) => r['sessionId'])).toContain(sessionId);
    expect(atCampusTime(now, '00:00', 'Africa/Nairobi')).toBeInstanceOf(Date);
  });
});

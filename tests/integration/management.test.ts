import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * University-wide management figures against a real Postgres database.
 *
 * Every department in the university, each with its code. Computer Science has a
 * unit in Year 1, Year 2, a postgraduate unit (no year) and one whose code
 * has no digit (its students' year, 3); Mathematics has one Year 1 unit;
 * Physics has nothing yet.
 */
const TEST_DB = 'attendance_management_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

async function makeUser(role: 'LECTURER' | 'STUDENT' | 'MANAGEMENT', fullName: string) {
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

async function makeDepartment(name: string, code: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [name, code]);
  return d!.id;
}

async function makeLecturer(fullName: string, departmentId: string) {
  const user = await makeUser('LECTURER', fullName);
  const staffNumber = `STF/M${uniq()}`;
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, (SELECT name FROM departments WHERE id = $3))`,
    [user.id, staffNumber, departmentId]);
  return { ...user, staffNumber, fullName };
}

async function makeStudent(fullName: string, yearOfStudy: number) {
  const user = await makeUser('STUDENT', fullName);
  const registrationNumber = `EBT1/0${uniq()}/23`;
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, year_of_study, directory_source, directory_verified_at)
     VALUES ($1, $2, $3, 'SMARTTT', NOW())`,
    [user.id, registrationNumber, yearOfStudy]);
  return { ...user, registrationNumber, fullName };
}

/** The unit's department comes from its lecturer's (the units_default_department trigger). */
async function makeUnit(code: string, lecturerUserId: string): Promise<string> {
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, $2, $3, 'VERIFIED') RETURNING id`,
    [code, `${code} Course`, lecturerUserId]);
  return u!.id;
}

async function allocate(unitId: string, student: { id: string; registrationNumber: string; fullName: string }) {
  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 'ERP') RETURNING id`,
    [unitId, student.registrationNumber, student.id, student.fullName]);
  return a!.id;
}

const BASE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

async function holdClass(unitId: string, lecturerUserId: string, attendees: { studentUserId: string; allocationId: string }[]) {
  const opensAt = new Date(BASE.getTime() + uniq() * 3 * 60 * 60_000);
  const { rows: [s] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds, scheduled_start_at)
     VALUES ($1, $2, $3, 'CLOSED', $4::timestamptz, $4::timestamptz + INTERVAL '1 hour', 60, $4::timestamptz) RETURNING id`,
    [unitId, lecturerUserId, randomUUID(), opensAt]);
  for (const a of attendees) {
    await pool.query(
      `INSERT INTO attendance_records (session_id, student_user_id, allocation_id) VALUES ($1, $2, $3)`,
      [s!.id, a.studentUserId, a.allocationId]);
  }
}

const api = (auth: string) => ({ get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth) });

interface Fixture {
  management: { auth: string };
  lecturerAuth: string;
  csId: string;
  mathsId: string;
  physicsId: string;
  csLecturer: { fullName: string; staffNumber: string };
  wanjiru: { registrationNumber: string };
  otieno: { registrationNumber: string };
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const csId = await makeDepartment('Computer Science', 'DCOMP');
  const physicsId = await makeDepartment('Physics', 'DPHY');
  const mathsId = await makeDepartment('Mathematics', 'DMATH');

  // Management needs no profile row: the role alone sees every department.
  const officer = await makeUser('MANAGEMENT', 'Prof. Management');

  const csLecturer = await makeLecturer('Dr. Kamau', csId);
  const mathsLecturer = await makeLecturer('Dr. Achieng', mathsId);
  const wanjiru = await makeStudent('Wanjiru Mwangi', 3);
  const otieno = await makeStudent('Otieno Ouma', 3);

  const cosc103 = await makeUnit('COSC 103', csLecturer.id);
  const cosc210 = await makeUnit('COSC 210', csLecturer.id);
  await makeUnit('COSC 501', csLecturer.id); // postgraduate: no year
  const lab = await makeUnit('PROJECT LAB', csLecturer.id); // no digit: the students' year (3)
  const math110 = await makeUnit('MATH 110', mathsLecturer.id);

  const a103w = await allocate(cosc103, wanjiru);
  const a103o = await allocate(cosc103, otieno);
  const a210w = await allocate(cosc210, wanjiru);
  await allocate(cosc210, otieno);
  await allocate(lab, wanjiru);
  const a110w = await allocate(math110, wanjiru);
  const a110o = await allocate(math110, otieno);

  // COSC 103: 100% then 50%. COSC 210: 50%. MATH 110: 100%.
  await holdClass(cosc103, csLecturer.id, [{ studentUserId: wanjiru.id, allocationId: a103w }, { studentUserId: otieno.id, allocationId: a103o }]);
  await holdClass(cosc103, csLecturer.id, [{ studentUserId: wanjiru.id, allocationId: a103w }]);
  await holdClass(cosc210, csLecturer.id, [{ studentUserId: wanjiru.id, allocationId: a210w }]);
  await holdClass(math110, mathsLecturer.id, [{ studentUserId: wanjiru.id, allocationId: a110w }, { studentUserId: otieno.id, allocationId: a110o }]);

  return {
    management: officer,
    lecturerAuth: csLecturer.auth,
    csId,
    mathsId,
    physicsId,
    csLecturer,
    wanjiru,
    otieno,
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

interface DepartmentRow { departmentId: string; departmentName: string; departmentCode: string | null; checkIns: number; sessionsHeld: number; unitCount: number; studentCount: number; avgAttendanceRate: number | null }
interface YearRow { year: number; unitCount: number; studentCount: number; sessionsHeld: number; checkIns: number; avgAttendanceRate: number | null }
interface YearDetail { departmentName: string; year: number; units: { unitCode: string; lecturerName: string; staffNumber: string | null; avgAttendanceRate: number | null; students: { registrationNumber: string; sessionsAttended: number; sessionsHeld: number; attendanceRate: number | null; yearOfStudy: number | null }[] }[] }

describe('GET /management/departments', () => {
  it('lists every department in the university, most check-ins first', async () => {
    const res = await api(fx.management.auth).get('/management/departments');
    expect(res.status).toBe(200);
    const { totals, departments } = body<{ totals: { departmentCount: number; checkIns: number; sessionsHeld: number }; departments: DepartmentRow[] }>(res).data;

    expect(departments.map((d) => d.departmentName)).toEqual(['Computer Science', 'Mathematics', 'Physics']);
    expect(totals).toEqual({ departmentCount: 3, checkIns: 6, sessionsHeld: 4 });

    const [cs, maths, physics] = departments;
    expect(cs).toMatchObject({ departmentCode: 'DCOMP', checkIns: 4, sessionsHeld: 3, unitCount: 4, studentCount: 2 });
    expect(cs!.avgAttendanceRate).toBeCloseTo((100 + 50 + 50) / 3);
    expect(maths).toMatchObject({ departmentCode: 'DMATH', checkIns: 2, avgAttendanceRate: 100 });
    // Nothing held yet is null, not 0.
    expect(physics).toMatchObject({ checkIns: 0, sessionsHeld: 0, unitCount: 0, avgAttendanceRate: null });
  });

  it('is for management only', async () => {
    expect((await api(fx.lecturerAuth).get('/management/departments')).status).toBe(403);
    expect((await request(app).get('/api/v1/management/departments')).status).toBe(401);
  });
});

describe('GET /management/departments/:departmentId', () => {
  it('reports Years 1-4, placing units by the first digit of their code', async () => {
    const res = await api(fx.management.auth).get(`/management/departments/${fx.csId}`);
    expect(res.status).toBe(200);
    const data = body<{ departmentName: string; departmentCode: string; years: YearRow[]; unitsWithoutYear: number }>(res).data;

    expect(data).toMatchObject({ departmentName: 'Computer Science', departmentCode: 'DCOMP', unitsWithoutYear: 1 });
    expect(data.years.map((y) => y.year)).toEqual([1, 2, 3, 4]);
    const [y1, y2, y3, y4] = data.years;
    expect(y1).toEqual({ year: 1, unitCount: 1, studentCount: 2, sessionsHeld: 2, checkIns: 3, avgAttendanceRate: 75 });
    expect(y2).toEqual({ year: 2, unitCount: 1, studentCount: 2, sessionsHeld: 1, checkIns: 1, avgAttendanceRate: 50 });
    // "PROJECT LAB" has no digit: its students are in Year 3.
    expect(y3).toEqual({ year: 3, unitCount: 1, studentCount: 1, sessionsHeld: 0, checkIns: 0, avgAttendanceRate: null });
    expect(y4).toEqual({ year: 4, unitCount: 0, studentCount: 0, sessionsHeld: 0, checkIns: 0, avgAttendanceRate: null });
  });

  it('404s an unknown department and 400s a bad id', async () => {
    expect((await api(fx.management.auth).get(`/management/departments/${randomUUID()}`)).status).toBe(404);
    expect((await api(fx.management.auth).get('/management/departments/not-an-id')).status).toBe(400);
  });
});

describe('GET /management/departments/:departmentId/years/:year', () => {
  it("lists the year's units with their lecturer and each student's attendance", async () => {
    const res = await api(fx.management.auth).get(`/management/departments/${fx.csId}/years/1`);
    expect(res.status).toBe(200);
    const data = body<YearDetail>(res).data;

    expect(data).toMatchObject({ departmentName: 'Computer Science', year: 1 });
    expect(data.units).toHaveLength(1);
    const [unit] = data.units;
    expect(unit).toMatchObject({ unitCode: 'COSC 103', lecturerName: fx.csLecturer.fullName, staffNumber: fx.csLecturer.staffNumber, avgAttendanceRate: 75 });
    const students = Object.fromEntries(unit!.students.map((s) => [s.registrationNumber, s]));
    expect(students[fx.wanjiru.registrationNumber]).toMatchObject({ sessionsAttended: 2, sessionsHeld: 2, attendanceRate: 100, yearOfStudy: 3 });
    expect(students[fx.otieno.registrationNumber]).toMatchObject({ sessionsAttended: 1, sessionsHeld: 2, attendanceRate: 50 });
  });

  it('reports an empty year as no units', async () => {
    const res = await api(fx.management.auth).get(`/management/departments/${fx.csId}/years/4`);
    expect(res.status).toBe(200);
    expect(body<YearDetail>(res).data.units).toEqual([]);
  });

  it('only takes Years 1 to 4', async () => {
    expect((await api(fx.management.auth).get(`/management/departments/${fx.csId}/years/5`)).status).toBe(400);
    expect((await api(fx.management.auth).get(`/management/departments/${fx.mathsId}/years/0`)).status).toBe(400);
  });
});

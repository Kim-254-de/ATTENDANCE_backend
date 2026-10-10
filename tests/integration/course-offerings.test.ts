import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Course provisioning against a real Postgres database: faculty provides a
 * course to a department, the department decides how many lecturer-taught
 * segments it needs and allocates its own lecturers to them. The point of
 * this suite is proving the claim the plan made — that a unit created this
 * way needs zero changes to any existing read path — by checking the
 * resulting unit through the ordinary lecturer/session machinery, not just
 * asserting its columns.
 */
const TEST_DB = 'attendance_course_offerings_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

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
  const { rows: [f] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ($1) RETURNING id`, [name]);
  return f!.id;
}

async function makeDepartment(name: string, facultyId: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId]);
  return d!.id;
}

async function makeFacultyOfficer(fullName: string, facultyId: string) {
  const user = await makeUser('FACULTY', fullName);
  await pool.query(`INSERT INTO faculty_profiles (user_id, faculty_id, title) VALUES ($1, $2, 'Prof.')`, [user.id, facultyId]);
  return user;
}

async function makeDepartmentOfficer(fullName: string, departmentId: string) {
  const user = await makeUser('DEPARTMENT', fullName);
  await pool.query(`INSERT INTO department_profiles (user_id, department_id, title) VALUES ($1, $2, 'Dr.')`, [user.id, departmentId]);
  return user;
}

async function makeLecturer(fullName: string, departmentId: string) {
  const user = await makeUser('LECTURER', fullName);
  const staffNumber = `STF/CO${uniq()}`;
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, (SELECT name FROM departments WHERE id = $3))`,
    [user.id, staffNumber, departmentId]);
  return { ...user, staffNumber, fullName };
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
  patch: (path: string, data?: object) => request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(data),
});

interface Fixture {
  facultyOfficer: { id: string; auth: string };
  otherFacultyOfficer: { id: string; auth: string };
  deptOfficer: { id: string; auth: string };
  deptId: string;
  otherDeptId: string;
  lecturerA: { id: string; auth: string; fullName: string };
  lecturerB: { id: string; auth: string; fullName: string };
  outsiderLecturer: { id: string; fullName: string };
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const facultyId = await makeFaculty('Faculty of Provisioning');
  const otherFacultyId = await makeFaculty('Faculty of Elsewhere');
  const deptId = await makeDepartment('Department of Widgets', facultyId);
  const otherDeptId = await makeDepartment('Department of Elsewhere', otherFacultyId);

  const facultyOfficer = await makeFacultyOfficer('Faculty Officer', facultyId);
  const otherFacultyOfficer = await makeFacultyOfficer('Other Faculty Officer', otherFacultyId);
  const deptOfficer = await makeDepartmentOfficer('Dept Officer', deptId);

  const lecturerA = await makeLecturer('Dr. Widget A', deptId);
  const lecturerB = await makeLecturer('Dr. Widget B', deptId);
  const outsiderLecturer = await makeLecturer('Dr. Elsewhere', otherDeptId);

  return { facultyOfficer, otherFacultyOfficer, deptOfficer, deptId, otherDeptId, lecturerA, lecturerB, outsiderLecturer };
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

describe('POST /faculties/departments', () => {
  it('creates a department in the caller\'s own faculty', async () => {
    const res = await api(fx.facultyOfficer.auth).post('/faculties/departments', { name: 'Department of Gadgets' });
    expect(res.status).toBe(201);
    expect(body<{ departmentName: string }>(res).data.departmentName).toBe('Department of Gadgets');

    const listed = await api(fx.facultyOfficer.auth).get('/faculties/departments');
    expect(body<Array<{ departmentName: string }>>(listed).data.map((d) => d.departmentName)).toContain('Department of Gadgets');
  });

  it('rejects a duplicate department name', async () => {
    const res = await api(fx.facultyOfficer.auth).post('/faculties/departments', { name: 'Department of Widgets' });
    expect(res.status).toBe(409);
  });

  it('refuses a department officer or lecturer', async () => {
    expect((await api(fx.deptOfficer.auth).post('/faculties/departments', { name: 'Nope' })).status).toBe(403);
  });
});

describe('POST /faculties/departments/:departmentId/courses', () => {
  it('provides a course to one of the caller\'s own departments', async () => {
    const res = await api(fx.facultyOfficer.auth).post(`/faculties/departments/${fx.deptId}/courses`, { code: 'wgt 101', name: 'Intro to Widgets' });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ code: 'WGT 101', name: 'Intro to Widgets', departmentId: fx.deptId, segmentsPlanned: 1 });
  });

  it('404s on a department in another faculty instead of confirming it exists', async () => {
    const res = await api(fx.facultyOfficer.auth).post(`/faculties/departments/${fx.otherDeptId}/courses`, { code: 'ELSE 100' });
    expect(res.status).toBe(404);
  });

  it('rejects a duplicate course code', async () => {
    const res = await api(fx.facultyOfficer.auth).post(`/faculties/departments/${fx.deptId}/courses`, { code: 'WGT 101' });
    expect(res.status).toBe(409);
  });
});

describe('the whole provisioning flow', () => {
  let offeringId: string;

  it('the department sees the course faculty provided, unfilled', async () => {
    const res = await api(fx.deptOfficer.auth).get('/departments/courses');
    expect(res.status).toBe(200);
    const rows = body<Array<{ id: string; code: string; segmentsPlanned: number; segmentsFilled: number }>>(res).data;
    const row = rows.find((r) => r.code === 'WGT 101');
    expect(row).toMatchObject({ segmentsPlanned: 1, segmentsFilled: 0 });
    offeringId = row!.id;
  });

  it('the department sets how many sections the course needs', async () => {
    const res = await api(fx.deptOfficer.auth).patch(`/departments/courses/${offeringId}`, { segmentsPlanned: 2 });
    expect(res.status).toBe(200);
  });

  it('refuses a lecturer outside the department', async () => {
    const res = await api(fx.deptOfficer.auth).post(`/departments/courses/${offeringId}/segments`, { lecturerUserId: fx.outsiderLecturer.id });
    expect(res.status).toBe(400);
  });

  it('allocates the first lecturer, creating a real, immediately usable unit', async () => {
    const res = await api(fx.deptOfficer.auth).post(`/departments/courses/${offeringId}/segments`, { lecturerUserId: fx.lecturerA.id });
    expect(res.status).toBe(201);
    expect(body<{ code: string }>(res).data.code).toBe('WGT 101 GR A');

    const { rows: [unit] } = await pool.query<{ status: string; base_code: string; class_group: string; offering_id: string }>(
      `SELECT status, base_code, class_group, offering_id FROM units WHERE code = 'WGT 101 GR A'`);
    expect(unit).toMatchObject({ status: 'VERIFIED', base_code: 'WGT 101', class_group: 'GR A', offering_id: offeringId });

    // No special-casing anywhere: the lecturer's own dashboard already counts it.
    const overview = await api(fx.lecturerA.auth).get('/lecturers/overview');
    expect(body<{ unitsTaught: number }>(overview).data.unitsTaught).toBe(1);
  });

  it('allocates the second lecturer to segment B', async () => {
    const res = await api(fx.deptOfficer.auth).post(`/departments/courses/${offeringId}/segments`, { lecturerUserId: fx.lecturerB.id });
    expect(res.status).toBe(201);
    expect(body<{ code: string }>(res).data.code).toBe('WGT 101 GR B');
  });

  it('the department\'s own oversight endpoint already shows both lecturers, no changes needed', async () => {
    const res = await api(fx.deptOfficer.auth).get('/departments/lecturers');
    const rows = body<Array<{ fullName: string }>>(res).data;
    expect(rows.map((r) => r.fullName)).toEqual(expect.arrayContaining(['Dr. Widget A', 'Dr. Widget B']));
  });

  it('refuses a third allocation once every planned segment is filled', async () => {
    const res = await api(fx.deptOfficer.auth).post(`/departments/courses/${offeringId}/segments`, { lecturerUserId: fx.lecturerB.id });
    expect(res.status).toBe(409);
  });

  it('refuses to shrink the segment count below what is already filled', async () => {
    const res = await api(fx.deptOfficer.auth).patch(`/departments/courses/${offeringId}`, { segmentsPlanned: 1 });
    expect(res.status).toBe(400);
  });
});

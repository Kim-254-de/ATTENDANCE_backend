import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The oversight backlog against a real Postgres database: placing and moving
 * lecturers between departments by hand, the exam-eligibility rule and its
 * reports, and student course evaluations.
 *
 * Fixture: two faculties. Science has Computer Science and Mathematics; Arts
 * has History. One CS unit (CSC 101) has three students with 4, 3 and 1 of 4
 * classes attended (100%, 75%, 25%), so against the default 75% rule with a
 * 10-point margin they are eligible, at risk and not eligible.
 */
const TEST_DB = 'attendance_oversight_backlog_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

type Role = 'LECTURER' | 'STUDENT' | 'DEPARTMENT' | 'FACULTY' | 'QA' | 'ADMIN';

async function makeUser(role: Role, fullName: string) {
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

const one = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0] as T;

const makeFaculty = async (name: string) => (await one<{ id: string }>(`INSERT INTO faculties (name) VALUES ($1) RETURNING id`, [name])).id;
const makeDepartment = async (name: string, facultyId: string) =>
  (await one<{ id: string }>(`INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId])).id;

async function makeLecturer(fullName: string, departmentId: string | null, reportedDepartment: string | null = null) {
  const user = await makeUser('LECTURER', fullName);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, COALESCE($4, (SELECT name FROM departments WHERE id = $3)))`,
    [user.id, `STF/O${uniq()}`, departmentId, reportedDepartment]);
  return user;
}

async function makeDepartmentOfficer(departmentId: string) {
  const user = await makeUser('DEPARTMENT', 'Dept Officer');
  await pool.query(`INSERT INTO department_profiles (user_id, department_id) VALUES ($1, $2)`, [user.id, departmentId]);
  return user;
}

async function makeFacultyOfficer(facultyId: string) {
  const user = await makeUser('FACULTY', 'Faculty Officer');
  await pool.query(`INSERT INTO faculty_profiles (user_id, faculty_id) VALUES ($1, $2)`, [user.id, facultyId]);
  return user;
}

async function makeQa() {
  const user = await makeUser('QA', 'QA Officer');
  await pool.query(`INSERT INTO qa_profiles (user_id, title) VALUES ($1, 'QA Officer')`, [user.id]);
  return user;
}

async function makeStudent(fullName: string) {
  const user = await makeUser('STUDENT', fullName);
  const reg = `REG/O${uniq()}`;
  await pool.query(`INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at) VALUES ($1, $2, 'ERP', NOW())`, [user.id, reg]);
  return { ...user, reg, fullName };
}

const makeUnit = async (code: string, lecturerUserId: string) =>
  (await one<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, $2, $3, 'VERIFIED') RETURNING id`,
    [code, `${code} Course`, lecturerUserId])).id;

const allocate = async (unitId: string, s: { id: string; reg: string; fullName: string }) =>
  (await one<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 'ERP') RETURNING id`,
    [unitId, s.reg, s.id, s.fullName])).id;

const BASE = Date.now() - 14 * 24 * 60 * 60 * 1000;

const makeClosedSession = async (unitId: string, lecturerUserId: string, dayOffset: number) =>
  (await one<{ id: string }>(
    `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds)
     VALUES ($1, $2, $3, 'CLOSED', $4::timestamptz, $4::timestamptz + INTERVAL '1 hour', 60) RETURNING id`,
    [unitId, lecturerUserId, randomUUID(), new Date(BASE + dayOffset * 24 * 60 * 60 * 1000)])).id;

const checkIn = (sessionId: string, studentUserId: string, allocationId: string) =>
  pool.query(`INSERT INTO attendance_records (session_id, student_user_id, allocation_id) VALUES ($1, $2, $3)`,
    [sessionId, studentUserId, allocationId]);

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
  put: (path: string, data?: object) => request(app).put(`/api/v1${path}`).set('Authorization', auth).send(data),
  patch: (path: string, data?: object) => request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(data),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

type User = { id: string; auth: string };
type Student = User & { reg: string; fullName: string };
interface Fixture {
  scienceId: string; artsId: string;
  csId: string; mathsId: string; historyId: string;
  csOfficer: User; mathsOfficer: User; historyOfficer: User;
  scienceOfficer: User; artsOfficer: User;
  qa: User; admin: User;
  csLecturer: User; unassigned: User; historian: User;
  csUnit: string; mathsUnit: string;
  full: Student; borderline: Student; absent: Student; mathsStudent: Student;
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const scienceId = await makeFaculty('Science');
  const artsId = await makeFaculty('Arts');
  const csId = await makeDepartment('Computer Science', scienceId);
  const mathsId = await makeDepartment('Mathematics', scienceId);
  const historyId = await makeDepartment('History', artsId);

  const csLecturer = await makeLecturer('Dr. Coder', csId);
  const mathsLecturer = await makeLecturer('Dr. Number', mathsId);
  const historian = await makeLecturer('Dr. Past', historyId);
  const unassigned = await makeLecturer('Dr. Nowhere', null, 'Comp. Sci.');

  const csUnit = await makeUnit('CSC 101', csLecturer.id);
  const mathsUnit = await makeUnit('MAT 101', mathsLecturer.id);

  const full = await makeStudent('Alice Always');
  const borderline = await makeStudent('Bob Borderline');
  const absent = await makeStudent('Carol Absent');
  const mathsStudent = await makeStudent('Dan Maths');
  const allocations = {
    full: await allocate(csUnit, full),
    borderline: await allocate(csUnit, borderline),
    absent: await allocate(csUnit, absent),
  };
  await allocate(mathsUnit, mathsStudent);

  for (let day = 0; day < 4; day += 1) {
    const session = await makeClosedSession(csUnit, csLecturer.id, day);
    await checkIn(session, full.id, allocations.full);
    if (day < 3) await checkIn(session, borderline.id, allocations.borderline);
    if (day === 0) await checkIn(session, absent.id, allocations.absent);
  }

  return {
    scienceId, artsId, csId, mathsId, historyId,
    csOfficer: await makeDepartmentOfficer(csId),
    mathsOfficer: await makeDepartmentOfficer(mathsId),
    historyOfficer: await makeDepartmentOfficer(historyId),
    scienceOfficer: await makeFacultyOfficer(scienceId),
    artsOfficer: await makeFacultyOfficer(artsId),
    qa: await makeQa(),
    admin: await makeUser('ADMIN', 'Admin'),
    csLecturer, unassigned, historian,
    csUnit, mathsUnit,
    full, borderline, absent, mathsStudent,
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

describe('units belong to a department', () => {
  it('a unit created for a lecturer takes the lecturer\'s department', async () => {
    const unit = await one<{ department_id: string }>(`SELECT department_id FROM units WHERE id = $1`, [fx.csUnit]);
    expect(unit.department_id).toBe(fx.csId);
  });
});

describe('placing lecturers in departments', () => {
  type Placement = { userId: string; fullName: string; departmentId: string | null; reportedDepartment: string | null };

  it('lists unassigned lecturers first, with the department name SMARTTT reported, to any faculty officer', async () => {
    const res = await api(fx.scienceOfficer.auth).get('/faculties/lecturer-placement');
    expect(res.status).toBe(200);
    const rows = body<Placement[]>(res).data;
    expect(rows[0]).toMatchObject({ fullName: 'Dr. Nowhere', departmentId: null, reportedDepartment: 'Comp. Sci.' });
    // The faculty's own staff, never another faculty's.
    expect(rows.map((r) => r.fullName)).toEqual(expect.arrayContaining(['Dr. Coder', 'Dr. Number']));
    expect(rows.map((r) => r.fullName)).not.toContain('Dr. Past');

    const onlyUnassigned = body<Placement[]>(await api(fx.artsOfficer.auth).get('/faculties/lecturer-placement?unassigned=true')).data;
    expect(onlyUnassigned.map((r) => r.fullName)).toEqual(['Dr. Nowhere']);
  });

  it('an unassigned lecturer is invisible to every department until placed', async () => {
    const rows = body<Array<{ fullName: string }>>(await api(fx.csOfficer.auth).get('/departments/lecturers')).data;
    expect(rows.map((r) => r.fullName)).not.toContain('Dr. Nowhere');
  });

  it('a faculty officer cannot place a lecturer in another faculty\'s department', async () => {
    const res = await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${fx.unassigned.id}/department`, { departmentId: fx.historyId });
    expect(res.status).toBe(400);
  });

  it('a faculty officer places an unassigned lecturer, and it is audited', async () => {
    const res = await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${fx.unassigned.id}/department`, { departmentId: fx.csId });
    expect(res.status).toBe(200);
    expect(body<Placement>(res).data.departmentId).toBe(fx.csId);

    const rows = body<Array<{ fullName: string }>>(await api(fx.csOfficer.auth).get('/departments/lecturers')).data;
    expect(rows.map((r) => r.fullName)).toContain('Dr. Nowhere');

    const audit = await one<{ user_id: string; metadata: { toDepartmentId: string; fromDepartmentId: string | null; by: string } }>(
      `SELECT user_id, metadata FROM audit_logs WHERE action = 'LECTURER_DEPARTMENT_CHANGED' ORDER BY created_at DESC LIMIT 1`);
    expect(audit).toMatchObject({ user_id: fx.scienceOfficer.id, metadata: { toDepartmentId: fx.csId, fromDepartmentId: null, by: 'FACULTY' } });
  });

  it('moves a lecturer between the faculty\'s departments, leaving their units with the department that owns them', async () => {
    const res = await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${fx.csLecturer.id}/department`, { departmentId: fx.mathsId });
    expect(res.status).toBe(200);
    const unit = await one<{ department_id: string }>(`SELECT department_id FROM units WHERE id = $1`, [fx.csUnit]);
    expect(unit.department_id).toBe(fx.csId);

    // CS still sees the unit and the lecturer teaching it, now as borrowed.
    const lecturers = body<Array<{ fullName: string; isOwnStaff: boolean }>>(await api(fx.csOfficer.auth).get('/departments/lecturers')).data;
    expect(lecturers.find((l) => l.fullName === 'Dr. Coder')).toMatchObject({ isOwnStaff: false });
    // Move them back for the rest of the suite.
    await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${fx.csLecturer.id}/department`, { departmentId: fx.csId });
  });

  it('404s on a lecturer in another faculty, instead of confirming they exist', async () => {
    const res = await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${fx.historian.id}/department`, { departmentId: fx.csId });
    expect(res.status).toBe(404);
  });

  it('an administrator may move a lecturer across faculties', async () => {
    const departments = body<Array<{ departmentId: string; facultyName: string }>>(await api(fx.admin.auth).get('/admin/departments')).data;
    expect(departments).toHaveLength(3);

    const list = body<Placement[]>(await api(fx.admin.auth).get('/admin/lecturers?q=past')).data;
    expect(list.map((r) => r.fullName)).toEqual(['Dr. Past']);

    const res = await api(fx.admin.auth).patch(`/admin/lecturers/${fx.historian.id}/department`, { departmentId: fx.mathsId });
    expect(res.status).toBe(200);
    expect(body<Placement>(res).data.departmentId).toBe(fx.mathsId);
    await api(fx.admin.auth).patch(`/admin/lecturers/${fx.historian.id}/department`, { departmentId: fx.historyId });
  });

  it('refuses everyone but faculty officers and administrators', async () => {
    expect((await api(fx.csOfficer.auth).get('/faculties/lecturer-placement')).status).toBe(403);
    expect((await api(fx.qa.auth).patch(`/admin/lecturers/${fx.historian.id}/department`, { departmentId: fx.csId })).status).toBe(403);
  });

  it('a new department picks up unassigned lecturers whose SMARTTT department name matches', async () => {
    const lecturer = await makeLecturer('Dr. Early', null, 'Physics');
    const res = await api(fx.scienceOfficer.auth).post('/faculties/departments', { name: 'physics' });
    expect(res.status).toBe(201);
    const profile = await one<{ department_id: string }>(`SELECT department_id FROM lecturer_profiles WHERE user_id = $1`, [lecturer.id]);
    expect(profile.department_id).toBe(body<{ departmentId: string }>(res).data.departmentId);
  });
});

// ---------------------------------------------------------------------------

describe('unifying department spellings', () => {
  const keyOf = async (name: string) => (await one<{ k: string | null }>(`SELECT department_key($1) AS k`, [name])).k;
  const departmentFor = async (name: string) => (await one<{ id: string | null }>(`SELECT department_for_name($1) AS id`, [name])).id;

  it('reads punctuation, "Department of", "&" and common abbreviations as the same name', async () => {
    expect(await keyOf('Dept. of Computer Science')).toBe('computer science')
    expect(await keyOf('The Department of  COMPUTER science ')).toBe('computer science')
    expect(await keyOf('Comp. Sci & IT')).toBe(await keyOf('Computer Science and Information Technology'))
    expect(await keyOf('Maths')).toBe('mathematics')
    expect(await departmentFor('dept of mathematics')).toBe(fx.mathsId)
    expect(await departmentFor('Underwater Basket Weaving')).toBeNull()
  });

  it('refuses a new department that is only another spelling of an existing one', async () => {
    const res = await api(fx.scienceOfficer.auth).post('/faculties/departments', { name: 'Department of Mathematics' });
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/same department as "Mathematics"/);
  });

  it('learns SMARTTT\'s spelling when an unassigned lecturer is placed, and places everyone else spelled the same', async () => {
    const first = await makeLecturer('Dr. Spelling One', null, 'Comp. Sci & IT');
    const second = await makeLecturer('Dr. Spelling Two', null, 'Computer Science and I.T.');
    expect(await departmentFor('Comp. Sci & IT')).toBeNull();

    const res = await api(fx.scienceOfficer.auth).patch(`/faculties/lecturers/${first.id}/department`, { departmentId: fx.csId });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ departmentId: fx.csId, learnedSpelling: 'Comp. Sci & IT', alsoPlaced: 1 });

    const other = await one<{ department_id: string }>(`SELECT department_id FROM lecturer_profiles WHERE user_id = $1`, [second.id]);
    expect(other.department_id).toBe(fx.csId);
    // The next sign-in with that spelling, however punctuated, now matches.
    expect(await departmentFor('COMP SCI and IT')).toBe(fx.csId);

    const aliases = body<Array<{ alias: string; departmentName: string; source: string }>>(await api(fx.admin.auth).get('/admin/department-aliases')).data;
    expect(aliases).toEqual([expect.objectContaining({ alias: 'Comp. Sci & IT', departmentName: 'Computer Science', source: 'PLACEMENT' })]);
  });

  it('lets an administrator remove a wrongly learned spelling', async () => {
    const [alias] = body<Array<{ aliasId: string }>>(await api(fx.admin.auth).get('/admin/department-aliases')).data;
    expect((await api(fx.admin.auth).delete(`/admin/department-aliases/${alias!.aliasId}`)).status).toBe(204);
    expect(await departmentFor('Comp. Sci & IT')).toBeNull();
    expect((await api(fx.admin.auth).delete(`/admin/department-aliases/${alias!.aliasId}`)).status).toBe(404);
  });

  it('lists duplicate departments and merges one into the other, moving everything across', async () => {
    // Created before this rule existed, the way the real database already has one.
    const duplicateId = await makeDepartment('Dept. of History', fx.artsId);
    const lecturer = await makeLecturer('Dr. Duplicate', duplicateId);
    const unit = await makeUnit('HIS 900', lecturer.id);
    const officer = await makeDepartmentOfficer(duplicateId);

    const groups = body<Array<Array<{ departmentId: string; name: string }>>>(await api(fx.admin.auth).get('/admin/department-duplicates')).data;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((d) => d.name).sort()).toEqual(['Dept. of History', 'History']);

    expect((await api(fx.csOfficer.auth).post(`/admin/departments/${duplicateId}/merge`, { intoDepartmentId: fx.historyId })).status).toBe(403);
    expect((await api(fx.admin.auth).post(`/admin/departments/${duplicateId}/merge`, { intoDepartmentId: duplicateId })).status).toBe(400);
    const res = await api(fx.admin.auth).post(`/admin/departments/${duplicateId}/merge`, { intoDepartmentId: fx.historyId });
    expect(res.status).toBe(200);

    expect((await one<{ department_id: string }>(`SELECT department_id FROM lecturer_profiles WHERE user_id = $1`, [lecturer.id])).department_id).toBe(fx.historyId);
    expect((await one<{ department_id: string }>(`SELECT department_id FROM units WHERE id = $1`, [unit])).department_id).toBe(fx.historyId);
    expect((await one<{ department_id: string }>(`SELECT department_id FROM department_profiles WHERE user_id = $1`, [officer.id])).department_id).toBe(fx.historyId);
    expect((await pool.query(`SELECT 1 FROM departments WHERE id = $1`, [duplicateId])).rowCount).toBe(0);
    expect(body(await api(fx.admin.auth).get('/admin/department-duplicates')).data).toEqual([]);

    const audit = await one<{ metadata: { mergedName: string; keptName: string } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'DEPARTMENTS_MERGED' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.metadata).toMatchObject({ mergedName: 'Dept. of History', keptName: 'History' });
  });
});

// ---------------------------------------------------------------------------

type Report = {
  policy: { minAttendancePercent: number; atRiskMarginPercent: number };
  summary: { total: number; eligible: number; atRisk: number; notEligible: number; notYetMeasured: number };
  rows: Array<{ fullName: string; status: string; attendanceRate: number | null; unitCode: string }>;
};

describe('exam eligibility', () => {
  it('every signed-in user can read the rule; it defaults to 75% with a 10-point margin', async () => {
    const res = await api(fx.full.auth).get('/attendance-policy');
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ minAttendancePercent: 75, atRiskMarginPercent: 10 });
  });

  it('the department sees who is at risk and who is below, worst first, and eligible students only in the counts', async () => {
    const res = await api(fx.csOfficer.auth).get('/departments/eligibility');
    expect(res.status).toBe(200);
    const report = body<Report>(res).data;
    expect(report.summary).toEqual({ total: 3, eligible: 1, atRisk: 1, notEligible: 1, notYetMeasured: 0 });
    expect(report.rows.map((r) => [r.fullName, r.status, r.attendanceRate])).toEqual([
      ['Carol Absent', 'NOT_ELIGIBLE', 25],
      ['Bob Borderline', 'AT_RISK', 75],
    ]);

    const all = body<Report>(await api(fx.csOfficer.auth).get('/departments/eligibility?all=true')).data;
    expect(all.rows).toHaveLength(3);
  });

  it('another department sees none of them; a unit with no classes yet is not judged', async () => {
    const report = body<Report>(await api(fx.mathsOfficer.auth).get('/departments/eligibility')).data;
    expect(report.summary).toEqual({ total: 1, eligible: 0, atRisk: 0, notEligible: 0, notYetMeasured: 1 });
    expect(report.rows).toEqual([]);
  });

  it('the faculty sees its departments, and may narrow to one of them but not another faculty\'s', async () => {
    const report = body<Report>(await api(fx.scienceOfficer.auth).get('/faculties/eligibility')).data;
    expect(report.summary.total).toBe(4);
    expect((await api(fx.scienceOfficer.auth).get(`/faculties/eligibility?departmentId=${fx.mathsId}`)).status).toBe(200);
    expect((await api(fx.scienceOfficer.auth).get(`/faculties/eligibility?departmentId=${fx.historyId}`)).status).toBe(404);
    expect(body<Report>(await api(fx.artsOfficer.auth).get('/faculties/eligibility')).data.summary.total).toBe(0);
  });

  it('only QA may change the rule; the change is audited and every report follows it', async () => {
    expect((await api(fx.csOfficer.auth).put('/quality-assurance/attendance-policy', { minAttendancePercent: 70 })).status).toBe(403);
    expect((await api(fx.qa.auth).put('/quality-assurance/attendance-policy', {})).status).toBe(400);
    expect((await api(fx.qa.auth).put('/quality-assurance/attendance-policy', { minAttendancePercent: 101 })).status).toBe(400);

    const res = await api(fx.qa.auth).put('/quality-assurance/attendance-policy', { minAttendancePercent: 66.67, atRiskMarginPercent: 5 });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ minAttendancePercent: 66.67, atRiskMarginPercent: 5, updatedByName: 'QA Officer' });

    // 75% is now comfortably above two-thirds + 5.
    const report = body<Report>(await api(fx.qa.auth).get(`/quality-assurance/eligibility?facultyId=${fx.scienceId}`)).data;
    expect(report.summary).toMatchObject({ eligible: 2, atRisk: 0, notEligible: 1 });

    const audit = await one<{ metadata: { to: { minAttendancePercent: number } } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'ATTENDANCE_POLICY_UPDATED' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.metadata.to.minAttendancePercent).toBe(66.67);
    await api(fx.qa.auth).put('/quality-assurance/attendance-policy', { minAttendancePercent: 75, atRiskMarginPercent: 10 });
  });
});

// ---------------------------------------------------------------------------

type Round = { id: string; status: string; questions: Array<{ id: string; kind: string; prompt: string }>; questionsEditable: boolean };
type StudentRound = { id: string; units: Array<{ unitCode: string; submitted: boolean }>; questions: Array<{ id: string; kind: string }> };
type Results = {
  totalResponses: number;
  overall: Array<{ questionId: string; average: number; distribution: number[] }>;
  units: Array<{ unitCode: string; responses: number; enrolled: number; responseRate: number | null; reportable: boolean;
    ratings: Array<{ questionId: string; average: number }>; comments: Array<{ text: string }> }>;
};

describe('student course evaluations', () => {
  let round: Round;
  const hour = 60 * 60 * 1000;
  const answersFor = (r: { questions: Array<{ id: string; kind: string }> }, rating: number, text?: string) => ({
    answers: r.questions.map((q) => (q.kind === 'RATING' ? { questionId: q.id, rating } : { questionId: q.id, ...(text ? { text } : {}) })),
  });

  it('QA creates a round with rating and comment questions', async () => {
    const res = await api(fx.qa.auth).post('/quality-assurance/evaluations', {
      title: 'Semester 1 evaluation',
      opensAt: new Date(Date.now() - hour).toISOString(),
      closesAt: new Date(Date.now() + 24 * hour).toISOString(),
      minResponses: 2,
      questions: [
        { prompt: 'The lecturer explained the material clearly.', kind: 'RATING' },
        { prompt: 'The unit was well organised.', kind: 'RATING' },
        { prompt: 'Anything else?', kind: 'TEXT', required: false },
      ],
    });
    expect(res.status).toBe(201);
    round = body<Round>(res).data;
    expect(round).toMatchObject({ status: 'OPEN', questionsEditable: true });
    expect(round.questions.map((q) => q.kind)).toEqual(['RATING', 'RATING', 'TEXT']);
  });

  it('refuses a round that closes before it opens, and non-QA callers', async () => {
    const now = Date.now();
    expect((await api(fx.qa.auth).post('/quality-assurance/evaluations', {
      title: 'Backwards', opensAt: new Date(now).toISOString(), closesAt: new Date(now - hour).toISOString(),
      questions: [{ prompt: 'Why?', kind: 'TEXT' }],
    })).status).toBe(400);
    expect((await api(fx.csOfficer.auth).get('/quality-assurance/evaluations')).status).toBe(403);
  });

  it('a student sees the open round with their own units only', async () => {
    const res = await api(fx.full.auth).get('/students/me/evaluations');
    expect(res.status).toBe(200);
    const rounds = body<StudentRound[]>(res).data;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.units).toEqual([expect.objectContaining({ unitCode: 'CSC 101', submitted: false })]);
  });

  it('validates answers: required questions, ratings 1-5, the right kind of answer', async () => {
    const path = `/students/me/evaluations/${round.id}/units/${fx.csUnit}`;
    const [clarity, organised, comment] = round.questions;
    expect((await api(fx.full.auth).post(path, { answers: [{ questionId: clarity!.id, rating: 4 }] })).status).toBe(400);
    expect((await api(fx.full.auth).post(path, { answers: [
      { questionId: clarity!.id, rating: 6 }, { questionId: organised!.id, rating: 4 }] })).status).toBe(400);
    expect((await api(fx.full.auth).post(path, { answers: [
      { questionId: clarity!.id, text: 'great' }, { questionId: organised!.id, rating: 4 }] })).status).toBe(400);
    expect((await api(fx.full.auth).post(path, { answers: [
      { questionId: clarity!.id, rating: 4 }, { questionId: organised!.id, rating: 4 }, { questionId: comment!.id, rating: 3 }] })).status).toBe(400);
  });

  it('404s on a unit the student is not on', async () => {
    const res = await api(fx.full.auth).post(`/students/me/evaluations/${round.id}/units/${fx.mathsUnit}`, answersFor(round, 5));
    expect(res.status).toBe(404);
  });

  it('records one anonymous response per student and unit', async () => {
    const path = `/students/me/evaluations/${round.id}/units/${fx.csUnit}`;
    expect((await api(fx.full.auth).post(path, answersFor(round, 5, 'Brilliant'))).status).toBe(204);
    expect((await api(fx.full.auth).post(path, answersFor(round, 1))).status).toBe(409);

    const rounds = body<StudentRound[]>(await api(fx.full.auth).get('/students/me/evaluations')).data;
    expect(rounds[0]!.units[0]!.submitted).toBe(true);

    // Nothing stored with the answer says who gave it.
    const columns = (await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('qa_evaluation_responses', 'qa_evaluation_answers')`)).rows.map((r) => r.column_name);
    expect(columns).not.toContain('student_user_id');
    expect(columns).not.toContain('created_at');
  });

  it('withholds a unit\'s ratings and comments until it reaches the round\'s minimum responses', async () => {
    const results = body<Results>(await api(fx.csOfficer.auth).get(`/departments/evaluations/${round.id}`)).data;
    expect(results.units).toEqual([expect.objectContaining({ unitCode: 'CSC 101', responses: 1, enrolled: 3, reportable: false, ratings: [], comments: [] })]);
    expect(results.overall).toEqual([]);
  });

  it('once enough students answer, the department sees averages, distributions and comments', async () => {
    const path = `/students/me/evaluations/${round.id}/units/${fx.csUnit}`;
    expect((await api(fx.borderline.auth).post(path, answersFor(round, 3, 'Too fast'))).status).toBe(204);

    const results = body<Results>(await api(fx.csOfficer.auth).get(`/departments/evaluations/${round.id}`)).data;
    const unit = results.units[0]!;
    expect(unit).toMatchObject({ responses: 2, reportable: true, responseRate: 66.7 });
    expect(unit.ratings.map((r) => r.average)).toEqual([4, 4]);
    expect(unit.comments.map((c) => c.text)).toEqual(['Brilliant', 'Too fast']);
    expect(results.overall[0]).toMatchObject({ average: 4, distribution: [0, 0, 1, 0, 1] });
  });

  it('another department sees nothing; the faculty and QA see it; a faculty cannot narrow to another faculty\'s department', async () => {
    expect(body<Results>(await api(fx.mathsOfficer.auth).get(`/departments/evaluations/${round.id}`)).data.units).toEqual([]);
    expect(body<Results>(await api(fx.scienceOfficer.auth).get(`/faculties/evaluations/${round.id}`)).data.totalResponses).toBe(2);
    expect(body<Results>(await api(fx.artsOfficer.auth).get(`/faculties/evaluations/${round.id}`)).data.totalResponses).toBe(0);
    expect((await api(fx.scienceOfficer.auth).get(`/faculties/evaluations/${round.id}?departmentId=${fx.historyId}`)).status).toBe(404);
    expect(body<Results>(await api(fx.qa.auth).get(`/quality-assurance/evaluations/${round.id}/results?departmentId=${fx.csId}`)).data.totalResponses).toBe(2);
  });

  it('fixes the questions once anyone has answered, and refuses to delete the round', async () => {
    const detail = body<Round>(await api(fx.qa.auth).get(`/quality-assurance/evaluations/${round.id}`)).data;
    expect(detail.questionsEditable).toBe(false);
    expect((await api(fx.qa.auth).patch(`/quality-assurance/evaluations/${round.id}`, {
      questions: [{ prompt: 'Something else entirely', kind: 'RATING' }] })).status).toBe(409);
    expect((await api(fx.qa.auth).patch(`/quality-assurance/evaluations/${round.id}`, { title: 'Semester 1 (extended)' })).status).toBe(200);
    expect((await api(fx.qa.auth).delete(`/quality-assurance/evaluations/${round.id}`)).status).toBe(409);
  });

  it('closing the round stops submissions and drops it from the student\'s list', async () => {
    const res = await api(fx.qa.auth).post(`/quality-assurance/evaluations/${round.id}/close`);
    expect(body<Round>(res).data.status).toBe('CLOSED');
    expect(body<StudentRound[]>(await api(fx.absent.auth).get('/students/me/evaluations')).data).toEqual([]);
    expect((await api(fx.absent.auth).post(`/students/me/evaluations/${round.id}/units/${fx.csUnit}`, answersFor(round, 2))).status).toBe(404);
  });

  it('an upcoming round is hidden from officers and students, but QA may edit or delete it freely', async () => {
    const res = await api(fx.qa.auth).post('/quality-assurance/evaluations', {
      title: 'Next semester',
      opensAt: new Date(Date.now() + 24 * hour).toISOString(),
      closesAt: new Date(Date.now() + 48 * hour).toISOString(),
      questions: [{ prompt: 'Draft question', kind: 'RATING' }],
    });
    const draft = body<Round>(res).data;
    expect(draft.status).toBe('UPCOMING');
    expect(body<Array<{ id: string }>>(await api(fx.csOfficer.auth).get('/departments/evaluations')).data.map((r) => r.id)).not.toContain(draft.id);
    expect((await api(fx.csOfficer.auth).get(`/departments/evaluations/${draft.id}`)).status).toBe(404);
    expect((await api(fx.qa.auth).patch(`/quality-assurance/evaluations/${draft.id}`, {
      questions: [{ prompt: 'Better question', kind: 'RATING' }] })).status).toBe(200);
    expect((await api(fx.qa.auth).delete(`/quality-assurance/evaluations/${draft.id}`)).status).toBe(204);
  });
});

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Joined from parts so a secret scanner doesn't mistake a test fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

/**
 * Account deletion (auth.deletion.ts) against a real Postgres database: a
 * student or lecturer deleting their own account, and department and faculty
 * officers deleting accounts in their scope. Deleting anonymises; these tests
 * check both what goes and what has to stay for the attendance figures.
 */
const TEST_DB = 'attendance_account_deletion_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const PASSWORD = fake('Correct-Hor', 'se-Battery-9');

let app: Express;
let pool: pg.Pool;
let passwordHash: string;

const uniq = (() => { let n = 0; return () => ++n; })();

type Role = 'LECTURER' | 'STUDENT' | 'DEPARTMENT' | 'FACULTY';

/** A signed-in user with a real password, as a bearer token. */
async function makeUser(role: Role, fullName: string) {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, $2, $3, $4, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${n}@uni.ac.ke`, passwordHash, fullName, role]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

async function makeDepartment(name: string, facultyId: string): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId]);
  return d!.id;
}

async function makeLecturer(departmentId: string) {
  const user = await makeUser('LECTURER', `Lecturer ${uniq()}`);
  const staffNumber = `STF/${uniq()}`;
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, phone)
     VALUES ($1, $2, NOW(), $3, '+254700000000')`,
    [user.id, staffNumber, departmentId]);
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'A Course', $2, 'VERIFIED') RETURNING id`,
    [`U${uniq()}`, user.id]);
  return { ...user, staffNumber, unitId: unit!.id };
}

/** A student on one unit's roster, with one check-in, a face enrolment and a passkey. */
async function makeStudent(unitId: string, lecturerUserId: string) {
  const user = await makeUser('STUDENT', `Student ${uniq()}`);
  const registrationNumber = `SCT/${uniq()}/2024`;
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at)
     VALUES ($1, $2, 'ERP', NOW())`,
    [user.id, registrationNumber]);
  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, 'Roster Name', 'ACTIVE', 'ERP') RETURNING id`,
    [unitId, registrationNumber, user.id]);
  const { rows: [s] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds)
     VALUES ($1, $2, 'x', 'CLOSED', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 60) RETURNING id`,
    [unitId, lecturerUserId]);
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_user_id, allocation_id, ip_address, user_agent)
     VALUES ($1, $2, $3, '10.0.0.1', 'phone')`,
    [s!.id, user.id, a!.id]);
  await pool.query(
    `INSERT INTO face_enrollments (student_user_id, model, embeddings) VALUES ($1, 'sface', '[[0.1]]')`, [user.id]);
  await pool.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter)
     VALUES ($1, $2, '\\x00', 0)`,
    [user.id, randomUUID()]);
  return { ...user, registrationNumber, allocationId: a!.id };
}

interface Body<T = Record<string, unknown>> { data: T }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  delete: (path: string, data?: object) => request(app).delete(`/api/v1${path}`).set('Authorization', auth).send(data),
});

let facultyId: string;
let deptA: string;
let deptB: string;
let otherFacultyDept: string;

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
  passwordHash = await (await import('../../src/common/utils/password.js')).hashPassword(PASSWORD);

  const { rows: [f1] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ('Science') RETURNING id`);
  const { rows: [f2] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ('Arts') RETURNING id`);
  facultyId = f1!.id;
  deptA = await makeDepartment('Computing', facultyId);
  deptB = await makeDepartment('Mathematics', facultyId);
  otherFacultyDept = await makeDepartment('History', f2!.id);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

async function departmentOfficer(departmentId: string) {
  const officer = await makeUser('DEPARTMENT', 'Dept Officer');
  await pool.query(`INSERT INTO department_profiles (user_id, department_id) VALUES ($1, $2)`, [officer.id, departmentId]);
  return officer;
}

async function facultyOfficer(id: string) {
  const officer = await makeUser('FACULTY', 'Faculty Officer');
  await pool.query(`INSERT INTO faculty_profiles (user_id, faculty_id) VALUES ($1, $2)`, [officer.id, id]);
  return officer;
}

interface UserRow { email: string; full_name: string; status: string; deleted_at: Date | null; avatar_data_url: string | null }

async function userRow(id: string): Promise<UserRow> {
  const { rows: [u] } = await pool.query<UserRow>(
    `SELECT email, full_name, status, deleted_at, avatar_data_url FROM users WHERE id = $1`, [id]);
  return u!;
}

const count = async (sql: string, params: unknown[]) =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n);

describe('DELETE /auth/me', () => {
  it('refuses a wrong password and leaves the account alone', async () => {
    const lecturer = await makeLecturer(deptA);
    const student = await makeStudent(lecturer.unitId, lecturer.id);

    const res = await api(student.auth).delete('/auth/me', { password: 'not-it' });
    expect(res.status).toBe(400);
    expect((await userRow(student.id)).deleted_at).toBeNull();
    expect((await api(student.auth).get('/auth/me')).status).toBe(200);
  });

  it('requires the password at all', async () => {
    const lecturer = await makeLecturer(deptA);
    expect((await api(lecturer.auth).delete('/auth/me', {})).status).toBe(400);
  });

  it("anonymises a student, signs them out and removes what identifies them, but keeps the attendance", async () => {
    const lecturer = await makeLecturer(deptA);
    const student = await makeStudent(lecturer.unitId, lecturer.id);

    const res = await api(student.auth).delete('/auth/me', { password: PASSWORD });
    expect(res.status).toBe(204);

    const u = await userRow(student.id);
    expect(u.deleted_at).not.toBeNull();
    expect(u.status).toBe('DEACTIVATED');
    expect(u.full_name).toBe('Deleted student');
    expect(u.email).toMatch(/@deleted\.invalid$/);

    // Signed out everywhere.
    expect((await api(student.auth).get('/auth/me')).status).toBe(401);
    expect(await count(`SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = $1`, [student.id])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = $1`, [student.id])).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM face_enrollments WHERE student_user_id = $1`, [student.id])).toBe(0);

    // The registration number is freed for a new account.
    expect(await count(`SELECT COUNT(*) AS n FROM student_profiles WHERE registration_number = $1`, [student.registrationNumber])).toBe(0);

    // The check-in stays, without the device it came from.
    const { rows: records } = await pool.query(
      `SELECT ip_address, user_agent FROM attendance_records WHERE student_user_id = $1`, [student.id]);
    expect(records).toEqual([{ ip_address: null, user_agent: null }]);

    // The roster row stays, unlinked, so registering again relinks it.
    const { rows: [a] } = await pool.query<Record<string, unknown>>(
      `SELECT student_user_id, registration_number, status FROM unit_allocations WHERE id = $1`, [student.allocationId]);
    expect(a).toEqual({ student_user_id: null, registration_number: student.registrationNumber, status: 'ACTIVE' });

    // Audited, without the erased details.
    const { rows: [audit] } = await pool.query<Record<string, unknown>>(
      `SELECT outcome, subject_email, metadata FROM audit_logs WHERE action = 'ACCOUNT_DELETED' AND user_id = $1`, [student.id]);
    expect(audit).toMatchObject({ outcome: 'SUCCESS', subject_email: null, metadata: { role: 'STUDENT', deletedBy: 'SELF' } });
  });

  it('closes a lecturer’s open class and keeps their units', async () => {
    const lecturer = await makeLecturer(deptA);
    const { rows: [s] } = await pool.query<{ id: string }>(
      `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds)
       VALUES ($1, $2, 'x', 'OPEN', NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '1 hour', 60) RETURNING id`,
      [lecturer.unitId, lecturer.id]);

    expect((await api(lecturer.auth).delete('/auth/me', { password: PASSWORD })).status).toBe(204);

    const { rows: [session] } = await pool.query<Record<string, unknown>>(`SELECT status, closes_at <= NOW() AS ended FROM attendance_sessions WHERE id = $1`, [s!.id]);
    expect(session).toEqual({ status: 'CLOSED', ended: true });
    expect(await count(`SELECT COUNT(*) AS n FROM units WHERE id = $1`, [lecturer.unitId])).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM lecturer_profiles WHERE staff_number = $1`, [lecturer.staffNumber])).toBe(0);
    expect((await userRow(lecturer.id)).full_name).toBe('Deleted lecturer');
  });

  it('is not open to department officers', async () => {
    const officer = await departmentOfficer(deptA);
    expect((await api(officer.auth).delete('/auth/me', { password: PASSWORD })).status).toBe(403);
  });
});

describe('DELETE /departments/…', () => {
  it('deletes a lecturer in the department, and drops them from its list and head count', async () => {
    const officer = await departmentOfficer(deptB);
    const lecturer = await makeLecturer(deptB);
    const lecturerCount = async () => body<{ lecturerCount: number }>(await api(officer.auth).get('/departments/overview')).data.lecturerCount;
    const before = await lecturerCount();

    expect((await api(officer.auth).delete(`/departments/lecturers/${lecturer.id}`)).status).toBe(204);

    const list = body<{ userId: string }[]>(await api(officer.auth).get('/departments/lecturers')).data;
    expect(list.map((l) => l.userId)).not.toContain(lecturer.id);
    expect(await lecturerCount()).toBe(before - 1);
    const { rows: [audit] } = await pool.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit_logs WHERE action = 'ACCOUNT_DELETED' AND user_id = $1`, [lecturer.id]);
    expect(audit!.metadata).toEqual({ role: 'LECTURER', deletedBy: 'DEPARTMENT', actorUserId: officer.id });

    // Already deleted.
    expect((await api(officer.auth).delete(`/departments/lecturers/${lecturer.id}`)).status).toBe(404);
  });

  it("refuses a lecturer in another department", async () => {
    const officer = await departmentOfficer(deptA);
    const lecturer = await makeLecturer(deptB);
    expect((await api(officer.auth).delete(`/departments/lecturers/${lecturer.id}`)).status).toBe(404);
    expect((await userRow(lecturer.id)).deleted_at).toBeNull();
  });

  it('deletes a student on one of its rosters, and refuses one who is not', async () => {
    const officer = await departmentOfficer(deptA);
    const inside = await makeStudent((await makeLecturer(deptA)).unitId, (await makeLecturer(deptA)).id);
    const elsewhere = await makeLecturer(deptB);
    const outside = await makeStudent(elsewhere.unitId, elsewhere.id);

    expect((await api(officer.auth).delete(`/departments/students/${inside.id}`)).status).toBe(204);
    expect((await userRow(inside.id)).deleted_at).not.toBeNull();

    expect((await api(officer.auth).delete(`/departments/students/${outside.id}`)).status).toBe(404);
    expect((await userRow(outside.id)).deleted_at).toBeNull();
  });

  it('will not delete a lecturer through the student route', async () => {
    const officer = await departmentOfficer(deptA);
    const lecturer = await makeLecturer(deptA);
    expect((await api(officer.auth).delete(`/departments/students/${lecturer.id}`)).status).toBe(404);
  });

  it('is not open to lecturers', async () => {
    const lecturer = await makeLecturer(deptA);
    const other = await makeLecturer(deptA);
    expect((await api(lecturer.auth).delete(`/departments/lecturers/${other.id}`)).status).toBe(403);
  });
});

describe('DELETE /faculties/…', () => {
  it('deletes lecturers and students across its departments, and nobody outside it', async () => {
    const officer = await facultyOfficer(facultyId);
    const lecturer = await makeLecturer(deptB);
    const student = await makeStudent(lecturer.unitId, lecturer.id);
    const outsider = await makeLecturer(otherFacultyDept);
    const outsideStudent = await makeStudent(outsider.unitId, outsider.id);

    expect((await api(officer.auth).delete(`/faculties/students/${student.id}`)).status).toBe(204);
    expect((await api(officer.auth).delete(`/faculties/lecturers/${lecturer.id}`)).status).toBe(204);
    expect((await userRow(student.id)).deleted_at).not.toBeNull();
    expect((await userRow(lecturer.id)).deleted_at).not.toBeNull();

    expect((await api(officer.auth).delete(`/faculties/lecturers/${outsider.id}`)).status).toBe(404);
    expect((await api(officer.auth).delete(`/faculties/students/${outsideStudent.id}`)).status).toBe(404);
  });
});

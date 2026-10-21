import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one admin console: SMARTTT's admin functions reached through attendance
 * for an administrator signed in with their SMARTTT account (admin.smarttt.ts),
 * and faculties and departments owned by SMARTTT (src/modules/directory).
 * SMARTTT is stubbed at the fetch boundary.
 */
const TEST_DB = 'attendance_admin_console_test';
const SMARTTT = 'http://smarttt.test.local';
const KEY = 'attendance-key';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let env: { SMARTTT_BASE_URL?: string };
let resetDirectory: () => void;

interface Body { data?: unknown; error?: { code: string; message: string; details?: unknown } }
const body = (res: request.Response): Body => res.body as Body;
const uniq = (() => { let n = 0; return () => ++n; })();

// --- The fake SMARTTT ---------------------------------------------------------------

interface Call { method: string; path: string; key: string | null; acting: string | null; contentType: string | null; body: Buffer }
const calls: Call[] = [];
/** Answers for integrations/admin/<path>, by "METHOD path". */
let adminAnswers: Record<string, Response | (() => Response)> = {};
let smartttFaculties: { id: number; name: string; code: string }[] = [];
let smartttDepartments: { id: number; name: string; code: string; faculty_id: number; status: string }[] = [];
let nextId = 100;

function stubFetch() {
  // Through a promise, so an answer that throws is a rejected fetch, as a network failure is.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => Promise.resolve().then(() => smartttAnswer(input, init)));
}

function smartttAnswer(input: string | URL | Request, init: RequestInit | undefined): Response {
  {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== SMARTTT) return new Response('not stubbed', { status: 503 });
    const headers = new Headers(init?.headers);
    const raw = init?.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body as string | Uint8Array);
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname + url.search, key: headers.get('X-API-Key'), acting: headers.get('X-Acting-Account'), contentType: headers.get('Content-Type'), body: raw });

    if (url.pathname.startsWith('/api/v1/integrations/admin/')) {
      const answer = adminAnswers[`${method} ${url.pathname.replace('/api/v1/integrations/admin/', '')}`];
      if (!answer) return new Response('<h1>Not Found</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } });
      return typeof answer === 'function' ? answer() : answer.clone();
    }

    const sent = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {};
    if (url.pathname === '/api/v1/integrations/attendance/faculties/') {
      if (method === 'GET') return Response.json({ faculties: smartttFaculties });
      const taken = smartttFaculties.find((f) => f.name.toLowerCase() === String(sent['name']).toLowerCase());
      if (taken) return Response.json({ detail: 'That name is already in use.', code: 'name_taken', id: taken.id }, { status: 409 });
      const created = { id: nextId++, name: String(sent['name']), code: `F${nextId}` };
      smartttFaculties.push(created);
      return Response.json(created, { status: 201 });
    }
    if (url.pathname === '/api/v1/integrations/attendance/departments/') {
      if (method === 'GET') return Response.json({ departments: smartttDepartments });
      const taken = smartttDepartments.find((d) => d.name.toLowerCase() === String(sent['name']).toLowerCase());
      if (taken) return Response.json({ detail: 'That name is already in use.', code: 'name_taken', id: taken.id }, { status: 409 });
      const created = { id: nextId++, name: String(sent['name']), code: `D${nextId}`, faculty_id: Number(sent['faculty_id']), status: 'active' };
      smartttDepartments.push(created);
      return Response.json(created, { status: 201 });
    }
    return new Response('no', { status: 404 });
  }
}

// --- Helpers ---------------------------------------------------------------------------

/** A signed-in account, as a bearer token; an administrator is linked to a SMARTTT account unless `linked` is false. */
async function makeUser(role: 'ADMIN' | 'LECTURER' | 'FACULTY', options: { linked?: boolean; facultyId?: string } = {}) {
  const smartttUserId = role === 'ADMIN' && options.linked !== false ? randomUUID() : null;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, smarttt_user_id)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW(), $4) RETURNING id`,
    [`${role.toLowerCase()}${uniq()}@uni.ac.ke`, `${role} person`, role, smartttUserId]);
  if (role === 'FACULTY') {
    await pool.query(`INSERT INTO faculty_profiles (user_id, faculty_id) VALUES ($1, $2)`, [u!.id, options.facultyId]);
  }
  if (role === 'LECTURER') {
    await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, `STF/${uniq()}`]);
  }
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, smartttUserId, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

const as = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string) => request(app).post(`/api/v1${path}`).set('Authorization', auth),
  patch: (path: string) => request(app).patch(`/api/v1${path}`).set('Authorization', auth),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

const audits = async (action: string) =>
  (await pool.query<{ outcome: string; user_id: string; reason: string | null; metadata: Record<string, unknown> }>(
    `SELECT outcome, user_id, reason, metadata FROM audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;

// --- Setup ----------------------------------------------------------------------------------

beforeAll(async () => {
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.query(`CREATE DATABASE ${TEST_DB}`);
  await pgAdmin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.SMARTTT_BASE_URL = SMARTTT;
  process.env.SMARTTT_API_KEY = KEY;
  process.env.GENERATOR_API_KEY = 'generator-key';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  ({ env } = await import('../../src/config/env.js'));
  ({ resetDirectorySyncState: resetDirectory } = await import('../../src/modules/directory/directory.service.js'));
  app = (await import('../../src/app.js')).createApp();
});

beforeEach(() => {
  env.SMARTTT_BASE_URL = SMARTTT;
  adminAnswers = {};
  resetDirectory();
  stubFetch();
});
afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

// --- SMARTTT's admin functions --------------------------------------------------------------

describe("SMARTTT's admin functions in the console", () => {
  it('are called for the signed-in administrator, with the shared key, and answered in the usual envelope', async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['GET terms/'] = Response.json({ count: 1, results: [{ id: 't1', academic_year: '2026/2027', semester: 1, is_current: true }] });

    const res = await as(admin.auth).get('/admin/smarttt/terms?page=2');
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual({ count: 1, results: [{ id: 't1', academic_year: '2026/2027', semester: 1, is_current: true }] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/v1/integrations/admin/terms/?page=2', key: KEY, acting: admin.smartttUserId });
  });

  it('pass a timetable upload on byte for byte, and record the change', async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['POST timetable/upload/'] = Response.json({ batch_id: 'b1', status: 'processing' }, { status: 201 });
    const file = Buffer.from('%PDF-1.4 a timetable');

    const res = await as(admin.auth).post('/admin/smarttt/timetable/uploads').attach('file', file, 'TT.pdf').field('term', 't1');
    expect(res.status).toBe(201);
    expect(body(res).data).toEqual({ batch_id: 'b1', status: 'processing' });
    const sent = calls[0]!;
    expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent.body.includes(file)).toBe(true);
    expect(sent.body.toString()).toContain('name="term"');

    const [audit] = (await audits('SMARTTT_ADMIN_ACTION')).filter((a) => a.user_id === admin.id);
    expect(audit).toMatchObject({ outcome: 'SUCCESS', metadata: { method: 'POST', path: 'timetable/upload/', status: 201 } });
  });

  it('send JSON for a notification and a term change', async () => {
    const admin = await makeUser('ADMIN');
    const termId = randomUUID();
    adminAnswers['POST notifications/send/'] = Response.json({ sent: 120 });
    adminAnswers[`POST terms/${termId}/set-current/`] = Response.json({ detail: 'Now current.' });

    const sent = await as(admin.auth).post('/admin/smarttt/notifications').send({ title: 'Exams', message: 'Start Monday', audience: 'all' });
    expect(sent.status).toBe(200);
    expect(JSON.parse(calls[0]!.body.toString())).toEqual({ title: 'Exams', message: 'Start Monday', audience: 'all' });

    expect((await as(admin.auth).post(`/admin/smarttt/terms/${termId}/set-current`)).status).toBe(200);
  });

  it("remove one department's lecturer allocation, named in the query", async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['DELETE timetable/assign-lecturers/'] = Response.json({ detail: 'Removed the allocation from Arts & Humanities.', slots_updated: 4 });
    const res = await as(admin.auth).delete('/admin/smarttt/lecturer-allocation').query({ source: "Arts & Humanities (Dept')" });
    expect(res.status).toBe(200);
    expect(new URL(`${SMARTTT}${calls[0]!.path}`).searchParams.get('source')).toBe("Arts & Humanities (Dept')");
  });

  it("explain SMARTTT's refusals in SMARTTT's words", async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['POST staff-ids/upload/'] = Response.json({ file: ['Only .csv files are accepted.'] }, { status: 400 });
    const res = await as(admin.auth).post('/admin/smarttt/staff-ids').attach('file', Buffer.from('x'), 'ids.xlsx');
    expect(res.status).toBe(400);
    expect(body(res).error).toMatchObject({ code: 'VALIDATION_FAILED', message: 'file: Only .csv files are accepted.' });
    expect((await audits('SMARTTT_ADMIN_ACTION')).some((a) => a.user_id === admin.id && a.outcome === 'FAILURE' && a.reason === 'REFUSED')).toBe(true);
  });

  it('shut out someone SMARTTT no longer counts as an administrator', async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['GET notifications/'] = Response.json({ detail: 'This account is not a SMARTTT administrator.', code: 'not_admin' }, { status: 403 });
    const res = await as(admin.auth).get('/admin/smarttt/notifications');
    expect(res.status).toBe(403);
    expect(body(res).error?.code).toBe('NOT_SMARTTT_ADMIN');
  });

  it('say when the two systems are misconfigured, down, or SMARTTT is too old', async () => {
    const admin = await makeUser('ADMIN');
    adminAnswers['GET staff-ids/'] = Response.json({ detail: 'A valid X-API-Key header is required.', code: 'invalid_api_key' }, { status: 401 });
    expect(body(await as(admin.auth).get('/admin/smarttt/staff-ids')).error?.code).toBe('SMARTTT_MISCONFIGURED');

    adminAnswers['GET programs/'] = () => { throw new TypeError('fetch failed'); };
    const down = await as(admin.auth).get('/admin/smarttt/programs');
    expect(down.status).toBe(503);
    expect(body(down).error?.code).toBe('SMARTTT_UNAVAILABLE');

    // No route at all (HTML 404): a SMARTTT without integrations/admin/.
    const old = await as(admin.auth).get('/admin/smarttt/rooms/capacities');
    expect(old.status).toBe(503);
    expect(body(old).error?.message).toMatch(/does not offer this admin function yet/);
  });

  it('are for administrators only, and need their SMARTTT account', async () => {
    const lecturer = await makeUser('LECTURER');
    expect((await as(lecturer.auth).get('/admin/smarttt/terms')).status).toBe(403);

    const unlinked = await makeUser('ADMIN', { linked: false });
    const res = await as(unlinked.auth).get('/admin/smarttt/terms');
    expect(res.status).toBe(403);
    expect(body(res).error?.code).toBe('SMARTTT_LINK_REQUIRED');
    expect(calls).toHaveLength(0);
  });

  it('refuse a malformed id or a missing file before asking SMARTTT', async () => {
    const admin = await makeUser('ADMIN');
    expect((await as(admin.auth).delete('/admin/smarttt/staff-ids/not-an-id')).status).toBe(400);
    expect((await as(admin.auth).post('/admin/smarttt/timetable/uploads').send({ term: 't1' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// --- Faculties and departments ----------------------------------------------------------------

describe('faculties and departments, owned by SMARTTT', () => {
  it("listing reads SMARTTT's: same names are linked, new ones are added", async () => {
    const admin = await makeUser('ADMIN');
    const { rows: [local] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ('Faculty of Education') RETURNING id`);
    smartttFaculties = [{ id: 1, name: 'Faculty of Education', code: 'FE' }, { id: 2, name: 'Faculty of Law', code: 'FL' }];
    smartttDepartments = [{ id: 11, name: 'Department of Commercial Law', code: 'DCL', faculty_id: 2, status: 'active' }];

    const res = await as(admin.auth).get('/admin/faculties');
    expect(res.status).toBe(200);
    const faculties = body(res).data as { facultyId: string; name: string; departmentCount: number; inSmarttt: boolean }[];
    expect(faculties.find((f) => f.name === 'Faculty of Education')).toMatchObject({ facultyId: local!.id, inSmarttt: true });
    expect(faculties.find((f) => f.name === 'Faculty of Law')).toMatchObject({ departmentCount: 1, inSmarttt: true });
    const { rows: [dept] } = await pool.query<{ smarttt_department_id: number }>(
      `SELECT smarttt_department_id FROM departments WHERE name = 'Department of Commercial Law'`);
    expect(dept!.smarttt_department_id).toBe(11);
  });

  it('a new faculty is created in SMARTTT, then here, linked', async () => {
    const admin = await makeUser('ADMIN');
    const res = await as(admin.auth).post('/admin/faculties').send({ name: 'Faculty of Agriculture' });
    expect(res.status).toBe(201);
    const made = smartttFaculties.find((f) => f.name === 'Faculty of Agriculture')!;
    const { rows: [row] } = await pool.query<{ id: string; smarttt_faculty_id: number }>(
      `SELECT id, smarttt_faculty_id FROM faculties WHERE name = 'Faculty of Agriculture'`);
    expect(row).toEqual({ id: (body(res).data as { facultyId: string }).facultyId, smarttt_faculty_id: made.id });

    const again = await as(admin.auth).post('/admin/faculties').send({ name: 'faculty of agriculture' });
    expect(again.status).toBe(409);
  });

  it('nothing is created here when SMARTTT is down', async () => {
    const admin = await makeUser('ADMIN');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await as(admin.auth).post('/admin/faculties').send({ name: 'Faculty of Medicine' });
    expect(res.status).toBe(503);
    expect((await pool.query(`SELECT 1 FROM faculties WHERE name = 'Faculty of Medicine'`)).rowCount).toBe(0);
  });

  it("a faculty officer's new department goes to SMARTTT under the faculty's SMARTTT id", async () => {
    smartttFaculties = [{ id: 7, name: 'Faculty of Science', code: 'FS' }];
    const { rows: [faculty] } = await pool.query<{ id: string }>(
      `INSERT INTO faculties (name, smarttt_faculty_id) VALUES ('Faculty of Science', 7) ON CONFLICT (name) DO UPDATE SET smarttt_faculty_id = 7 RETURNING id`);
    const officer = await makeUser('FACULTY', { facultyId: faculty!.id });

    const res = await as(officer.auth).post('/faculties/departments').send({ name: 'Department of Physics' });
    expect(res.status).toBe(201);
    expect(smartttDepartments.find((d) => d.name === 'Department of Physics')).toMatchObject({ faculty_id: 7 });
    const { rows: [row] } = await pool.query<{ faculty_id: string; smarttt_department_id: number | null }>(
      `SELECT faculty_id, smarttt_department_id FROM departments WHERE name = 'Department of Physics'`);
    expect(row!.faculty_id).toBe(faculty!.id);
    expect(row!.smarttt_department_id).not.toBeNull();
  });

  it("another spelling of a department here is refused before SMARTTT is asked", async () => {
    smartttFaculties = [{ id: 8, name: 'Faculty of Pure Sciences', code: 'FPS' }];
    smartttDepartments = [];
    const { rows: [faculty] } = await pool.query<{ id: string }>(
      `INSERT INTO faculties (name, smarttt_faculty_id) VALUES ('Faculty of Pure Sciences', 8) RETURNING id`);
    await pool.query(`INSERT INTO departments (name, faculty_id) VALUES ('Chemistry', $1)`, [faculty!.id]);
    const officer = await makeUser('FACULTY', { facultyId: faculty!.id });

    const res = await as(officer.auth).post('/faculties/departments').send({ name: 'Department of Chemistry' });
    expect(res.status).toBe(409);
    expect(smartttDepartments).toEqual([]);
  });

  it('a department read from SMARTTT places the lecturers who were waiting for it', async () => {
    const admin = await makeUser('ADMIN');
    const lecturer = await makeUser('LECTURER');
    await pool.query(`UPDATE lecturer_profiles SET department = 'Agricultural Economics', department_id = NULL WHERE user_id = $1`, [lecturer.id]);
    smartttFaculties = [{ id: 9, name: 'Faculty of Agriculture and Food', code: 'FAF' }];
    smartttDepartments = [{ id: 19, name: 'Department of Agricultural Economics', code: 'DAE', faculty_id: 9, status: 'active' }];

    expect((await as(admin.auth).get('/admin/faculties')).status).toBe(200);
    const { rows: [placed] } = await pool.query<{ name: string }>(
      `SELECT d.name FROM lecturer_profiles lp JOIN departments d ON d.id = lp.department_id WHERE lp.user_id = $1`, [lecturer.id]);
    expect(placed?.name).toBe('Department of Agricultural Economics');
  });

  it('an administrator sends the ones that only exist here to SMARTTT', async () => {
    const admin = await makeUser('ADMIN');
    smartttFaculties = [];
    smartttDepartments = [];
    const { rows: [f] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ('Faculty of Arts ${uniq()}') RETURNING id, name`);
    const deptName = `Department of History ${uniq()}`;
    await pool.query(`INSERT INTO departments (name, faculty_id) VALUES ($1, $2)`, [deptName, f!.id]);
    const orphan = `Department of Nowhere ${uniq()}`;
    await pool.query(`INSERT INTO departments (name) VALUES ($1)`, [orphan]);

    const before = body(await as(admin.auth).get('/admin/directory')).data as { onlyHere: { faculties: number; departments: number } };
    expect(before.onlyHere.faculties).toBeGreaterThan(0);

    const res = await as(admin.auth).post('/admin/directory/sync');
    expect(res.status).toBe(200);
    const report = body(res).data as { toSmarttt: { faculties: number; departments: number; skipped: string[] } };
    expect(report.toSmarttt.departments).toBeGreaterThan(0);
    expect(report.toSmarttt.skipped.some((s) => s.includes(orphan))).toBe(true);
    expect(smartttDepartments.some((d) => d.name === deptName)).toBe(true);

    const after = body(await as(admin.auth).get('/admin/directory')).data as { onlyHere: { faculties: number; departments: number } };
    expect(after.onlyHere).toEqual({ faculties: 0, departments: 1 });
    expect(await audits('DIRECTORY_SYNCED')).toHaveLength(1);
  });
});

describe('the Timetable Generator reads the departments', () => {
  const read = (key?: string) => {
    const req = request(app).get('/api/v1/integrations/generator/departments');
    return key ? req.set('X-API-Key', key) : req;
  };

  it('needs its own key', async () => {
    expect((await read()).status).toBe(401);
    expect((await read(KEY)).status).toBe(401); // SMARTTT's key is not the Generator's
  });

  it("lists every department with its faculty, SMARTTT id and active lecturers, SMARTTT's first", async () => {
    smartttFaculties = [{ id: 31, name: 'Faculty of Health Sciences', code: 'FHS' }];
    smartttDepartments = [{ id: 41, name: 'Department of Nursing', code: 'DN', faculty_id: 31, status: 'active' }];
    const { rows: [local] } = await pool.query<{ id: string }>(`INSERT INTO departments (name) VALUES ('Department of Geography ${uniq()}') RETURNING id`);
    const lecturer = await makeUser('LECTURER');
    await pool.query(`UPDATE lecturer_profiles SET department_id = $2 WHERE user_id = $1`, [lecturer.id, local!.id]);

    const res = await read('generator-key');
    expect(res.status).toBe(200);
    const departments = (body(res).data as { departments: Record<string, unknown>[] }).departments;
    expect(departments.find((d) => d['name'] === 'Department of Nursing')).toMatchObject({
      facultyName: 'Faculty of Health Sciences', smartttDepartmentId: 41, lecturerCount: 0,
    });
    expect(departments.find((d) => d['id'] === local!.id)).toMatchObject({ smartttDepartmentId: null, facultyId: null, lecturerCount: 1 });
  });
});

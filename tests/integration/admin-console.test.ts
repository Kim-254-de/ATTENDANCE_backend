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
 * and departments owned by SMARTTT (src/modules/directory), which the
 * Timetable Generator and Allocator read.
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
let smartttDepartments: { id: number; name: string; code: string; status: string }[] = [];
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
    if (url.pathname === '/api/v1/integrations/attendance/departments/') {
      if (method === 'GET') return Response.json({ departments: smartttDepartments });
      const taken = smartttDepartments.find((d) => d.name.toLowerCase() === String(sent['name']).toLowerCase());
      if (taken) return Response.json({ detail: 'That name is already in use.', code: 'name_taken', id: taken.id }, { status: 409 });
      const code = (typeof sent['code'] === 'string' ? sent['code'] : `D${nextId}`).toUpperCase();
      if (smartttDepartments.some((d) => d.code === code)) {
        return Response.json({ detail: `The department code ${code} is already in use.`, code: 'code_taken' }, { status: 409 });
      }
      const created = { id: nextId++, name: String(sent['name']), code, status: 'active' };
      smartttDepartments.push(created);
      return Response.json(created, { status: 201 });
    }
    const one = /^\/api\/v1\/integrations\/attendance\/departments\/(\d+)\/$/.exec(url.pathname);
    if (one && method === 'PATCH') {
      const department = smartttDepartments.find((d) => d.id === Number(one[1]));
      if (!department) return Response.json({ detail: 'Not found.' }, { status: 404 });
      const others = smartttDepartments.filter((d) => d !== department);
      const taken = others.find((d) => d.name.toLowerCase() === String(sent['name']).toLowerCase());
      if (taken) return Response.json({ detail: 'That name is already in use.', code: 'name_taken', id: taken.id }, { status: 409 });
      const code = String(sent['code']).toUpperCase();
      if (others.some((d) => d.code === code)) {
        return Response.json({ detail: `The department code ${code} is already in use.`, code: 'code_taken' }, { status: 409 });
      }
      Object.assign(department, { name: String(sent['name']), code });
      return Response.json(department);
    }
    return new Response('no', { status: 404 });
  }
}

// --- Helpers ---------------------------------------------------------------------------

/** A signed-in account, as a bearer token; an administrator is linked to a SMARTTT account unless `linked` is false. */
async function makeUser(role: 'ADMIN' | 'LECTURER', options: { linked?: boolean } = {}) {
  const smartttUserId = role === 'ADMIN' && options.linked !== false ? randomUUID() : null;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, smarttt_user_id)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW(), $4) RETURNING id`,
    [`${role.toLowerCase()}${uniq()}@uni.ac.ke`, `${role} person`, role, smartttUserId]);
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

// --- Departments ----------------------------------------------------------------------------

describe('departments, owned by SMARTTT, created by the administrator', () => {
  it("listing reads SMARTTT's: same names are linked and take SMARTTT's code, new ones are added", async () => {
    const admin = await makeUser('ADMIN');
    const { rows: [local] } = await pool.query<{ id: string }>(`INSERT INTO departments (name) VALUES ('Department of Education') RETURNING id`);
    smartttDepartments = [
      { id: 1, name: 'Department of Education', code: 'DEDU', status: 'active' },
      { id: 11, name: 'Department of Commercial Law', code: 'DCL', status: 'active' },
    ];

    const res = await as(admin.auth).get('/admin/departments');
    expect(res.status).toBe(200);
    const departments = body(res).data as { departmentId: string; name: string; code: string | null; inSmarttt: boolean }[];
    expect(departments.find((d) => d.name === 'Department of Education')).toMatchObject({ departmentId: local!.id, code: 'DEDU', inSmarttt: true });
    expect(departments.find((d) => d.name === 'Department of Commercial Law')).toMatchObject({ code: 'DCL', inSmarttt: true });
    expect(departments[0]).not.toHaveProperty('facultyName');
    // No faculties are asked for any more.
    expect(calls.map((c) => c.path)).not.toContain('/api/v1/integrations/attendance/faculties/');
  });

  it('a new department is created in SMARTTT with its name and code, then here, linked', async () => {
    const admin = await makeUser('ADMIN');
    smartttDepartments = [];
    const res = await as(admin.auth).post('/admin/departments').send({ name: 'Department of Agriculture', code: 'dagr' });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ name: 'Department of Agriculture', code: 'DAGR' });
    const sent = JSON.parse(calls.find((c) => c.method === 'POST')!.body.toString()) as Record<string, unknown>;
    expect(sent).toEqual({ name: 'Department of Agriculture', code: 'DAGR' });
    const made = smartttDepartments.find((d) => d.name === 'Department of Agriculture')!;
    const { rows: [row] } = await pool.query<{ id: string; code: string; smarttt_department_id: number }>(
      `SELECT id, code, smarttt_department_id FROM departments WHERE name = 'Department of Agriculture'`);
    expect(row).toEqual({ id: (body(res).data as { departmentId: string }).departmentId, code: 'DAGR', smarttt_department_id: made.id });
    expect(await audits('DEPARTMENT_CREATED')).toHaveLength(1);

    expect((await as(admin.auth).post('/admin/departments').send({ name: 'department of agriculture', code: 'OTHER' })).status).toBe(409);
  });

  it("refuses a code SMARTTT already gives another department, in SMARTTT's words", async () => {
    const admin = await makeUser('ADMIN');
    smartttDepartments = [{ id: 51, name: 'Department of Botany', code: 'DBOT', status: 'active' }];
    // Not read in yet (the sync is throttled), so only SMARTTT knows the code.
    const res = await as(admin.auth).post('/admin/departments').send({ name: 'Department of Biology', code: 'DBOT' });
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/DBOT is already in use/);
  });

  it('nothing is created here when SMARTTT is down', async () => {
    const admin = await makeUser('ADMIN');
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await as(admin.auth).post('/admin/departments').send({ name: 'Department of Medicine', code: 'DMED' });
    expect(res.status).toBe(503);
    expect((await pool.query(`SELECT 1 FROM departments WHERE name = 'Department of Medicine'`)).rowCount).toBe(0);
  });

  it('another spelling of a department here is refused before SMARTTT is asked', async () => {
    const admin = await makeUser('ADMIN');
    smartttDepartments = [];
    await pool.query(`INSERT INTO departments (name, code) VALUES ('Chemistry', 'DCHEM')`);
    const res = await as(admin.auth).post('/admin/departments').send({ name: 'Department of Chemistry', code: 'DCHEM2' });
    expect(res.status).toBe(409);
    expect(smartttDepartments).toEqual([]);
  });

  it('is for administrators only', async () => {
    const lecturer = await makeUser('LECTURER');
    expect((await as(lecturer.auth).post('/admin/departments').send({ name: 'Department of Music', code: 'DMUS' })).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/faculties').set('Authorization', (await makeUser('ADMIN')).auth)).status).toBe(404);
  });

  it('a department read from SMARTTT places the lecturers who were waiting for it', async () => {
    const admin = await makeUser('ADMIN');
    const lecturer = await makeUser('LECTURER');
    await pool.query(`UPDATE lecturer_profiles SET department = 'Agricultural Economics', department_id = NULL WHERE user_id = $1`, [lecturer.id]);
    smartttDepartments = [{ id: 19, name: 'Department of Agricultural Economics', code: 'DAE', status: 'active' }];

    expect((await as(admin.auth).get('/admin/departments')).status).toBe(200);
    const { rows: [placed] } = await pool.query<{ name: string }>(
      `SELECT d.name FROM lecturer_profiles lp JOIN departments d ON d.id = lp.department_id WHERE lp.user_id = $1`, [lecturer.id]);
    expect(placed?.name).toBe('Department of Agricultural Economics');
  });

  it('an administrator sends the ones that only exist here to SMARTTT, with their codes', async () => {
    const admin = await makeUser('ADMIN');
    smartttDepartments = [];
    const deptName = `Department of History ${uniq()}`;
    await pool.query(`INSERT INTO departments (name, code) VALUES ($1, 'DHIS')`, [deptName]);

    const before = body(await as(admin.auth).get('/admin/directory')).data as { onlyHere: { departments: number } };
    expect(before.onlyHere.departments).toBeGreaterThan(0);
    expect(before.onlyHere).not.toHaveProperty('faculties');

    const res = await as(admin.auth).post('/admin/directory/sync');
    expect(res.status).toBe(200);
    const report = body(res).data as { toSmarttt: { departments: number; skipped: string[] } };
    expect(report.toSmarttt.departments).toBeGreaterThan(0);
    expect(smartttDepartments.find((d) => d.name === deptName)).toMatchObject({ code: 'DHIS' });

    const after = body(await as(admin.auth).get('/admin/directory')).data as { onlyHere: { departments: number } };
    expect(after.onlyHere).toEqual({ departments: 0 });
    expect(await audits('DIRECTORY_SYNCED')).toHaveLength(1);
  });
});

describe('the administrator corrects a department', () => {
  /** A department in SMARTTT, read in here. */
  async function linked(name: string, code: string) {
    const id = nextId++;
    smartttDepartments.push({ id, name, code, status: 'active' });
    const { rows: [row] } = await pool.query<{ id: string }>(
      `INSERT INTO departments (name, code, smarttt_department_id) VALUES ($1, $2, $3) RETURNING id`, [name, code, id]);
    return { id: row!.id, smartttId: id };
  }

  it('in SMARTTT first, then here; lecturers stay with it', async () => {
    const admin = await makeUser('ADMIN');
    const lecturer = await makeUser('LECTURER');
    const n = uniq();
    const department = await linked(`Departmnt of Geografy ${n}`, `DGEO${n}`);
    await pool.query(`UPDATE lecturer_profiles SET department_id = $1 WHERE user_id = $2`, [department.id, lecturer.id]);

    const res = await as(admin.auth).patch(`/admin/departments/${department.id}`).send({ name: `Department of Geography ${n}`, code: `dgeog${n}` });
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual({ departmentId: department.id, name: `Department of Geography ${n}`, code: `DGEOG${n}` });

    const call = calls.find((c) => c.method === 'PATCH')!;
    expect(call.path).toBe(`/api/v1/integrations/attendance/departments/${department.smartttId}/`);
    expect(JSON.parse(call.body.toString())).toEqual({ name: `Department of Geography ${n}`, code: `DGEOG${n}` });
    expect(smartttDepartments.find((d) => d.id === department.smartttId)).toMatchObject({ name: `Department of Geography ${n}`, code: `DGEOG${n}` });

    const { rows: [row] } = await pool.query<{ name: string; code: string }>(`SELECT name, code FROM departments WHERE id = $1`, [department.id]);
    expect(row).toEqual({ name: `Department of Geography ${n}`, code: `DGEOG${n}` });
    const { rows: [placed] } = await pool.query<{ department_id: string }>(`SELECT department_id FROM lecturer_profiles WHERE user_id = $1`, [lecturer.id]);
    expect(placed!.department_id).toBe(department.id);

    const [audit] = await audits('DEPARTMENT_UPDATED');
    expect(audit).toBeDefined();
  });

  it("refuses another department's name or code, here or in SMARTTT, and changes nothing", async () => {
    const admin = await makeUser('ADMIN');
    const n = uniq();
    await linked(`Physics ${n}`, `PHY${n}`);
    const chemistry = await linked(`Chemistry ${n}`, `CHEM${n}`);

    const name = await as(admin.auth).patch(`/admin/departments/${chemistry.id}`).send({ name: `physics ${n}`, code: `CHEM${n}` });
    expect(name.status).toBe(409);
    const code = await as(admin.auth).patch(`/admin/departments/${chemistry.id}`).send({ name: `Chemistry ${n}`, code: `phy${n}` });
    expect(code.status).toBe(409);
    expect(body(code).error?.message).toMatch(`PHY${n} is already used by Physics ${n}`);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);

    // Known only to SMARTTT (not read in yet): SMARTTT's refusal is passed on.
    smartttDepartments.push({ id: nextId++, name: `Botany ${n}`, code: `DBOT${n}`, status: 'active' });
    expect((await as(admin.auth).patch(`/admin/departments/${chemistry.id}`).send({ name: `Chemistry ${n}`, code: `DBOT${n}` })).status).toBe(409);
    const { rows: [row] } = await pool.query<{ name: string; code: string }>(`SELECT name, code FROM departments WHERE id = $1`, [chemistry.id]);
    expect(row).toEqual({ name: `Chemistry ${n}`, code: `CHEM${n}` });
  });

  it('may keep its own name and change only its code', async () => {
    const admin = await makeUser('ADMIN');
    const n = uniq();
    const department = await linked(`Zoology ${n}`, `ZOO${n}`);
    const res = await as(admin.auth).patch(`/admin/departments/${department.id}`).send({ name: `Zoology ${n}`, code: `DZOO${n}` });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ name: `Zoology ${n}`, code: `DZOO${n}` });
  });

  it('nothing changes when SMARTTT is down', async () => {
    const admin = await makeUser('ADMIN');
    const n = uniq();
    const department = await linked(`Statistcs ${n}`, `STA${n}`);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const res = await as(admin.auth).patch(`/admin/departments/${department.id}`).send({ name: `Statistics ${n}`, code: `STA${n}` });
    expect(res.status).toBe(503);
    const { rows: [row] } = await pool.query<{ name: string }>(`SELECT name FROM departments WHERE id = $1`, [department.id]);
    expect(row!.name).toBe(`Statistcs ${n}`);
  });

  it('a department only here is corrected here', async () => {
    const admin = await makeUser('ADMIN');
    const n = uniq();
    const { rows: [local] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ($1, $2) RETURNING id`, [`Musik ${n}`, `MUS${n}`]);
    const res = await as(admin.auth).patch(`/admin/departments/${local!.id}`).send({ name: `Music ${n}`, code: `MUS${n}` });
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('is 404 for an unknown department and for administrators only', async () => {
    const admin = await makeUser('ADMIN');
    const lecturer = await makeUser('LECTURER');
    expect((await as(admin.auth).patch(`/admin/departments/${randomUUID()}`).send({ name: 'Anything', code: 'ANY' })).status).toBe(404);
    expect((await as(lecturer.auth).patch(`/admin/departments/${randomUUID()}`).send({ name: 'Anything', code: 'ANY' })).status).toBe(403);
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
    expect((await read('some-other-key')).status).toBe(401);
  });

  it("lists every department with its code, SMARTTT id and active lecturers, SMARTTT's first", async () => {
    smartttDepartments = [{ id: 41, name: 'Department of Nursing', code: 'DN', status: 'active' }];
    const { rows: [local] } = await pool.query<{ id: string }>(`INSERT INTO departments (name) VALUES ('Department of Geography ${uniq()}') RETURNING id`);
    const lecturer = await makeUser('LECTURER');
    await pool.query(`UPDATE lecturer_profiles SET department_id = $2 WHERE user_id = $1`, [lecturer.id, local!.id]);

    const res = await read('generator-key');
    expect(res.status).toBe(200);
    const departments = (body(res).data as { departments: Record<string, unknown>[] }).departments;
    expect(departments.find((d) => d['name'] === 'Department of Nursing')).toMatchObject({
      code: 'DN', smartttDepartmentId: 41, lecturerCount: 0,
    });
    expect(departments.find((d) => d['id'] === local!.id)).toMatchObject({ code: null, smartttDepartmentId: null, lecturerCount: 1 });
    expect(departments[0]).not.toHaveProperty('facultyName');
  });
});

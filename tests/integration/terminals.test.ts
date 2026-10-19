import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Portable department terminals, against a real Postgres database.
 *
 * The lifecycle end to end: a department officer adds a device and gets a
 * one-time pairing code; the device trades it for its own key; a lecturer's
 * screen shows a link code; the device scans it and records check-ins for
 * that class. And the rules that make a pooled, portable device safe: only
 * its own department's classes, only the readers it has, a lost device is
 * cut off on its next request.
 */
const TEST_DB = 'attendance_terminals_test';
const FINGER_SECRET = 'finger-ref-secret-for-tests-0123456789';

const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let hashCardUid: (uid: string, secret: string) => string;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

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

async function makeDepartment(): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name) VALUES ($1) RETURNING id`, [`Department ${uniq()}`]);
  return d!.id;
}

async function makeOfficer(departmentId: string) {
  const user = await makeUser('DEPARTMENT', 'Officer');
  await pool.query(`INSERT INTO department_profiles (user_id, department_id) VALUES ($1, $2)`, [user.id, departmentId]);
  return user;
}

async function makeLecturer(departmentId: string) {
  const user = await makeUser('LECTURER', 'Dr. Terminal');
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id) VALUES ($1, $2, NOW(), $3)`,
    [user.id, `STF/T${uniq()}`, departmentId]);
  return user;
}

async function makeStudent() {
  const n = uniq();
  const reg = `SCT211-${String(n).padStart(4, '0')}/2022`;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'STUDENT', 'ACTIVE', NOW()) RETURNING id`,
    [`stu${n}@students.uni.ac.ke`, `Student ${n}`]);
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at)
     VALUES ($1, $2, 'ERP', NOW())`, [u!.id, reg]);
  return { id: u!.id, reg, fullName: `Student ${n}` };
}

/** A unit the lecturer teaches, with a live session accepting the given methods, and the student on its roster. */
async function makeLiveClass(lecturerId: string, methods: string[] = ['QR', 'CARD', 'FINGERPRINT'], students: Array<{ id: string; reg: string }> = []) {
  const code = `COSC T${uniq()}`;
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'Terminal Unit', $2, 'VERIFIED') RETURNING id`,
    [code, lecturerId]);
  const { rows: [session] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds, geofence_mode, verification_methods)
     VALUES ($1, $2, $3, 'OPEN', NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '1 hour', 60, 'OFF', $4::text[])
     RETURNING id`,
    [unit!.id, lecturerId, randomBytes(32).toString('base64url'), methods]);
  for (const s of students) {
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
       VALUES ($1, $2, $3, 'Student', 'ACTIVE', 'ERP')`, [unit!.id, s.reg, s.id]);
  }
  return { unitId: unit!.id, sessionId: session!.id, code };
}

// --- The three callers ------------------------------------------------------

const officerApi = (officer: { auth: string }) => ({
  list: () => request(app).get('/api/v1/departments/terminals').set('Authorization', officer.auth),
  create: (payload: Record<string, unknown>) =>
    request(app).post('/api/v1/departments/terminals').set('Authorization', officer.auth).send(payload),
  patch: (id: string, payload: Record<string, unknown>) =>
    request(app).patch(`/api/v1/departments/terminals/${id}`).set('Authorization', officer.auth).send(payload),
  action: (id: string, action: 'pairing' | 'lost' | 'retire') =>
    request(app).post(`/api/v1/departments/terminals/${id}/${action}`).set('Authorization', officer.auth),
});

const linkCodeFor = (lecturer: { auth: string }, sessionId: string) =>
  request(app).get(`/api/v1/sessions/${sessionId}/terminal-link`).set('Authorization', lecturer.auth);

const deviceApi = (key: string | null) => {
  const post = (path: string, payload: Record<string, unknown> = {}) => {
    const req = request(app).post(`/api/v1/terminals/${path}`);
    if (key !== null) req.set('X-Terminal-Key', key);
    return req.send(payload);
  };
  return {
    heartbeat: (payload: Record<string, unknown> = {}) => post('heartbeat', payload),
    link: (linkCode: string) => post('link', { linkCode }),
    unlink: () => post('unlink'),
    checkIn: (payload: Record<string, unknown>) => post('check-in', payload),
  };
};

const pair = (pairingCode: string) => request(app).post('/api/v1/terminals/pair').send({ pairingCode });

/** A department with an officer and a lecturer, and one paired device. */
async function setUp(capabilities = ['BARCODE', 'FINGERPRINT']) {
  const departmentId = await makeDepartment();
  const officer = await makeOfficer(departmentId);
  const lecturer = await makeLecturer(departmentId);
  const created = await officerApi(officer).create({ code: `term-${uniq()}`, label: 'Pool A', capabilities });
  expect(created.status).toBe(201);
  const { terminal, pairingCode } = body<{ terminal: { id: string; code: string }; pairingCode: string }>(created).data;
  const paired = await pair(pairingCode);
  expect(paired.status).toBe(200);
  const key = body<{ key: string }>(paired).data.key;
  return { departmentId, officer, lecturer, terminal, key, device: deviceApi(key) };
}

/** Links the device to the class through the lecturer's code, as in the room. */
async function linkTo(ctx: { lecturer: { auth: string }; device: ReturnType<typeof deviceApi> }, sessionId: string) {
  const code = await linkCodeFor(ctx.lecturer, sessionId);
  expect(code.status).toBe(200);
  return ctx.device.link(body<{ linkCode: string }>(code).data.linkCode);
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.FINGERPRINT_TERMINAL_API_KEY = 'fingerprint-terminal-key-for-tests-0123';
  process.env.FINGERPRINT_REF_SECRET = FINGER_SECRET;

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  ({ hashCardUid } = await import('../../src/common/utils/card-uid.js'));
});

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

describe('registering and pairing a terminal', () => {
  it('gives the officer a one-time code, and the device a key for it', async () => {
    const departmentId = await makeDepartment();
    const officer = await makeOfficer(departmentId);

    const created = await officerApi(officer).create({ code: 'csc-01', capabilities: ['BARCODE', 'BARCODE', 'FINGERPRINT'] });
    expect(created.status).toBe(201);
    const { terminal, pairingCode } = body<{ terminal: Record<string, unknown>; pairingCode: string }>(created).data;
    expect(terminal).toMatchObject({ code: 'CSC-01', status: 'PENDING', capabilities: ['BARCODE', 'FINGERPRINT'] });
    expect(pairingCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    // Typed in lower case without the dash: still the same code.
    const paired = await pair(pairingCode.replace('-', '').toLowerCase());
    expect(paired.status).toBe(200);
    expect(body<{ key: string }>(paired).data.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body(paired).data).toMatchObject({ terminal: { code: 'CSC-01' }, session: null });

    // Single use.
    expect((await pair(pairingCode)).status).toBe(400);

    const listed = body<Array<Record<string, unknown>>>(await officerApi(officer).list()).data;
    expect(listed).toEqual([expect.objectContaining({ code: 'CSC-01', status: 'ACTIVE' })]);

    // Neither the key nor the code is stored in the clear.
    const { rows: [row] } = await pool.query<{ key_hash: string; pairing_code_hash: string | null }>(
      `SELECT key_hash, pairing_code_hash FROM terminals WHERE code = 'CSC-01'`);
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.pairing_code_hash).toBeNull();
  });

  it('refuses an expired pairing code', async () => {
    const officer = await makeOfficer(await makeDepartment());
    const { pairingCode } = body<{ pairingCode: string }>(await officerApi(officer).create({ code: `X-${uniq()}`, capabilities: ['BARCODE'] })).data;
    await pool.query(`UPDATE terminals SET pairing_expires_at = NOW() - INTERVAL '1 minute' WHERE status = 'PENDING'`);
    expect((await pair(pairingCode)).status).toBe(400);
  });

  it('refuses a duplicate name and an empty capability list', async () => {
    const officer = await makeOfficer(await makeDepartment());
    const code = `DUP-${uniq()}`;
    expect((await officerApi(officer).create({ code, capabilities: ['BARCODE'] })).status).toBe(201);
    expect((await officerApi(officer).create({ code: code.toLowerCase(), capabilities: ['BARCODE'] })).status).toBe(409);
    expect((await officerApi(officer).create({ code: `E-${uniq()}`, capabilities: [] })).status).toBe(400);
  });

  it("keeps each department's devices to itself", async () => {
    const ctx = await setUp();
    const stranger = await makeOfficer(await makeDepartment());
    expect(body<unknown[]>(await officerApi(stranger).list()).data).toEqual([]);
    expect((await officerApi(stranger).action(ctx.terminal.id, 'lost')).status).toBe(404);
    expect((await officerApi(stranger).patch(ctx.terminal.id, { label: 'mine now' })).status).toBe(404);

    // And only department officers manage devices at all.
    expect((await request(app).get('/api/v1/departments/terminals').set('Authorization', ctx.lecturer.auth)).status).toBe(403);
  });

  it('records what the device reports, for the devices page', async () => {
    const ctx = await setUp();
    const beat = await ctx.device.heartbeat({ batteryPercent: 64, network: 'CELLULAR', appVersion: '1.0.3' });
    expect(beat.status).toBe(200);
    expect(body(beat).data).toMatchObject({ session: null });

    const [listed] = body<Array<Record<string, unknown>>>(await officerApi(ctx.officer).list()).data;
    expect(listed).toMatchObject({ batteryPercent: 64, network: 'CELLULAR', appVersion: '1.0.3' });
    expect(typeof listed!['lastSeenAt']).toBe('string');
  });

  it('refuses a device with no key or an unknown one', async () => {
    expect((await deviceApi(null).heartbeat()).status).toBe(401);
    expect((await deviceApi('not-a-real-key').heartbeat()).status).toBe(401);
  });
});

describe('a lost or handed-over device', () => {
  it('is cut off on its next request when marked lost', async () => {
    const ctx = await setUp();
    expect((await ctx.device.heartbeat()).status).toBe(200);

    const lost = await officerApi(ctx.officer).action(ctx.terminal.id, 'lost');
    expect(lost.status).toBe(200);
    expect(body(lost).data).toMatchObject({ status: 'LOST' });
    expect((await ctx.device.heartbeat()).status).toBe(401);
  });

  it('gets a new key when re-paired, and the old one stops working', async () => {
    const ctx = await setUp();
    const reissued = await officerApi(ctx.officer).action(ctx.terminal.id, 'pairing');
    expect(reissued.status).toBe(200);
    expect((await ctx.device.heartbeat()).status).toBe(401);

    const paired = await pair(body<{ pairingCode: string }>(reissued).data.pairingCode);
    const fresh = deviceApi(body<{ key: string }>(paired).data.key);
    expect((await fresh.heartbeat()).status).toBe(200);
  });

  it('cannot be re-paired once retired', async () => {
    const ctx = await setUp();
    expect((await officerApi(ctx.officer).action(ctx.terminal.id, 'retire')).status).toBe(200);
    expect((await officerApi(ctx.officer).action(ctx.terminal.id, 'pairing')).status).toBe(409);
    expect((await ctx.device.heartbeat()).status).toBe(401);
  });
});

describe('linking a terminal to a class', () => {
  it("links to a class taught by its department's lecturer, and says what the class accepts", async () => {
    const ctx = await setUp(['BARCODE', 'FINGERPRINT']);
    const cls = await makeLiveClass(ctx.lecturer.id, ['QR', 'CARD']);

    const linked = await linkTo(ctx, cls.sessionId);
    expect(linked.status).toBe(200);
    expect(body(linked).data).toMatchObject({
      session: { sessionId: cls.sessionId, unitCode: cls.code, accepts: ['BARCODE'] },
    });
    expect(body(await ctx.device.heartbeat()).data).toMatchObject({ session: { sessionId: cls.sessionId } });

    const [listed] = body<Array<Record<string, unknown>>>(await officerApi(ctx.officer).list()).data;
    expect(listed).toMatchObject({ linkedSession: { sessionId: cls.sessionId, unitCode: cls.code } });
  });

  it("refuses a class taught by another department's lecturer", async () => {
    const ctx = await setUp();
    const outsider = await makeLecturer(await makeDepartment());
    const cls = await makeLiveClass(outsider.id);

    const res = await linkTo({ lecturer: outsider, device: ctx.device }, cls.sessionId);
    expect(res.status).toBe(403);
    expect(body(res).error?.message).toMatch(/another department/i);
    const { rows } = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'TERMINAL_LINK_REFUSED'`);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a class that takes none of its readers', async () => {
    const ctx = await setUp(['FINGERPRINT']);
    const cls = await makeLiveClass(ctx.lecturer.id, ['QR', 'CARD']);
    expect((await linkTo(ctx, cls.sessionId)).status).toBe(409);
  });

  it('gives a link code only to the class lecturer, and only while the class runs', async () => {
    const ctx = await setUp();
    const cls = await makeLiveClass(ctx.lecturer.id);
    const colleague = await makeLecturer(ctx.departmentId);
    expect((await linkCodeFor(colleague, cls.sessionId)).status).toBe(403);

    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = $1`, [cls.sessionId]);
    expect((await linkCodeFor(ctx.lecturer, cls.sessionId)).status).toBe(409);
  });

  it('refuses a forged, garbled or expired code', async () => {
    const ctx = await setUp();
    const cls = await makeLiveClass(ctx.lecturer.id);
    const { linkCode } = body<{ linkCode: string }>(await linkCodeFor(ctx.lecturer, cls.sessionId)).data;
    const [prefix, sessionId, expires] = linkCode.split('.');

    expect((await ctx.device.link(`${prefix}.${sessionId}.${expires}.${'A'.repeat(32)}`)).status).toBe(400);
    // Pushing the expiry out breaks the signature.
    expect((await ctx.device.link(`${prefix}.${sessionId}.${Number(expires) + 3600}.${linkCode.split('.')[3]}`)).status).toBe(400);
    expect((await ctx.device.link('not a code at all')).status).toBe(400);

    const { issueLinkCode } = await import('../../src/modules/terminal/terminal.link.js');
    const { rows: [s] } = await pool.query<{ qr_secret: string }>(`SELECT qr_secret FROM attendance_sessions WHERE id = $1`, [cls.sessionId]);
    const stale = issueLinkCode(cls.sessionId, s!.qr_secret, new Date(Date.now() - 10 * 60_000));
    expect((await ctx.device.link(stale.code)).status).toBe(410);
  });

  it('lets go of a class that has closed, and on unlink', async () => {
    const ctx = await setUp();
    const cls = await makeLiveClass(ctx.lecturer.id);
    expect((await linkTo(ctx, cls.sessionId)).status).toBe(200);

    expect(body(await ctx.device.unlink()).data).toMatchObject({ session: null });
    expect(body(await ctx.device.heartbeat()).data).toMatchObject({ session: null });

    expect((await linkTo(ctx, cls.sessionId)).status).toBe(200);
    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = $1`, [cls.sessionId]);
    expect(body(await ctx.device.heartbeat()).data).toMatchObject({ session: null });
    const { rows: [t] } = await pool.query<{ linked_session_id: string | null }>(
      `SELECT linked_session_id FROM terminals WHERE id = $1`, [ctx.terminal.id]);
    expect(t!.linked_session_id).toBeNull();
  });
});

describe('checking in at a linked terminal', () => {
  it('records a barcode scan for the linked class', async () => {
    const ctx = await setUp();
    const student = await makeStudent();
    const cls = await makeLiveClass(ctx.lecturer.id, ['CARD'], [student]);
    await linkTo(ctx, cls.sessionId);

    const res = await ctx.device.checkIn({ barcode: student.reg });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ sessionId: cls.sessionId, student: { registrationNumber: student.reg } });
    expect((await ctx.device.checkIn({ barcode: student.reg })).status).toBe(409);
  });

  it("records a fingerprint matched in this reader's own slots", async () => {
    const ctx = await setUp();
    const student = await makeStudent();
    const cls = await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [student]);
    await pool.query(
      `INSERT INTO student_fingerprints (student_user_id, terminal_id, finger_ref_hmac, status) VALUES ($1, $2, $3, 'ACTIVE')`,
      [student.id, ctx.terminal.code, hashCardUid('37', FINGER_SECRET)]);
    await linkTo(ctx, cls.sessionId);

    const res = await ctx.device.checkIn({ fingerRef: '37' });
    expect(res.status).toBe(201);
    const { rows: [r] } = await pool.query<{ verification_method: string }>(
      `SELECT verification_method FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(r!.verification_method).toBe('FINGERPRINT');

    // Slot 38 was never enrolled on this reader.
    expect((await ctx.device.checkIn({ fingerRef: '38' })).status).toBe(404);
  });

  it('refuses a read before the device is linked to a class', async () => {
    const ctx = await setUp();
    const res = await ctx.device.checkIn({ barcode: 'SCT211-0001/2022' });
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/not linked/i);
  });

  it('refuses a reader the device was not set up with', async () => {
    const ctx = await setUp(['BARCODE']);
    const cls = await makeLiveClass(ctx.lecturer.id);
    await linkTo(ctx, cls.sessionId);
    expect((await ctx.device.checkIn({ fingerRef: '1' })).status).toBe(403);
  });

  it('wants exactly one reading per request', async () => {
    const ctx = await setUp();
    expect((await ctx.device.checkIn({})).status).toBe(400);
    expect((await ctx.device.checkIn({ barcode: 'SCT211-0001/2022', fingerRef: '1' })).status).toBe(400);
    expect((await ctx.device.checkIn({ barcode: 'SCT211-0001/2022', sessionId: randomUUID() })).status).toBe(400);
  });

  it('stops recording the moment the device is marked lost', async () => {
    const ctx = await setUp();
    const student = await makeStudent();
    const cls = await makeLiveClass(ctx.lecturer.id, ['CARD'], [student]);
    await linkTo(ctx, cls.sessionId);
    await officerApi(ctx.officer).action(ctx.terminal.id, 'lost');

    expect((await ctx.device.checkIn({ barcode: student.reg })).status).toBe(401);
    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(0);
  });
});


describe('fingerprint enrolment by the department', () => {
  const enrolment = (officer: { auth: string }) => ({
    request: (terminalId: string, payload: Record<string, unknown>) =>
      request(app).post(`/api/v1/departments/terminals/${terminalId}/enrolments`).set('Authorization', officer.auth).send(payload),
    coverage: (q?: string) =>
      request(app).get('/api/v1/departments/enrolment/students').query(q ? { q } : {}).set('Authorization', officer.auth),
    cancel: (commandId: string) =>
      request(app).post(`/api/v1/departments/enrolment/commands/${commandId}/cancel`).set('Authorization', officer.auth),
    revoke: (fingerprintId: string) =>
      request(app).delete(`/api/v1/departments/enrolment/fingerprints/${fingerprintId}`).set('Authorization', officer.auth),
  });
  const commandsOf = (key: string) => request(app).get('/api/v1/terminals/commands').set('X-Terminal-Key', key);
  const complete = (key: string, id: string, payload: Record<string, unknown> = {}) =>
    request(app).post(`/api/v1/terminals/commands/${id}/complete`).set('X-Terminal-Key', key).send(payload);
  const fail = (key: string, id: string, reason: string) =>
    request(app).post(`/api/v1/terminals/commands/${id}/fail`).set('X-Terminal-Key', key).send({ reason });

  it('queues an enrolment, the device takes the finger, and the student can then check in with it', async () => {
    const ctx = await setUp();
    const student = await makeStudent();
    const cls = await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [student]);
    const api = enrolment(ctx.officer);

    const queued = await api.request(ctx.terminal.id, { registrationNumber: student.reg.toLowerCase(), label: 'right index' });
    expect(queued.status).toBe(201);
    const { commandId } = body<{ commandId: string }>(queued).data;

    expect(body(await ctx.device.heartbeat()).data).toMatchObject({ pendingCommands: 1 });
    const listed = body<Array<Record<string, unknown>>>(await commandsOf(ctx.key)).data;
    expect(listed).toEqual([expect.objectContaining({
      id: commandId, kind: 'ENROL_FINGERPRINT', label: 'right index',
      student: { fullName: student.fullName, registrationNumber: student.reg },
    })]);

    // Asking twice is refused while the first is waiting.
    expect((await api.request(ctx.terminal.id, { registrationNumber: student.reg })).status).toBe(409);

    const done = await complete(ctx.key, commandId, { fingerRef: '12' });
    expect(done.status).toBe(200);
    const { fingerprintId } = body<{ fingerprintId: string }>(done).data;
    expect(fingerprintId).toEqual(expect.any(String));
    expect(body(await ctx.device.heartbeat()).data).toMatchObject({ pendingCommands: 0 });

    const [row] = body<Array<{ fingerprints: unknown[]; pending: unknown[] }>>(await api.coverage(student.reg)).data;
    expect(row).toMatchObject({ fingerprints: [expect.objectContaining({ id: fingerprintId, terminalCode: ctx.terminal.code })], pending: [] });

    await linkTo(ctx, cls.sessionId);
    expect((await ctx.device.checkIn({ fingerRef: '12' })).status).toBe(201);
  });

  it('removes an enrolment at once, and tells the device to free the slot', async () => {
    const ctx = await setUp();
    const student = await makeStudent();
    const cls = await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [student]);
    const api = enrolment(ctx.officer);
    const { commandId } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: student.reg })).data;
    const { fingerprintId } = body<{ fingerprintId: string }>(await complete(ctx.key, commandId, { fingerRef: '5' })).data;

    expect((await api.revoke(fingerprintId)).status).toBe(200);
    expect((await api.revoke(fingerprintId)).status).toBe(409);

    await linkTo(ctx, cls.sessionId);
    expect((await ctx.device.checkIn({ fingerRef: '5' })).status).toBe(404);

    const [deletion] = body<Array<{ id: string; kind: string; fingerprintId: string }>>(await commandsOf(ctx.key)).data;
    expect(deletion).toMatchObject({ kind: 'DELETE_FINGERPRINT', fingerprintId });
    expect((await complete(ctx.key, deletion!.id)).status).toBe(200);
    expect(body<unknown[]>(await commandsOf(ctx.key)).data).toEqual([]);

    // The slot is free for someone else now.
    const other = await makeStudent();
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
       VALUES ($1, $2, $3, 'Student', 'ACTIVE', 'ERP')`, [cls.unitId, other.reg, other.id]);
    const { commandId: next } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: other.reg })).data;
    expect((await complete(ctx.key, next, { fingerRef: '5' })).status).toBe(200);
  });

  it('lets the officer cancel a waiting request, and the device report a failed one', async () => {
    const ctx = await setUp();
    const [a, b] = [await makeStudent(), await makeStudent()];
    await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [a, b]);
    const api = enrolment(ctx.officer);
    const { commandId: first } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: a.reg })).data;
    const { commandId: second } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: b.reg })).data;

    expect((await api.cancel(first)).status).toBe(200);
    expect((await complete(ctx.key, first, { fingerRef: '1' })).status).toBe(409);
    expect((await api.cancel(first)).status).toBe(409);

    expect((await fail(ctx.key, second, 'finger too dry after 5 attempts')).status).toBe(200);
    expect(body<unknown[]>(await commandsOf(ctx.key)).data).toEqual([]);
    const { rows: [c] } = await pool.query<{ status: string; failure_reason: string }>(
      `SELECT status, failure_reason FROM terminal_commands WHERE id = $1`, [second]);
    expect(c).toMatchObject({ status: 'FAILED', failure_reason: 'finger too dry after 5 attempts' });
  });

  it('wants the slot when completing an enrolment, and refuses a slot already taken', async () => {
    const ctx = await setUp();
    const [a, b] = [await makeStudent(), await makeStudent()];
    await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [a, b]);
    const api = enrolment(ctx.officer);
    const { commandId: first } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: a.reg })).data;
    const { commandId: second } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: b.reg })).data;

    expect((await complete(ctx.key, first)).status).toBe(400);
    expect((await complete(ctx.key, first, { fingerRef: '9' })).status).toBe(200);
    expect((await complete(ctx.key, second, { fingerRef: '9' })).status).toBe(409);
  });

  it("keeps enrolment to the department's own students and devices", async () => {
    const ctx = await setUp();
    const outsider = await makeStudent();
    await makeLiveClass(await makeLecturer(await makeDepartment()).then((l) => l.id), ['FINGERPRINT'], [outsider]);
    const api = enrolment(ctx.officer);
    expect((await api.request(ctx.terminal.id, { registrationNumber: outsider.reg })).status).toBe(404);
    expect(body<unknown[]>(await api.coverage(outsider.reg)).data).toEqual([]);

    const strangerCtx = await setUp();
    const mine = await makeStudent();
    await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [mine]);
    expect((await api.request(strangerCtx.terminal.id, { registrationNumber: mine.reg })).status).toBe(404);

    // Another device cannot see or complete this device's work.
    const { commandId } = body<{ commandId: string }>(await api.request(ctx.terminal.id, { registrationNumber: mine.reg })).data;
    expect(body<unknown[]>(await commandsOf(strangerCtx.key)).data).toEqual([]);
    expect((await complete(strangerCtx.key, commandId, { fingerRef: '1' })).status).toBe(404);
  });

  it('refuses a device without a fingerprint reader, or one not yet paired', async () => {
    const ctx = await setUp(['BARCODE']);
    const student = await makeStudent();
    await makeLiveClass(ctx.lecturer.id, ['FINGERPRINT'], [student]);
    expect((await enrolment(ctx.officer).request(ctx.terminal.id, { registrationNumber: student.reg })).status).toBe(409);

    const created = await officerApi(ctx.officer).create({ code: `NEW-${uniq()}`, capabilities: ['FINGERPRINT'] });
    const unpaired = body<{ terminal: { id: string } }>(created).data.terminal.id;
    expect((await enrolment(ctx.officer).request(unpaired, { registrationNumber: student.reg })).status).toBe(409);
  });
});

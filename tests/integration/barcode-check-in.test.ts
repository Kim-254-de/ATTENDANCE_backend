import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Joined from parts so a secret scanner doesn't mistake a test fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

/**
 * Check-in by the barcode on a student ID card, against a real Postgres database.
 *
 * The barcode is the registration number, so there is no enrolment: a student
 * with an account and a place on the roster can be scanned straight away.
 * Recorded as CARD, the same method as an NFC swipe. A student SMARTTT knows
 * but who has never signed in gets their account created on the spot; SMARTTT
 * is stubbed at the fetch boundary for that.
 */
const TEST_DB = 'attendance_barcodes_test';
const TERMINAL_KEY = fake('card-terminal-key-f', 'or-tests-0123456789');
const UID_SECRET = fake('card-uid-secret-fo', 'r-tests-9876543210');
const SMARTTT = 'http://smarttt.test.local';

const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

// --- The fake SMARTTT: who its student lookup knows, and whether it answers ---
const smartttStudents = new Map<string, Record<string, unknown>>();
let smartttDown = false;

function stubSmarttt() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!url.href.startsWith(SMARTTT)) return Promise.resolve(new Response('not stubbed', { status: 503 }));
    if (smartttDown) return Promise.reject(new TypeError('fetch failed'));
    if (url.pathname !== '/api/v1/integrations/attendance/students/') return Promise.resolve(new Response('no', { status: 404 }));
    const student = smartttStudents.get(url.searchParams.get('registration_number') ?? '');
    return Promise.resolve(student ? Response.json(student) : Response.json({ detail: 'Not found.' }, { status: 404 }));
  });
}

/** A student in SMARTTT with no attendance account yet. */
function smartttOnly(over: Record<string, unknown> = {}) {
  const n = uniq();
  const reg = `SCT211-${String(8000 + n)}/2023`;
  smartttStudents.set(reg, {
    registration_number: reg, full_name: `New Student ${n}`, email: `new${n}@students.uni.ac.ke`,
    programme: 'BSc Computer Science', year_of_study: 2, is_active: true, ...over,
  });
  return { reg, fullName: `New Student ${n}` };
}

/** Posts a scan as a terminal would. `key` is overridable so the guard can be tested. */
const scan = (sessionId: string, barcode: string, key: string | null = TERMINAL_KEY) => {
  const req = request(app).post('/api/v1/attendance/barcode-check-in');
  if (key !== null) req.set('X-API-Key', key);
  return req.send({ sessionId, barcode });
};

async function makeLecturer() {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', 'Dr. Barcode Test', 'LECTURER', 'ACTIVE', NOW()) RETURNING id`,
    [`lec${n}@uni.ac.ke`]);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`,
    [u!.id, `STF/B${n}`]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'LECTURER' })}` };
}

/** A student with an account, registration number in the university's printed format. */
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

/** A unit the lecturer teaches, with a live session accepting the given methods. */
async function makeLiveClass(lecturerId: string, methods: string[] = ['QR', 'CARD']) {
  const n = uniq();
  const code = `COSC B${n}`;
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'Barcode Test Unit', $2, 'VERIFIED') RETURNING id`,
    [code, lecturerId]);
  const { rows: [session] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds,
        geofence_mode, verification_methods)
     VALUES ($1, $2, 'secret', 'OPEN', NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '1 hour', 60,
             'OFF', $3::text[])
     RETURNING id`,
    [unit!.id, lecturerId, methods]);
  return { unitId: unit!.id, sessionId: session!.id, code };
}

const enrol = (unitId: string, student: { id: string; reg: string }, status = 'ACTIVE') =>
  pool.query(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, 'Student', $4, 'ERP')`,
    [unitId, student.reg, student.id, status]);

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.CARD_TERMINAL_API_KEY = TERMINAL_KEY;
  process.env.CARD_UID_SECRET = UID_SECRET;
  process.env.SMARTTT_BASE_URL = SMARTTT;
  process.env.SMARTTT_API_KEY = fake('attenda', 'nce-key');
  process.env.SMARTTT_ACCOUNTS = 'true';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
});

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

let lecturer: { id: string; auth: string };
beforeEach(async () => { smartttDown = false; stubSmarttt(); lecturer = await makeLecturer(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('barcode check-in', () => {
  it('records a scanned student present as CARD, and tells the terminal who that was', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const res = await scan(cls.sessionId, student.reg);
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({
      sessionId: cls.sessionId,
      unitCode: cls.code,
      student: { fullName: student.fullName, registrationNumber: student.reg },
    });

    const { rows: [record] } = await pool.query<{
      verification_method: string; qr_age_seconds: number | null; geofence_result: string;
    }>(
      `SELECT verification_method, qr_age_seconds, geofence_result
         FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(record).toMatchObject({ verification_method: 'CARD', qr_age_seconds: null, geofence_result: 'NOT_CHECKED' });
  });

  it('matches whatever case the scanner reports, and ignores surrounding whitespace', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const res = await scan(cls.sessionId, `  ${student.reg.toLowerCase()}\r\n`);
    expect(res.status).toBe(201);
  });

  it('refuses a scan with no key or a wrong key, and records nothing', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    expect((await scan(cls.sessionId, student.reg, null)).status).toBe(401);
    expect((await scan(cls.sessionId, student.reg, fake('wrong-key-wrong-', 'key-wrong-key-123'))).status).toBe(401);

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses a registration number neither here nor in SMARTTT, and audits it against that number', async () => {
    const cls = await makeLiveClass(lecturer.id);

    const res = await scan(cls.sessionId, 'SCT211-9999/2022');
    expect(res.status).toBe(404);
    expect(body(res).error?.message).toMatch(/does not match a current student/i);

    const { rows: [audit] } = await pool.query<{ user_id: string | null; subject_registration_number: string }>(
      `SELECT user_id, subject_registration_number FROM audit_logs WHERE action = 'ATTENDANCE_CARD_REJECTED'`);
    expect(audit).toMatchObject({ user_id: null, subject_registration_number: 'SCT211-9999/2022' });
  });

  it('creates the account from SMARTTT for a student who never signed in, and records them', async () => {
    const newcomer = smartttOnly();
    const cls = await makeLiveClass(lecturer.id);
    // On the class list SMARTTT synced, by number only: no account to link yet.
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, status, source) VALUES ($1, $2, 'ACTIVE', 'SMARTTT')`,
      [cls.unitId, newcomer.reg]);

    const res = await scan(cls.sessionId, newcomer.reg);
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ student: { fullName: newcomer.fullName, registrationNumber: newcomer.reg } });

    const { rows: [user] } = await pool.query<{ id: string; role: string; status: string; smarttt_user_id: string | null }>(
      `SELECT u.id, u.role, u.status, u.smarttt_user_id FROM users u
         JOIN student_profiles p ON p.user_id = u.id WHERE p.registration_number = $1`, [newcomer.reg]);
    // Linked to SMARTTT by number at their first sign-in, not now.
    expect(user).toMatchObject({ role: 'STUDENT', status: 'ACTIVE', smarttt_user_id: null });
    const { rows: [allocation] } = await pool.query<{ student_user_id: string }>(
      `SELECT student_user_id FROM unit_allocations WHERE registration_number = $1`, [newcomer.reg]);
    expect(allocation!.student_user_id).toBe(user!.id);

    const { rows: [audit] } = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE action = 'SMARTTT_ACCOUNT_CREATED' AND user_id = $1`, [user!.id]);
    expect(audit!.metadata).toMatchObject({ via: 'TERMINAL' });

    // A second scan finds the account without asking SMARTTT again.
    const calls = vi.mocked(fetch).mock.calls.length;
    expect((await scan(cls.sessionId, newcomer.reg)).status).toBe(409);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  });

  it('creates the account but refuses the scan when the new student is not on this class list', async () => {
    const newcomer = smartttOnly();
    const cls = await makeLiveClass(lecturer.id);

    expect((await scan(cls.sessionId, newcomer.reg)).status).toBe(403);
    const { rows } = await pool.query(`SELECT 1 FROM student_profiles WHERE registration_number = $1`, [newcomer.reg]);
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['no longer a current student', { is_active: false }],
    ['has no email in SMARTTT', { email: null }],
  ])('does not create an account for a student who %s', async (_name, over) => {
    const newcomer = smartttOnly(over);
    const cls = await makeLiveClass(lecturer.id);

    expect((await scan(cls.sessionId, newcomer.reg)).status).toBe(404);
    const { rows } = await pool.query(`SELECT 1 FROM student_profiles WHERE registration_number = $1`, [newcomer.reg]);
    expect(rows).toHaveLength(0);
  });

  it('says to try again, not "unknown", when SMARTTT cannot be reached', async () => {
    const newcomer = smartttOnly();
    const cls = await makeLiveClass(lecturer.id);
    smartttDown = true;

    const res = await scan(cls.sessionId, newcomer.reg);
    expect(res.status).toBe(503);
    expect(body(res).error?.code).toBe('SMARTTT_UNAVAILABLE');
  });

  it('refuses a deleted account', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);
    await pool.query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [student.id]);

    expect((await scan(cls.sessionId, student.reg)).status).toBe(404);
  });

  it('refuses a class whose lecturer did not tick ID card scanning', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id, ['QR']);
    await enrol(cls.unitId, student);

    const res = await scan(cls.sessionId, student.reg);
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/not taking ID card/i);
  });

  it('refuses a student who is not on the roster', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);

    const res = await scan(cls.sessionId, student.reg);
    expect(res.status).toBe(403);
    expect(body(res).error?.message).toMatch(/not registered/i);
  });

  it('records one student once, even if they also use another method', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id, ['QR', 'CARD', 'FINGERPRINT']);
    await enrol(cls.unitId, student);

    expect((await scan(cls.sessionId, student.reg)).status).toBe(201);
    const again = await scan(cls.sessionId, student.reg);
    expect(again.status).toBe(409);
    expect(body(again).error?.message).toMatch(/already recorded/i);

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a closed class', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = $1`, [cls.sessionId]);
    expect((await scan(cls.sessionId, student.reg)).status).toBe(409);
  });

  it('refuses a session that does not exist, and a malformed one, without a 500', async () => {
    expect((await scan(randomUUID(), 'SCT211-0001/2022')).status).toBe(404);
    expect((await scan('not-a-uuid', 'SCT211-0001/2022')).status).toBe(400);
  });

  it('rejects a barcode that is not plausibly a registration number', async () => {
    const cls = await makeLiveClass(lecturer.id);
    for (const code of ['', 'ab', "SCT'; DROP TABLE users;--", '/SCT211', 'a'.repeat(100)]) {
      const res = await scan(cls.sessionId, code);
      expect(res.status, `barcode: ${code}`).toBe(400);
    }
  });
});

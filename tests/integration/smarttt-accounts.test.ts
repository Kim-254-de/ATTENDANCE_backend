import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Students and lecturers sign in with their SMARTTT account
 * (docs/smarttt-accounts.md), against a real Postgres database. SMARTTT is
 * stubbed at the fetch boundary: `smartttUsers` is who exists there, with
 * their passwords.
 */
const TEST_DB = 'attendance_smarttt_accounts_test';
const SMARTTT = 'http://smarttt.test.local';
const KEY = 'attendance-key';
const PASSWORD = 'Sm4rtttPassw0rd';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let env: { SMARTTT_BASE_URL?: string; SMARTTT_ACCOUNTS: boolean };

interface Body { data?: Record<string, unknown>; error?: { code: string; message: string } }
const body = (res: request.Response): Body => res.body as Body;
const uniq = (() => { let n = 0; return () => ++n; })();

// --- The fake SMARTTT ---------------------------------------------------------

interface SmartttUser {
  id: string;
  role: string;
  universityId: string | null;
  email: string;
  fullName: string;
  password: string;
  student?: Record<string, unknown> | null;
  staff?: Record<string, unknown> | null;
}
const smartttUsers: SmartttUser[] = [];
let smartttMode: 'UP' | 'DOWN' | 'BAD_KEY' = 'UP';
const smartttCalls: Array<{ url: string; method: string; key: string | null; body: Record<string, unknown> }> = [];

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.startsWith(SMARTTT)) return Promise.resolve(new Response('not stubbed', { status: 503 }));
    const sent = JSON.parse((init?.body as string | undefined) ?? '{}') as Record<string, unknown>;
    smartttCalls.push({ url, method: init?.method ?? 'GET', key: new Headers(init?.headers).get('X-API-Key'), body: sent });
    if (smartttMode === 'DOWN') return Promise.reject(new TypeError('fetch failed'));
    if (smartttMode === 'BAD_KEY') return Promise.resolve(Response.json({ detail: 'A valid X-API-Key header is required.' }, { status: 403 }));
    if (!url.endsWith('/api/v1/integrations/attendance/authenticate/')) return Promise.resolve(new Response('no', { status: 404 }));

    const id = String(sent['identifier']).trim().toLowerCase();
    const user = smartttUsers.find((u) => [u.email.toLowerCase(), u.universityId?.toLowerCase()].includes(id));
    if (!user || user.password !== sent['password']) return Promise.resolve(Response.json({ authenticated: false }));
    return Promise.resolve(Response.json({
      authenticated: true,
      account: { id: user.id, role: user.role, university_id: user.universityId, email: user.email, full_name: user.fullName },
      student: user.student ?? null,
      staff: user.staff ?? null,
    }));
  });
}

function smartttStudent(over: Partial<SmartttUser> = {}): SmartttUser {
  const n = uniq();
  const reg = over.universityId === undefined ? `EBT1/${String(n).padStart(5, '0')}/23` : over.universityId;
  const user: SmartttUser = {
    id: randomUUID(), role: 'student', universityId: reg, email: `student${n}@students.uni.ac.ke`,
    fullName: `Student ${n}`, password: PASSWORD, ...over,
  };
  if (over.student === undefined) {
    user.student = reg
      ? { registration_number: reg, full_name: user.fullName, email: user.email, programme: 'BSc Computer Science', year_of_study: 3, is_active: true }
      : null;
  }
  smartttUsers.push(user);
  return user;
}

function smartttLecturer(over: Partial<SmartttUser> = {}): SmartttUser {
  const n = uniq();
  const staffNumber = over.universityId ?? `STF/${String(n).padStart(4, '0')}`;
  const user: SmartttUser = {
    id: randomUUID(), role: 'lecturer', universityId: staffNumber, email: `lecturer${n}@uni.ac.ke`,
    fullName: `Dr. Lecturer ${n}`, password: PASSWORD,
    staff: {
      staff_number: staffNumber, full_name: `Dr. Lecturer ${n}`, email: `lecturer${n}@uni.ac.ke`,
      department: 'Computer Science', faculty: 'Science', title: 'Dr.', has_account: true, is_active: true,
    },
    ...over,
  };
  smartttUsers.push(user);
  return user;
}

// --- Helpers ------------------------------------------------------------------

const login = (identifier: string, password = PASSWORD) =>
  request(app).post('/api/v1/auth/login').send({ identifier, password });
const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

/** An attendance account made the old way, with its own password: someone who registered here before. */
async function legacyStudent(registrationNumber: string, status = 'ACTIVE') {
  const hash = await (await import('../../src/common/utils/password.js')).hashPassword('OldAttendancePw1');
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status) VALUES ($1, $2, 'Old Name', 'STUDENT', $3) RETURNING id`,
    [`legacy${uniq()}@x.com`, hash, status]);
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at) VALUES ($1, $2, 'SMARTTT', NOW())`,
    [u!.id, registrationNumber]);
  return u!.id;
}

const audits = async (action: string) =>
  (await pool.query<{ outcome: string; user_id: string | null; reason: string | null; metadata: Record<string, unknown> }>(
    `SELECT outcome, user_id, reason, metadata FROM audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;

// --- Setup ----------------------------------------------------------------------

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.SMARTTT_BASE_URL = SMARTTT;
  process.env.SMARTTT_API_KEY = KEY;
  process.env.SMARTTT_ACCOUNTS = 'true';
  process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  ({ env } = await import('../../src/config/env.js'));
  app = (await import('../../src/app.js')).createApp();
});

beforeEach(() => {
  smartttMode = 'UP';
  env.SMARTTT_BASE_URL = SMARTTT;
  env.SMARTTT_ACCOUNTS = true;
  stubFetch();
});
afterEach(() => { vi.restoreAllMocks(); smartttCalls.length = 0; });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

// --- Tests --------------------------------------------------------------------------

describe('first sign-in with a SMARTTT account', () => {
  it('creates the student here, puts them on their class lists, and signs them in', async () => {
    const s = smartttStudent();
    // A class list synced from SMARTTT before the student ever signed in.
    const { rows: [lecturer] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, status) VALUES ($1, 'x', 'L', 'LECTURER', 'ACTIVE') RETURNING id`, [`l${uniq()}@x.com`]);
    const { rows: [unit] } = await pool.query<{ id: string }>(
      `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'Unit', $2, 'VERIFIED') RETURNING id`, [`COSC ${uniq()}`, lecturer!.id]);
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, status, source) VALUES ($1, $2, 'ACTIVE', 'SMARTTT')`, [unit!.id, s.universityId]);

    const res = await login(s.universityId!.toLowerCase());
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      role: 'student', registrationNumber: s.universityId, fullName: s.fullName, email: s.email, programme: 'BSc Computer Science',
    });
    expect(cookiesOf(res).some((c) => c.startsWith('sa_access='))).toBe(true);

    // The password went to SMARTTT once, in a POST body with the shared key, never in a URL.
    expect(smartttCalls).toHaveLength(1);
    expect(smartttCalls[0]).toMatchObject({ method: 'POST', key: KEY, body: { identifier: s.universityId!.toLowerCase(), password: PASSWORD } });
    expect(smartttCalls[0]!.url).not.toContain(PASSWORD);

    const { rows: [user] } = await pool.query<{ id: string; smarttt_user_id: string; status: string }>(
      `SELECT id, smarttt_user_id, status FROM users WHERE email = $1`, [s.email]);
    expect(user).toMatchObject({ smarttt_user_id: s.id, status: 'ACTIVE' });
    const { rows: [allocation] } = await pool.query<{ student_user_id: string }>(
      `SELECT student_user_id FROM unit_allocations WHERE unit_id = $1`, [unit!.id]);
    expect(allocation!.student_user_id).toBe(user!.id);
    expect((await audits('SMARTTT_ACCOUNT_CREATED')).at(-1)).toMatchObject({ user_id: user!.id, metadata: { smartttUserId: s.id } });

    // Signed in: /me works with the cookie.
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookiesOf(res));
    expect(me.status).toBe(200);
  });

  it('creates a lecturer with their department from SMARTTT', async () => {
    const l = smartttLecturer();
    const res = await login(l.email.toUpperCase());
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ role: 'lecturer', staffNumber: l.universityId, title: 'Dr.', department: 'Computer Science' });
  });

  it('links a student who registered here before, keeping their account, and their old password stops working', async () => {
    const s = smartttStudent();
    const legacyId = await legacyStudent(s.universityId!);

    const res = await login(s.email);
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ id: legacyId, fullName: s.fullName, email: s.email });
    expect((await audits('SMARTTT_ACCOUNT_LINKED')).at(-1)).toMatchObject({ user_id: legacyId });

    // Only SMARTTT's password counts now.
    expect((await login(s.universityId!, 'OldAttendancePw1')).status).toBe(401);
  });

  it('activates a pending account SMARTTT vouches for, but never one an administrator suspended', async () => {
    const pending = smartttStudent();
    await legacyStudent(pending.universityId!, 'PENDING_VERIFICATION');
    expect((await login(pending.universityId!)).status).toBe(200);

    const suspended = smartttStudent();
    await legacyStudent(suspended.universityId!, 'SUSPENDED');
    const res = await login(suspended.universityId!);
    expect(res.status).toBe(403);
    expect(body(res).error?.code).toBe('ACCOUNT_NOT_ACTIVE');
  });
});

describe('later sign-ins', () => {
  it('find the same account by SMARTTT id, and copy SMARTTT\'s changed name, email and number', async () => {
    const s = smartttStudent();
    const first = body(await login(s.universityId!)).data!;

    s.fullName = 'Renamed Student';
    s.email = `renamed${uniq()}@students.uni.ac.ke`;
    s.universityId = `EBT1/${uniq()}9/23`;
    s.student = { ...s.student!, registration_number: s.universityId, email: s.email, full_name: s.fullName };

    const res = await login(s.email);
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ id: first['id'], fullName: 'Renamed Student', email: s.email, registrationNumber: s.universityId });
  });

  it('copy a changed admission number even when SMARTTT has no student record for it yet', async () => {
    const s = smartttStudent();
    const first = body(await login(s.universityId!)).data!;

    s.universityId = `EBT1/${uniq()}8/23`;
    s.student = null;

    const res = await login(s.email);
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ id: first['id'], registrationNumber: s.universityId });
  });

  it('count wrong passwords towards the lock, which holds even against the right one', async () => {
    const s = smartttStudent();
    await login(s.universityId!).expect(200);

    for (let i = 0; i < 2; i++) {
      const wrong = await login(s.universityId!, 'wrong');
      expect(wrong.status).toBe(401);
      expect(body(wrong).error?.code).toBe('INVALID_CREDENTIALS');
    }
    expect((await login(s.universityId!, 'wrong')).status).toBe(401); // the third locks it
    const calls = smartttCalls.length;
    const locked = await login(s.universityId!);
    expect(locked.status).toBe(429);
    expect(body(locked).error?.code).toBe('ACCOUNT_LOCKED');
    expect(smartttCalls.length).toBe(calls); // refused before SMARTTT is asked
  });
});

describe('refused sign-ins', () => {
  it('a wrong password or an unknown account is the same 401', async () => {
    const s = smartttStudent();
    const wrong = await login(s.universityId!, 'nope');
    const unknown = await login('EBT1/99999/99');
    expect(wrong.status).toBe(401);
    expect(body(wrong).error).toEqual(body(unknown).error);
  });

  it.each([
    ['no admission number', () => smartttStudent({ universityId: null, student: null }), /no admission number/i],
    ['not a current student', () => smartttStudent({ student: { registration_number: `EBT1/${uniq()}7/18`, full_name: 'G', email: null, programme: null, year_of_study: 4, is_active: false } }), /no longer a current student/i],
    ['a lecturer off the staff list', () => smartttLecturer({ staff: null }), /approved staff list/i],
    ['a registrar', () => smartttStudent({ role: 'registrar', student: null }), /only students and lecturers/i],
  ])('%s is told what to fix in SMARTTT', async (_name, make, message) => {
    const u = make();
    const res = await login(u.email);
    expect(res.status).toBe(403);
    expect(body(res).error?.code).toBe('SMARTTT_ACCOUNT_INCOMPLETE');
    expect(body(res).error?.message).toMatch(message);
    expect((await pool.query(`SELECT 1 FROM users WHERE email = $1`, [u.email])).rowCount).toBe(0);
    expect((await audits('SMARTTT_ACCOUNT_REFUSED')).length).toBeGreaterThan(0);
  });

  it('a number already linked to a different SMARTTT account is a conflict for an administrator', async () => {
    const original = smartttStudent();
    await login(original.universityId!).expect(200);
    const impostor = smartttStudent({ universityId: original.universityId, email: `other${uniq()}@x.com` });
    impostor.student = { ...original.student! };
    const res = await login(impostor.email);
    expect(res.status).toBe(409);
    expect(body(res).error?.code).toBe('SMARTTT_ACCOUNT_CONFLICT');
  });

  it.each([['DOWN'], ['BAD_KEY']] as const)('SMARTTT %s is a 503, and nobody is let in', async (mode) => {
    const s = smartttStudent();
    smartttMode = mode;
    const res = await login(s.universityId!);
    expect(res.status).toBe(503);
    expect(body(res).error?.code).toBe('SMARTTT_UNAVAILABLE');
  });
});

describe('what stays with attendance', () => {
  it('department officers sign in with their attendance password; SMARTTT is not asked', async () => {
    const hash = await (await import('../../src/common/utils/password.js')).hashPassword(PASSWORD);
    const { rows: [d] } = await pool.query<{ id: string }>(`INSERT INTO departments (name) VALUES ($1) RETURNING id`, [`Dept ${uniq()}`]);
    const email = `officer${uniq()}@uni.ac.ke`;
    const { rows: [u] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, status) VALUES ($1, $2, 'Officer', 'DEPARTMENT', 'ACTIVE') RETURNING id`, [email, hash]);
    await pool.query(`INSERT INTO department_profiles (user_id, department_id) VALUES ($1, $2)`, [u!.id, d!.id]);

    expect((await login(email)).status).toBe(200);
    expect(smartttCalls).toHaveLength(0);
  });

  it('registration is closed: the SMARTTT account is the account', async () => {
    for (const path of ['/api/v1/auth/student/register', '/api/v1/auth/lecturer/register']) {
      const res = await request(app).post(path).send({
        fullName: 'New Person', email: `new${uniq()}@uni.ac.ke`, registrationNumber: 'EBT1/00001/23', staffNumber: 'STF/0001',
        password: 'Passw0rd!x', confirmPassword: 'Passw0rd!x',
      });
      expect(res.status).toBe(410);
      expect(body(res).error?.code).toBe('ACCOUNTS_MANAGED_BY_SMARTTT');
    }
  });

  it('students and lecturers change and reset their password in SMARTTT, not here', async () => {
    const s = smartttStudent();
    const signedIn = await login(s.universityId!).expect(200);

    const change = await request(app).post('/api/v1/auth/change-password').set('Cookie', cookiesOf(signedIn))
      .send({ currentPassword: PASSWORD, newPassword: 'An0therPassword!', confirmPassword: 'An0therPassword!' });
    expect(change.status).toBe(409);
    expect(body(change).error?.code).toBe('ACCOUNTS_MANAGED_BY_SMARTTT');

    const forgot = await request(app).post('/api/v1/auth/forgot-password').send({ email: s.email });
    expect(forgot.status).toBe(200); // the same answer as always, but no link is sent
    expect((await audits('PASSWORD_RESET_REQUESTED')).at(-1)).toMatchObject({ reason: 'password is managed by SMARTTT' });
    expect((await pool.query(`SELECT 1 FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1`, [s.email])).rowCount).toBe(0);
  });

  it('with SMARTTT accounts off, students sign in with attendance passwords as before', async () => {
    env.SMARTTT_ACCOUNTS = false;
    const reg = `EBT1/${uniq()}5/23`;
    await legacyStudent(reg);
    expect((await login(reg, 'OldAttendancePw1')).status).toBe(200);
    expect(smartttCalls).toHaveLength(0);
  });
});

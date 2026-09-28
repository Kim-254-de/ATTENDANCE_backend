import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Student accounts end to end against a real Postgres database: registration
 * checked against SMARTTT (and the ERP fallback), email verification, sign-in,
 * /auth/me, refresh, password reset, a real QR check-in, and the student's
 * own units and attendance. SMARTTT and the ERP are stubbed at fetch.
 */
const TEST_DB = 'attendance_students_test';
const SMARTTT = 'https://smarttt.test.local';
const PASSWORD = 'Sup3rSecretPw9x';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let env: { SMARTTT_BASE_URL?: string };
let logger: { debug: (...args: unknown[]) => void };

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string; details?: unknown } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
const cookieHeader = (res: request.Response) => cookiesOf(res).map((c) => c.split(';')[0]).join('; ');

const uniq = (() => { let n = 0; return () => ++n; })();
/** Names may only contain letters, so each test student gets a letters-only surname: 12 -> "Kbc". */
const surname = (n: number) => `K${String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('')}`;

/** SMARTTT's student records, keyed by registration number. */
type DirectoryEntry = { full_name: string | null; email: string | null; programme?: string; is_active?: boolean } | 'DOWN';
let smartttStudents: Record<string, DirectoryEntry> = {};
/** The ERP's, for the fallback when SMARTTT is off. */
let erpStudents: Record<string, { fullName: string; status: string }> = {};

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === SMARTTT && url.pathname.endsWith('/students/')) {
      const reg = url.searchParams.get('registration_number') ?? '';
      const entry = smartttStudents[reg];
      if (entry === 'DOWN') return Promise.resolve(new Response('asleep', { status: 503 }));
      if (!entry) return Promise.resolve(new Response('{}', { status: 404 }));
      return Promise.resolve(Response.json({
        registration_number: reg, full_name: entry.full_name, email: entry.email,
        programme: entry.programme ?? 'BSc Computer Science', year_of_study: 3, is_active: entry.is_active ?? true,
      }));
    }
    if (url.origin === SMARTTT) return Promise.resolve(Response.json({ term: null, units: [] })); // lecturer-units
    const reg = decodeURIComponent(url.pathname.split('/students/')[1] ?? '');
    const found = erpStudents[reg];
    if (!found) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(Response.json({ registrationNumber: reg, fullName: found.fullName, programme: 'BEd Arts', status: found.status }));
  });
}

/** The link the (logged, not sent) email would carry. */
let emailedTokens: string[] = [];
function captureEmails() {
  vi.spyOn(logger, 'debug').mockImplementation((...args: unknown[]) => {
    const text = (args[0] as { body?: string } | undefined)?.body ?? '';
    const match = /token=([^\s&]+)/.exec(text);
    if (match) emailedTokens.push(decodeURIComponent(match[1]!));
  });
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.ERP_MAX_RETRIES = '0';
  process.env.SMARTTT_BASE_URL = SMARTTT;
  process.env.SMARTTT_API_KEY = 'k';
  process.env.LOG_LEVEL = 'debug';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  ({ env } = await import('../../src/config/env.js'));
  ({ logger } = await import('../../src/config/logger.js'));
});

beforeEach(() => {
  smartttStudents = {};
  erpStudents = {};
  emailedTokens = [];
  env.SMARTTT_BASE_URL = SMARTTT;
  stubFetch();
  captureEmails();
});
afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

const register = (data: Record<string, unknown>) => request(app).post('/api/v1/auth/student/register').send(data);
const login = (identifier: string, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ identifier, password });

/** A student SMARTTT knows, and the registration form they'd submit. */
function knownStudent(overrides: Partial<{ fullName: string; email: string }> = {}) {
  const n = uniq();
  const reg = `EBT1/${String(10000 + n)}/23`;
  const email = `student${n}@students.tharaka.ac.ke`;
  smartttStudents[reg] = { full_name: `Amina Wanjiku ${surname(n)}`, email };
  return {
    reg,
    form: {
      fullName: overrides.fullName ?? `Amina ${surname(n)}`, // dropped middle name still matches
      email: overrides.email ?? email.toUpperCase(), // any case
      registrationNumber: reg.toLowerCase(),         // any case
      password: PASSWORD,
      confirmPassword: PASSWORD,
    },
  };
}

/** Register, confirm the email, sign in. Returns the cookie header and the user id. */
async function activeStudent() {
  const s = knownStudent();
  expect((await register(s.form)).status).toBe(201);
  expect((await request(app).post('/api/v1/auth/verify-email').send({ token: emailedTokens.at(-1) })).status).toBe(200);
  const res = await login(s.reg);
  expect(res.status).toBe(200);
  return { ...s, cookie: cookieHeader(res), id: body<{ id: string }>(res).data.id };
}

async function lecturerWithUnit(code = `COSC ${100 + uniq()} GR A`) {
  const n = uniq();
  const { rows: [l] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', 'Dr. Jane Otieno', 'LECTURER', 'ACTIVE', NOW()) RETURNING id`, [`lec${n}@uni.ac.ke`]);
  await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [l!.id, `STF/S${n}`]);
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status, base_code, class_group)
     VALUES ($1, 'Computer Applications', $2, 'VERIFIED', 'COSC 103', 'GR A') RETURNING id`, [code, l!.id]);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, l!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: l!.id, unitId: u!.id, code, auth: `Bearer ${await signAccessToken({ userId: l!.id, sessionId, role: 'LECTURER' })}` };
}

describe('student registration', () => {
  it('creates a pending account when SMARTTT knows the student, and emails a student-worded link', async () => {
    const s = knownStudent();
    const res = await register(s.form);
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ registrationNumber: s.reg, status: 'PENDING_VERIFICATION', nextStep: 'VERIFY_EMAIL' });
    expect(emailedTokens).toHaveLength(1);

    const { rows: [p] } = await pool.query<{ registration_number: string; programme: string; directory_source: string }>(`SELECT registration_number, programme, directory_source FROM student_profiles WHERE registration_number = $1`, [s.reg]);
    expect(p).toEqual({ registration_number: s.reg, programme: 'BSc Computer Science', directory_source: 'SMARTTT' });

    // Not yet: the email isn't confirmed.
    const early = await login(s.reg);
    expect(early.status).toBe(403);
    expect(body(early).error?.code).toBe('ACCOUNT_NOT_ACTIVE');
  });

  it('activates on email confirmation and links the student to rosters that already list them', async () => {
    const s = knownStudent();
    const lec = await lecturerWithUnit();
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, full_name, status, source) VALUES ($1, $2, 'Amina', 'ACTIVE', 'SMARTTT')`,
      [lec.unitId, s.reg]);

    await register(s.form);
    const verified = await request(app).post('/api/v1/auth/verify-email').send({ token: emailedTokens.at(-1) });
    expect(verified.status).toBe(200);
    expect(body(verified).data).toMatchObject({ status: 'ACTIVE', nextStep: 'SIGN_IN' }); // no admin approval for students

    const { rows: [a] } = await pool.query<{ student_user_id: string | null }>(`SELECT student_user_id FROM unit_allocations WHERE registration_number = $1`, [s.reg]);
    expect(a!.student_user_id).toEqual(expect.any(String));
  });

  it.each([
    ['not in SMARTTT', () => ({ ...knownStudent().form, registrationNumber: 'EBT1/99999/23' }), 403, 'STUDENT_RECORD_NOT_FOUND'],
    ['not a current student', () => { const s = knownStudent(); smartttStudents[s.reg] = { ...(smartttStudents[s.reg] as object), is_active: false } as DirectoryEntry; return s.form; }, 403, 'STUDENT_RECORD_INACTIVE'],
    ['someone else’s name', () => knownStudent({ fullName: 'Brian Otieno' }).form, 403, 'STUDENT_IDENTITY_MISMATCH'],
    ['someone else’s email', () => knownStudent({ email: 'intruder@gmail.com' }).form, 403, 'STUDENT_IDENTITY_MISMATCH'],
    ['SMARTTT unreachable', () => { const s = knownStudent(); smartttStudents[s.reg] = 'DOWN'; return s.form; }, 503, 'STUDENT_DIRECTORY_UNAVAILABLE'],
  ])('refuses a registration when the number is %s, creating nothing', async (_label, form, status, code) => {
    const f = form();
    const res = await register(f);
    expect(res.status).toBe(status);
    expect(body(res).error?.code).toBe(code);
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE email = lower($1)`, [f.email]);
    expect(rows).toHaveLength(0);
    const { rows: audit } = await pool.query(
      `SELECT action FROM audit_logs WHERE subject_registration_number = upper($1) AND action = 'STUDENT_REGISTRATION_REVOKED'`, [f.registrationNumber]);
    expect(audit).toHaveLength(1);
  });

  it('names only the mismatched fields, never the record’s values', async () => {
    const res = await register(knownStudent({ email: 'intruder@gmail.com' }).form);
    expect(body(res).error?.details).toEqual({ mismatchedFields: ['email'] });
    expect(JSON.stringify(res.body)).not.toMatch(/students\.tharaka\.ac\.ke|Wanjiku/);
  });

  it('refuses a second account for the same registration number or email', async () => {
    const s = knownStudent();
    expect((await register(s.form)).status).toBe(201);
    const again = await register({ ...s.form, email: 'other@students.tharaka.ac.ke' });
    expect(again.status).toBe(409);
    expect(body(again).error?.code).toBe('ACCOUNT_ALREADY_EXISTS');
  });

  it('applies the password policy, including not reusing the registration number', async () => {
    const s = knownStudent();
    expect((await register({ ...s.form, password: 'short', confirmPassword: 'short' })).status).toBe(400);
    const pw = `Aa${s.reg.replace(/\//g, '')}9`;
    const res = await register({ ...s.form, password: pw, confirmPassword: pw });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/registration number/);
  });

  it('checks against the ERP when SMARTTT is not configured (name only: the ERP holds no email)', async () => {
    env.SMARTTT_BASE_URL = undefined;
    erpStudents['EBT1/20000/22'] = { fullName: 'Kevin Tuei Kiprono', status: 'active' };
    const ok = await register({ fullName: 'Kevin Tuei', email: 'kevin@gmail.com', registrationNumber: 'EBT1/20000/22', password: PASSWORD, confirmPassword: PASSWORD });
    expect(ok.status).toBe(201);
    const { rows: [p] } = await pool.query<{ directory_source: string }>(`SELECT directory_source FROM student_profiles WHERE registration_number = 'EBT1/20000/22'`);
    expect(p!.directory_source).toBe('ERP');
  });
});

describe('student sign-in and session', () => {
  it('signs in by registration number or email, and /auth/me returns the student', async () => {
    const s = await activeStudent();
    const byEmail = await login(s.form.email);
    expect(byEmail.status).toBe(200);
    expect(body(byEmail).data).toMatchObject({ role: 'student', registrationNumber: s.reg, programme: 'BSc Computer Science', yearOfStudy: 3 });

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', s.cookie);
    expect(me.status).toBe(200);
    expect(body(me).data).toMatchObject({ id: s.id, role: 'student', registrationNumber: s.reg, avatarUrl: null });
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash/i);
  });

  it('says "registration number" on a wrong password', async () => {
    const s = await activeStudent();
    const res = await login(s.reg, 'Wr0ngPassword99');
    expect(res.status).toBe(401);
    expect(body(res).error?.message).toBe('Incorrect registration number/email or password.');
  });

  it('refreshes a student session and keeps the student role', async () => {
    const s = await activeStudent();
    const signedIn = await login(s.reg);
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieHeader(signedIn));
    expect(refreshed.status).toBe(204);
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookieHeader(refreshed));
    expect(body(me).data).toMatchObject({ role: 'student' });
  });

  it('keeps students and lecturers out of each other’s endpoints', async () => {
    const s = await activeStudent();
    const lec = await lecturerWithUnit();
    expect((await request(app).get('/api/v1/units').set('Cookie', s.cookie)).status).toBe(403);
    expect((await request(app).post('/api/v1/sessions').set('Cookie', s.cookie).send({ unitId: lec.unitId })).status).toBe(403);
    expect((await request(app).get('/api/v1/students/me/units').set('Authorization', lec.auth)).status).toBe(403);
    expect(body(await request(app).get('/api/v1/auth/me').set('Authorization', lec.auth)).data).toMatchObject({ role: 'lecturer' });
  });

  it('resets a forgotten student password by email', async () => {
    const s = await activeStudent();
    emailedTokens = [];
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: s.form.email })).status).toBe(200);
    expect(emailedTokens).toHaveLength(1);
    const next = 'N3wStudentPassword';
    const reset = await request(app).post('/api/v1/auth/reset-password').send({ token: emailedTokens[0], password: next, confirmPassword: next });
    expect(reset.status).toBe(200);
    expect((await login(s.reg)).status).toBe(401);
    expect((await login(s.reg, next)).status).toBe(200);
  });
});

describe("a student's units and attendance", () => {
  it('checks in with a real QR code, then reports units, rates and history', async () => {
    const s = await activeStudent();
    const lec = await lecturerWithUnit();
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
       VALUES ($1, $2, $3, 'Amina', 'ACTIVE', 'SMARTTT')`, [lec.unitId, s.reg, s.id]);

    // An earlier class the student missed.
    await pool.query(
      `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, title, opens_at, closes_at, rotation_seconds)
       VALUES ($1, $2, 'x', 'CLOSED', 'Week 1', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days' + INTERVAL '2 hours', 60)`,
      [lec.unitId, lec.id]);

    // Today's class: the lecturer opens it, the student scans the code on screen.
    // Geofence off: this test is about what a student's units and history report, not where
    // they scanned from. The fence has its own tests in units-attendance.test.ts.
    const opened = await request(app).post('/api/v1/sessions').set('Authorization', lec.auth)
      .send({ unitId: lec.unitId, title: 'Week 2', closesAt: new Date(Date.now() + 3600_000).toISOString(), geofence: 'OFF' });
    expect(opened.status).toBe(201);
    const sessionId = body<{ id: string }>(opened).data.id;
    const qr = await request(app).get(`/api/v1/sessions/${sessionId}/qr`).set('Authorization', lec.auth);
    const checkIn = await request(app).post('/api/v1/attendance/check-in').set('Cookie', s.cookie)
      .send({ payload: body<{ payload: string }>(qr).data.payload });
    expect(checkIn.status).toBe(201);

    // A class that's open right now and not yet attended: not an absence yet.
    await pool.query(
      `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, title, opens_at, closes_at, rotation_seconds)
       VALUES ($1, $2, 'x', 'OPEN', 'Week 2 lab', NOW() - INTERVAL '1 minute', NOW() + INTERVAL '1 hour', 60)`,
      [lec.unitId, lec.id]);

    const units = await request(app).get('/api/v1/students/me/units').set('Cookie', s.cookie);
    expect(units.status).toBe(200);
    expect(body<unknown[]>(units).data).toEqual([expect.objectContaining({
      id: lec.unitId, code: lec.code, baseCode: 'COSC 103', group: 'GR A', lecturerName: 'Dr. Jane Otieno',
      // The lab is still open and not scanned yet, so it isn't counted: 1 of 2, like the history below.
      sessionsHeld: 2, sessionsAttended: 1, attendanceRate: 50,
    })]);

    const history = await request(app).get('/api/v1/students/me/attendance').set('Cookie', s.cookie);
    expect(history.status).toBe(200);
    const h = body<{ summary: unknown; records: { title: string; mark: string }[] }>(history).data;
    // Newest first: Week 2 opened just now, the lab a minute earlier, Week 1 last week.
    expect(h.records.map((r) => [r.title, r.mark])).toEqual([['Week 2', 'PRESENT'], ['Week 2 lab', 'OPEN'], ['Week 1', 'ABSENT']]);
    expect(h.summary).toEqual({ sessionsHeld: 2, attended: 1, attendanceRate: 50 });

    const filtered = await request(app).get(`/api/v1/students/me/attendance?unitId=${randomUUID()}`).set('Cookie', s.cookie);
    expect(body<{ records: unknown[] }>(filtered).data.records).toEqual([]);
    expect((await request(app).get('/api/v1/students/me/attendance?limit=0').set('Cookie', s.cookie)).status).toBe(400);
  });

  it('shows nothing for units the student was dropped from or never on', async () => {
    const s = await activeStudent();
    const lec = await lecturerWithUnit();
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, status, source) VALUES ($1, $2, $3, 'DROPPED', 'SMARTTT')`,
      [lec.unitId, s.reg, s.id]);
    await lecturerWithUnit(); // someone else's unit entirely
    expect(body(await request(app).get('/api/v1/students/me/units').set('Cookie', s.cookie)).data).toEqual([]);
  });
});

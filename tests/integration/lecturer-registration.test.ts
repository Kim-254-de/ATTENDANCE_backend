import fs from 'node:fs';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A lecturer creates an account and signs in straight away: no email
 * confirmation and no administrator approval. The ERP staff check is the only
 * gate. The ERP is stubbed at fetch; everything else runs against a real
 * Postgres database.
 */
const TEST_DB = 'attendance_lecturer_reg_test';
const PASSWORD = 'Sup3rSecretPw9x';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

/** The ERP's staff records, keyed by staff number. */
let erpStaff: Record<string, { fullName: string; email: string; status: string }> = {};

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const staffNumber = decodeURIComponent(url.pathname.split('/staff/')[1] ?? '');
    const found = erpStaff[staffNumber];
    if (!found) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(Response.json({ staffNumber, ...found, department: 'Computing' }));
  });
}

const uniq = (() => { let n = 0; return () => ++n; })();
/** Letters-only surname per test: 12 -> "Kbc". */
const surname = (n: number) => `K${String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('')}`;

function knownLecturer() {
  const n = uniq();
  const staffNumber = `TUN/STF/${String(500 + n)}`;
  const email = `lecturer${n}@tharaka.ac.ke`;
  const fullName = `Grace Njeri ${surname(n)}`;
  erpStaff[staffNumber] = { fullName, email, status: 'ACTIVE' };
  return { staffNumber, email, form: { fullName, email, staffNumber, password: PASSWORD, confirmPassword: PASSWORD } };
}

const register = (data: Record<string, unknown>) => request(app).post('/api/v1/auth/lecturer/register').send(data);
const login = (identifier: string) => request(app).post('/api/v1/auth/login').send({ identifier, password: PASSWORD });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.ERP_MAX_RETRIES = '0';
  process.env.SMARTTT_BASE_URL = '';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
});

beforeEach(() => { erpStaff = {}; stubFetch(); });
afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

describe('lecturer registration', () => {
  it('creates an active account that can sign in immediately', async () => {
    const { staffNumber, form } = knownLecturer();

    const res = await register(form);
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ status: 'ACTIVE', nextStep: 'SIGN_IN' });

    const { rows } = await pool.query<{ status: string; tokens: number }>(
      `SELECT u.status, (SELECT COUNT(*) FROM email_verification_tokens t WHERE t.user_id = u.id) AS tokens
         FROM users u JOIN lecturer_profiles l ON l.user_id = u.id WHERE l.staff_number = $1`,
      [staffNumber],
    );
    expect(rows[0]).toEqual({ status: 'ACTIVE', tokens: 0 });

    const signIn = await login(staffNumber);
    expect(signIn.status).toBe(200);
    expect(body(signIn).data).toMatchObject({ role: 'lecturer', staffNumber });
  });

  it('signs in with the email address too', async () => {
    const { email, form } = knownLecturer();
    expect((await register(form)).status).toBe(201);
    expect((await login(email)).status).toBe(200);
  });

  it('still refuses a staff number the ERP does not know, and creates nothing', async () => {
    const { staffNumber, form } = knownLecturer();
    delete erpStaff[staffNumber];

    const res = await register(form);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await pool.query('SELECT 1 FROM lecturer_profiles WHERE staff_number = $1', [staffNumber]);
    expect(rows).toHaveLength(0);
    expect((await login(staffNumber)).status).toBe(401);
  });

  it('refuses a second account for the same staff number', async () => {
    const { form } = knownLecturer();
    expect((await register(form)).status).toBe(201);
    expect((await register(form)).status).toBe(409);
  });
});

describe('migration 013', () => {
  it('activates lecturers stuck waiting for email or approval, and leaves students alone', async () => {
    const insertUser = async (email: string, role: string, status: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name, role, status) VALUES ($1, 'x', 'Stuck User', $2, $3) RETURNING id`,
        [email, role, status],
      );
      return rows[0]!.id;
    };
    const pendingEmail = await insertUser('stuck.a@tharaka.ac.ke', 'LECTURER', 'PENDING_VERIFICATION');
    const pendingAdmin = await insertUser('stuck.b@tharaka.ac.ke', 'LECTURER', 'PENDING_APPROVAL');
    const suspended = await insertUser('stuck.c@tharaka.ac.ke', 'LECTURER', 'SUSPENDED');
    const student = await insertUser('stuck.d@students.tharaka.ac.ke', 'STUDENT', 'PENDING_VERIFICATION');
    await pool.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, 'h1', NOW() + INTERVAL '1 day'), ($2, 'h2', NOW() + INTERVAL '1 day')`,
      [pendingEmail, student],
    );

    await pool.query(fs.readFileSync(new URL('../../db/migrations/013_lecturers_active_on_registration.sql', import.meta.url), 'utf8'));

    const status = async (id: string) =>
      (await pool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [id])).rows[0]!.status;
    expect(await status(pendingEmail)).toBe('ACTIVE');
    expect(await status(pendingAdmin)).toBe('ACTIVE');
    expect(await status(suspended)).toBe('SUSPENDED');
    expect(await status(student)).toBe('PENDING_VERIFICATION');

    const { rows } = await pool.query<{ user_id: string; consumed: boolean }>(
      'SELECT user_id, consumed_at IS NOT NULL AS consumed FROM email_verification_tokens WHERE user_id = ANY($1)',
      [[pendingEmail, student]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.consumed]))).toEqual({ [pendingEmail]: true, [student]: false });
  });
});

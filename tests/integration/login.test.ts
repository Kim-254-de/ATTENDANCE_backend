import fs from 'node:fs';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Sign-in, /me, refresh and logout against a real Postgres database.
 * A throwaway database is created from the credentials in .env and dropped afterwards.
 */
const TEST_DB = 'attendance_login_test';
const PASSWORD = 'Sup3rSecretPw9x';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let hash: string;

interface Body { data?: Record<string, unknown>; error?: { code: string; message: string } }
const body = (res: request.Response): Body => res.body as Body;

const uniq = (() => { let n = 0; return () => ++n; })();

/** Inserts a lecturer directly, bypassing registration and the ERP. */
async function makeLecturer(status: string, opts: { staff?: string; email?: string; locked?: boolean } = {}) {
  const n = uniq();
  const staff = opts.staff ?? `STF/T${n}`;
  const email = opts.email ?? `lecturer${n}@uni.ac.ke`;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1,$2,'Test Lecturer','LECTURER',$3, NOW()) RETURNING id`, [email, hash, status]);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, title, department, erp_verified_at) VALUES ($1,$2,'Dr.','Computer Science', NOW())`,
    [u!.id, staff]);
  return { id: u!.id, staff, email };
}

const login = (identifier: string, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ identifier, password });
const cookiesOf = (res: request.Response) => (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.LOGIN_MAX_FAILED_ATTEMPTS = '3';
  process.env.LOGIN_LOCKOUT_MINUTES = '15';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  hash = await (await import('../../src/common/utils/password.js')).hashPassword(PASSWORD);
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

beforeEach(async () => { await pool.query('DELETE FROM auth_sessions'); });

describe('POST /auth/login', () => {
  it('signs in with a staff number (any case) and sets httpOnly cookies', async () => {
    const l = await makeLecturer('ACTIVE');
    const res = await login(l.staff.toLowerCase());
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({ id: l.id, role: 'lecturer', staffNumber: l.staff, title: 'Dr.', department: 'Computer Science' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|token/i);
    const cookies = cookiesOf(res);
    expect(cookies.some((c) => c.startsWith('sa_access=') && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith('sa_refresh=') && /HttpOnly/i.test(c) && /Path=\/api\/v1\/auth/i.test(c))).toBe(true);
  });

  it('signs in with an email (any case)', async () => {
    const l = await makeLecturer('ACTIVE');
    expect((await login(l.email.toUpperCase())).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const l = await makeLecturer('ACTIVE');
    const wrong = await login(l.staff, 'not-the-password');
    const unknown = await login('STF/NOPE');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(body(wrong).error).toEqual(body(unknown).error);
    expect(body(wrong).error?.code).toBe('INVALID_CREDENTIALS');
  });

  it.each([
    ['PENDING_VERIFICATION', /confirm your email/i],
    ['PENDING_APPROVAL', /administrator approval/i],
    ['SUSPENDED', /suspended/i],
    ['DEACTIVATED', /deactivated/i],
  ])('refuses a %s account with the right password', async (status, message) => {
    const l = await makeLecturer(status);
    const res = await login(l.staff);
    expect(res.status).toBe(403);
    expect(body(res).error?.code).toBe('ACCOUNT_NOT_ACTIVE');
    expect(body(res).error?.message).toMatch(message);
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it('does not reveal account status to someone with the wrong password', async () => {
    const l = await makeLecturer('SUSPENDED');
    const res = await login(l.staff, 'wrong-password');
    expect(res.status).toBe(401);
  });

  it('locks the account after repeated failures, even for the right password, then unlocks', async () => {
    const l = await makeLecturer('ACTIVE');
    for (let i = 0; i < 3; i += 1) expect((await login(l.staff, 'wrong')).status).toBe(401);
    const locked = await login(l.staff); // correct password, but locked
    expect(locked.status).toBe(429);
    expect(body(locked).error?.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    await pool.query(`UPDATE users SET locked_until = NOW() - interval '1 second' WHERE id = $1`, [l.id]);
    expect((await login(l.staff)).status).toBe(200);
    const { rows: [u] } = await pool.query<{ failed_login_attempts: number; locked_until: Date | null }>('SELECT failed_login_attempts, locked_until FROM users WHERE id = $1', [l.id]);
    expect(u).toMatchObject({ failed_login_attempts: 0, locked_until: null });
  });

  it('after a lock expires, a single mistake does not immediately re-lock', async () => {
    const l = await makeLecturer('ACTIVE');
    for (let i = 0; i < 3; i += 1) await login(l.staff, 'wrong');
    await pool.query(`UPDATE users SET locked_until = NOW() - interval '1 second' WHERE id = $1`, [l.id]);
    expect((await login(l.staff, 'wrong')).status).toBe(401);
    expect((await login(l.staff)).status).toBe(200);
  });

  it('a successful sign-in resets the failure counter', async () => {
    const l = await makeLecturer('ACTIVE');
    await login(l.staff, 'wrong'); await login(l.staff, 'wrong');
    expect((await login(l.staff)).status).toBe(200);
    for (let i = 0; i < 2; i += 1) await login(l.staff, 'wrong');
    expect((await login(l.staff)).status).toBe(200); // 2 fresh failures, still under the limit of 3
  });

  it('rejects malformed bodies and unknown fields', async () => {
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: '', password: '' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/login').send({ identifier: 'a', password: 'b', role: 'ADMIN' })).status).toBe(400);
  });

  it('records successes and failures in the audit log', async () => {
    const l = await makeLecturer('ACTIVE');
    await login(l.staff, 'wrong'); await login(l.staff);
    const { rows } = await pool.query<{ action: string; outcome: string }>(`SELECT action, outcome FROM audit_logs WHERE user_id = $1 AND action LIKE 'LOGIN_%' ORDER BY created_at`, [l.id]);
    expect(rows).toEqual([{ action: 'LOGIN_FAILED', outcome: 'FAILURE' }, { action: 'LOGIN_SUCCEEDED', outcome: 'SUCCESS' }]);
  });
});

describe('session lifecycle', () => {
  it('GET /me returns the lecturer while signed in, 401 otherwise', async () => {
    const l = await makeLecturer('ACTIVE');
    const agent = request.agent(app);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    await agent.post('/api/v1/auth/login').send({ identifier: l.staff, password: PASSWORD }).expect(200);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(body(me).data?.staffNumber).toBe(l.staff);
  });

  it('GET /lecturers/profile returns the active registration details', async () => {
    const l = await makeLecturer('ACTIVE');
    await pool.query(`UPDATE lecturer_profiles SET faculty = 'Science', phone = '+254700000000' WHERE user_id = $1`, [l.id]);
    const agent = request.agent(app);

    expect((await agent.get('/api/v1/lecturers/profile')).status).toBe(401);
    await agent.post('/api/v1/auth/login').send({ identifier: l.staff, password: PASSWORD }).expect(200);

    const profile = await agent.get('/api/v1/lecturers/profile');
    expect(profile.status).toBe(200);
    expect(body(profile).data).toMatchObject({
      id: l.id,
      role: 'lecturer',
      fullName: 'Test Lecturer',
      email: l.email,
      staffNumber: l.staff,
      department: 'Computer Science',
      faculty: 'Science',
      phone: '+254700000000',
    });
    expect(body(profile).data).not.toHaveProperty('passwordHash');
  });

  it('rejects a tampered or foreign token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('logout ends the session server-side: the old access token stops working immediately', async () => {
    const l = await makeLecturer('ACTIVE');
    const agent = request.agent(app);
    const signedIn = await agent.post('/api/v1/auth/login').send({ identifier: l.staff, password: PASSWORD });
    const access = cookiesOf(signedIn).find((c) => c.startsWith('sa_access='))!.split(';')[0]!.slice('sa_access='.length);

    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    // Even a copy of the token taken before logout is dead:
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${access}`)).status).toBe(401);
  });

  it('logout without a session is harmless', async () => {
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
  });

  it('suspending an account cuts off an already signed-in session', async () => {
    const l = await makeLecturer('ACTIVE');
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ identifier: l.staff, password: PASSWORD }).expect(200);
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [l.id]);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(403);
  });

  it('refresh rotates tokens; replaying the old refresh token revokes the session', async () => {
    const l = await makeLecturer('ACTIVE');
    const first = await login(l.staff);
    const oldRefresh = cookiesOf(first).find((c) => c.startsWith('sa_refresh='))!.split(';')[0]!;

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', oldRefresh);
    expect(refreshed.status).toBe(204);
    const newRefresh = cookiesOf(refreshed).find((c) => c.startsWith('sa_refresh='))!.split(';')[0]!;
    const newAccess = cookiesOf(refreshed).find((c) => c.startsWith('sa_access='))!.split(';')[0]!;
    expect(newRefresh).not.toBe(oldRefresh);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', newAccess)).status).toBe(200);

    // Replay of the already-rotated token = possible theft: refused, and the whole session dies.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', oldRefresh)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', newRefresh)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', newAccess)).status).toBe(401);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'SESSION_REFRESH_REUSE_DETECTED'`);
    expect(rows[0]?.n).toBe(1);
  });

  it('refresh without or with a garbage token is 401', async () => {
    expect((await request(app).post('/api/v1/auth/refresh')).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', 'sa_refresh=garbage')).status).toBe(401);
  });

  it('an access token cannot be used as a refresh token (and vice versa)', async () => {
    const l = await makeLecturer('ACTIVE');
    const res = await login(l.staff);
    const access = cookiesOf(res).find((c) => c.startsWith('sa_access='))!.split(';')[0]!.slice('sa_access='.length);
    const refresh = cookiesOf(res).find((c) => c.startsWith('sa_refresh='))!.split(';')[0]!.slice('sa_refresh='.length);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', `sa_refresh=${access}`)).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${refresh}`)).status).toBe(401);
  });
});

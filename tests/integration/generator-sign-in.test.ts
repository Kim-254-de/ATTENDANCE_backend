import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Joined from parts so a secret scanner doesn't mistake a test fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

/**
 * The timetabling office (auth.generator.ts) against a real Postgres
 * database: an administrator invites them like any other officer, they choose
 * a password from the emailed link, and the Timetable Generator checks their
 * sign-in here. Attendance's own staff sign-in sends them to the Generator.
 */
const sent: { to: string; token: string; roleDescription: string; signIn?: { where: string; url: string | null } }[] = [];
vi.mock('../../src/modules/notification/index.js', () => ({
  notificationService: {
    sendOfficerInvitation: vi.fn((message: (typeof sent)[number]) => {
      sent.push(message);
      return Promise.resolve();
    }),
    sendPasswordReset: vi.fn(() => Promise.resolve()),
    sendPasswordChanged: vi.fn(() => Promise.resolve()),
    sendEmailVerification: vi.fn(() => Promise.resolve()),
    sendUnitVerificationRequest: vi.fn(() => Promise.resolve()),
  },
}));

const TEST_DB = 'attendance_generator_sign_in_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';
process.env.GENERATOR_API_KEY = 'generator-key';
process.env.GENERATOR_WEB_URL = 'https://generator.test.local';
const PASSWORD = fake('Director-', 'Pass', '-2026');
const EMAIL = 'director@uni.ac.ke';

let app: Express;
let pool: pg.Pool;
let adminAuth: string;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string; details?: { url?: string } } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const generator = {
  authenticate: (identifier: string, password: string, key = 'generator-key') =>
    request(app).post('/api/v1/integrations/generator/authenticate').set('X-API-Key', key).send({ identifier, password }),
  identity: (accountId: string) =>
    request(app).get(`/api/v1/integrations/generator/identity?account_id=${accountId}`).set('X-API-Key', 'generator-key'),
};

beforeAll(async () => {
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.query(`CREATE DATABASE ${TEST_DB}`);
  await pgAdmin.end();
  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ('admin@uni.ac.ke', 'x', 'Ada Admin', 'ADMIN', 'ACTIVE', NOW()) RETURNING id`);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  adminAuth = `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'ADMIN' })}`;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

describe('the timetabling office', () => {
  let userId: string;

  it('is invited by an administrator, and the email says to sign in at the Generator', async () => {
    const res = await request(app).post('/api/v1/admin/invitations').set('Authorization', adminAuth)
      .send({ role: 'timetabling', email: EMAIL, fullName: 'Dee Director' });
    expect(res.status).toBe(201);
    userId = body<{ userId: string }>(res).data.userId;
    expect(sent[0]).toMatchObject({ to: EMAIL, signIn: { where: 'the Timetable Generator', url: 'https://generator.test.local' } });
    const officers = body<Array<{ email: string; role: string; status: string }>>(await request(app).get('/api/v1/admin/officers').set('Authorization', adminAuth)).data;
    expect(officers.find((o) => o.email === EMAIL)).toMatchObject({ role: 'timetabling', status: 'PENDING_VERIFICATION' });
  });

  it('cannot sign in to the Generator before choosing a password', async () => {
    expect(body(await generator.authenticate(EMAIL, PASSWORD)).data).toEqual({ authenticated: false });
  });

  it('chooses a password from the link, then signs in at the Generator', async () => {
    const lookup = await request(app).post('/api/v1/auth/invitations/lookup').send({ token: sent[0]!.token });
    expect(body<{ role: string }>(lookup).data.role).toBe('timetabling');
    expect((await request(app).post('/api/v1/auth/invitations/accept').send({ token: sent[0]!.token, password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(200);

    expect((await generator.authenticate(EMAIL, PASSWORD, 'wrong-key')).status).toBe(401);
    expect(body(await generator.authenticate(EMAIL, 'nope')).data).toEqual({ authenticated: false });
    expect(body(await generator.authenticate(' Director@Uni.ac.ke ', PASSWORD)).data).toEqual({
      authenticated: true,
      account: { id: userId, full_name: 'Dee Director', email: EMAIL, university_id: null },
      timetabling_office: true,
    });
    expect(body(await generator.identity(userId)).data).toMatchObject({ timetabling_office: true });
  });

  it('is sent to the Generator by attendance\'s own staff sign-in', async () => {
    const wrong = await request(app).post('/api/v1/auth/login').send({ identifier: EMAIL, password: 'nope' });
    expect(wrong.status).toBe(401);
    const res = await request(app).post('/api/v1/auth/login').send({ identifier: EMAIL, password: PASSWORD });
    expect([res.status, body(res).error!.code, body(res).error!.details?.url]).toEqual([403, 'SIGN_IN_AT_GENERATOR', 'https://generator.test.local']);
  });

  it('loses the Generator when the administrator deactivates the account', async () => {
    expect((await request(app).post(`/api/v1/admin/officers/${userId}/deactivate`).set('Authorization', adminAuth)).status).toBeLessThan(300);
    expect((await generator.identity(userId)).status).toBe(404);
    expect(body(await generator.authenticate(EMAIL, PASSWORD)).data).toEqual({ authenticated: false });
  });

  it('says a correct login of another officer is not the timetabling office', async () => {
    await request(app).post('/api/v1/admin/invitations').set('Authorization', adminAuth).send({ role: 'management', email: 'm@uni.ac.ke', fullName: 'Max Manager' });
    const token = sent.at(-1)!.token;
    await request(app).post('/api/v1/auth/invitations/accept').send({ token, password: PASSWORD, confirmPassword: PASSWORD });
    expect(body(await generator.authenticate('m@uni.ac.ke', PASSWORD)).data).toMatchObject({ authenticated: true, timetabling_office: false });
  });
});

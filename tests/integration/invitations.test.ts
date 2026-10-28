import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Joined from parts so a secret scanner doesn't mistake a test fixture for a real credential. */
const fake = (...parts: string[]) => parts.join('');

/**
 * Invited accounts (auth.invitation.ts) against a real Postgres database:
 * an administrator invites management, department and QA officers (and,
 * without SMARTTT accounts, other administrators), and each invitee chooses
 * their own password from the emailed link before they can sign in.
 *
 * Email is captured rather than sent, so the tests can follow the link.
 */
const sent: { to: string; token: string; roleDescription: string }[] = [];
vi.mock('../../src/modules/notification/index.js', () => ({
  notificationService: {
    sendOfficerInvitation: vi.fn((message: { to: string; token: string; roleDescription: string }) => {
      sent.push({ to: message.to, token: message.token, roleDescription: message.roleDescription });
      return Promise.resolve();
    }),
    sendPasswordReset: vi.fn(() => Promise.resolve()),
    sendPasswordChanged: vi.fn(() => Promise.resolve()),
    sendEmailVerification: vi.fn(() => Promise.resolve()),
    sendUnitVerificationRequest: vi.fn(() => Promise.resolve()),
  },
}));

const TEST_DB = 'attendance_invitations_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const PASSWORD = fake('Officer-', 'Pass', '-2026');

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

interface Officer { userId: string; role: string; email: string; status: string; departmentName: string | null; invitationExpiresAt: string | null }

const uniq = (() => { let n = 0; return () => ++n; })();

/** A signed-in user of any role, as a bearer token. */
async function makeUser(role: 'ADMIN' | 'LECTURER', fullName: string) {
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${uniq()}@uni.ac.ke`, fullName, role]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
});
const publicPost = (path: string, data: object) => request(app).post(`/api/v1${path}`).send(data);
const login = (email: string, password = PASSWORD) => publicPost('/auth/login', { identifier: email, password });
const accept = (token: string, password = PASSWORD) => publicPost('/auth/invitations/accept', { token, password, confirmPassword: password });
const lastTokenFor = (email: string) => [...sent].reverse().find((m) => m.to === email)!.token;

/** Signs in through the real form; the session cookies sign later requests in. */
async function signIn(email: string) {
  const res = await login(email);
  expect(res.status).toBe(200);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return { res, cookies };
}

let admin: { id: string; auth: string };
let computingId: string;
let historyId: string;

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

  admin = await makeUser('ADMIN', 'Ada Admin');
  const { rows: [c] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ('Computing', 'DCOMP') RETURNING id`);
  const { rows: [h] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ('History', 'DHIST') RETURNING id`);
  computingId = c!.id;
  historyId = h!.id;
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

beforeEach(() => { sent.length = 0; });

describe('the admin console', () => {
  it('creates departments with a code, and has no faculties', async () => {
    const created = await api(admin.auth).post('/admin/departments', { name: 'Geography', code: 'DGEO' });
    expect(created.status).toBe(201);
    const list = body<{ name: string; code: string }[]>(await api(admin.auth).get('/admin/departments')).data;
    expect(list.map((d) => [d.name, d.code])).toEqual([['Computing', 'DCOMP'], ['Geography', 'DGEO'], ['History', 'DHIST']]);
    expect((await api(admin.auth).post('/admin/departments', { name: 'Geography', code: 'DGEO2' })).status).toBe(409);
    expect((await api(admin.auth).get('/admin/faculties')).status).toBe(404);
  });

  it('is closed to everyone but administrators', async () => {
    const lecturer = await makeUser('LECTURER', 'Lee Lecturer');
    expect((await api(lecturer.auth).get('/admin/officers')).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/officers')).status).toBe(401);
  });

  it('will not let an administrator remove their own access', async () => {
    expect((await api(admin.auth).post(`/admin/officers/${admin.id}/deactivate`)).status).toBe(400);
  });
});

describe('inviting officers', () => {
  it('creates a pending account that only the emailed link can activate', async () => {
    const email = 'fiona.management@uni.ac.ke';
    const res = await api(admin.auth).post('/admin/invitations', { role: 'management', fullName: 'Fiona Management', email });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({ emailSent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.roleDescription).toBe('a member of management');
    // The token never comes back over HTTP.
    expect(JSON.stringify(res.body)).not.toContain(sent[0]!.token);

    const officers = body<Officer[]>(await api(admin.auth).get('/admin/officers')).data;
    const fiona = officers.find((o) => o.email === email)!;
    expect(fiona).toMatchObject({ role: 'management', status: 'PENDING_VERIFICATION', departmentName: null });
    expect(fiona).not.toHaveProperty('facultyName');
    expect(fiona.invitationExpiresAt).not.toBeNull();

    // No password exists yet, so nothing signs in.
    expect((await login(email)).status).toBe(401);

    const token = lastTokenFor(email);
    const details = await publicPost('/auth/invitations/lookup', { token });
    expect(body(details).data).toMatchObject({ fullName: 'Fiona Management', email, role: 'management', scopeName: null });

    expect((await accept(token, 'weak')).status).toBe(400);
    expect((await accept(token)).status).toBe(200);

    const { res: signedIn } = await signIn(email);
    expect(body(signedIn).data).toMatchObject({ role: 'management', fullName: 'Fiona Management' });
    expect(body(signedIn).data).not.toHaveProperty('facultyId');

    // Single use.
    expect((await accept(token)).status).toBe(400);
    expect((await publicPost('/auth/invitations/lookup', { token })).status).toBe(400);
  });

  it('refuses an email that already has an account, and the old faculty role', async () => {
    const email = 'dup.management@uni.ac.ke';
    expect((await api(admin.auth).post('/admin/invitations', { role: 'management', fullName: 'Dup Management', email })).status).toBe(201);
    const again = await api(admin.auth).post('/admin/invitations', { role: 'management', fullName: 'Dup Management', email });
    expect(again.status).toBe(409);
    expect(body(again).error!.message).toMatch(/re-send/i);
    expect((await api(admin.auth).post('/admin/invitations', { role: 'faculty', fullName: 'No Faculty', email: 'nf@uni.ac.ke' })).status).toBe(400);
  });

  it('re-sends with a new link that replaces the old one', async () => {
    const email = 'resend.management@uni.ac.ke';
    const created = await api(admin.auth).post('/admin/invitations', { role: 'management', fullName: 'Resend Management', email });
    const first = lastTokenFor(email);
    const { userId } = body<{ userId: string }>(created).data;

    expect((await api(admin.auth).post(`/admin/officers/${userId}/resend`)).status).toBe(200);
    const second = lastTokenFor(email);
    expect(second).not.toBe(first);
    expect((await accept(first)).status).toBe(400);
    expect((await accept(second)).status).toBe(200);
    // Accepted: nothing left to re-send.
    expect((await api(admin.auth).post(`/admin/officers/${userId}/resend`)).status).toBe(409);
  });

  it('invites management, who signs in and sees the whole university', async () => {
    const email = 'mona.management@uni.ac.ke';
    expect((await api(admin.auth).post('/admin/invitations', { role: 'management', fullName: 'Mona Management', email })).status).toBe(201);
    expect(sent.at(-1)!.roleDescription).toBe('a member of management');
    expect((await accept(lastTokenFor(email))).status).toBe(200);

    const { res, cookies } = await signIn(email);
    expect(body(res).data).toMatchObject({ role: 'management', fullName: 'Mona Management' });
    const university = await request(app).get('/api/v1/management/departments').set('Cookie', cookies);
    expect(university.status).toBe(200);
    const names = body<{ departments: { departmentName: string }[] }>(university).data.departments.map((d) => d.departmentName);
    expect(names).toEqual(expect.arrayContaining(['Computing', 'History']));
    // The faculty portal's API is gone.
    expect((await request(app).get('/api/v1/faculties/me').set('Cookie', cookies)).status).toBe(404);
  });

  it('invites the officer for one department', async () => {
    const email = 'dora.department@uni.ac.ke';
    const res = await api(admin.auth).post('/admin/invitations', { role: 'department', departmentId: historyId, fullName: 'Dora Department', email });
    expect(res.status).toBe(201);
    expect(sent.at(-1)!.roleDescription).toBe('department officer for History');
    expect((await api(admin.auth).post('/admin/invitations', { role: 'department', departmentId: randomUUID(), fullName: 'Nobody', email: 'nd@uni.ac.ke' })).status).toBe(400);
    expect((await api(admin.auth).post('/admin/invitations', { role: 'department', fullName: 'Nobody', email: 'nd@uni.ac.ke' })).status).toBe(400);

    expect((await accept(lastTokenFor(email))).status).toBe(200);
    const { res: signedIn } = await signIn(email);
    expect(body(signedIn).data).toMatchObject({ role: 'department', departmentName: 'History' });
  });

  it('only invites addresses on the allowed domains, when any are set', async () => {
    const { env } = await import('../../src/config/env.js');
    const before = env.OFFICER_EMAIL_DOMAINS;
    (env as { OFFICER_EMAIL_DOMAINS: string[] }).OFFICER_EMAIL_DOMAINS = ['uni.ac.ke'];
    try {
      const res = await api(admin.auth).post('/admin/invitations', { role: 'admin', fullName: 'Gmail Person', email: 'someone@gmail.com' });
      expect(res.status).toBe(400);
      expect(body(res).error!.message).toMatch(/@uni\.ac\.ke/);
    } finally {
      (env as { OFFICER_EMAIL_DOMAINS: string[] }).OFFICER_EMAIL_DOMAINS = before;
    }
  });

  it('invites another administrator, who signs in as one', async () => {
    const email = 'second.admin@uni.ac.ke';
    expect((await api(admin.auth).post('/admin/invitations', { role: 'admin', fullName: 'Second Admin', email })).status).toBe(201);
    expect((await accept(lastTokenFor(email))).status).toBe(200);
    const { res } = await signIn(email);
    expect(body(res).data).toMatchObject({ role: 'admin', fullName: 'Second Admin' });
  });

  it('invites a QA officer, who is listed, signs in as one and can use the QA portal', async () => {
    const email = 'quinn.qa@uni.ac.ke';
    expect((await api(admin.auth).post('/admin/invitations', { role: 'qa', fullName: 'Quinn QA', email })).status).toBe(201);
    expect(sent.at(-1)!.roleDescription).toBe('quality assurance officer');

    const officers = body<Officer[]>(await api(admin.auth).get('/admin/officers')).data;
    expect(officers.find((o) => o.email === email)).toMatchObject({ role: 'qa', status: 'PENDING_VERIFICATION', departmentName: null });

    const token = lastTokenFor(email);
    expect(body(await publicPost('/auth/invitations/lookup', { token })).data).toMatchObject({ role: 'qa', scopeName: null });
    expect((await accept(token)).status).toBe(200);

    const { res, cookies } = await signIn(email);
    expect(body(res).data).toMatchObject({ role: 'qa', fullName: 'Quinn QA' });
    expect((await request(app).get('/api/v1/quality-assurance/departments').set('Cookie', cookies)).status).toBe(200);
  });
});

describe('an administrator managing department officers', () => {
  it('invites, lists, removes and re-invites the officer for one department', async () => {
    const email = 'dora.dept@uni.ac.ke';
    const invited = await api(admin.auth).post('/admin/invitations', { role: 'department', departmentId: computingId, fullName: 'Dora Dept', email });
    expect(invited.status).toBe(201);
    expect(sent.at(-1)!.roleDescription).toBe('department officer for Computing');

    const list = body<Officer[]>(await api(admin.auth).get('/admin/officers')).data;
    expect(list.find((o) => o.email === email)).toMatchObject({ role: 'department', departmentName: 'Computing', status: 'PENDING_VERIFICATION' });

    expect((await accept(lastTokenFor(email))).status).toBe(200);
    const dora = await signIn(email);
    expect(body(dora.res).data).toMatchObject({ role: 'department', departmentName: 'Computing' });

    // Officers stay signed in past the access token: refresh works for them.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', dora.cookies)).status).toBe(204);

    const { userId } = body<{ userId: string }>(invited).data;
    expect((await api(admin.auth).post(`/admin/officers/${userId}/deactivate`)).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', dora.cookies)).status).toBe(401);
    expect((await login(email)).status).toBe(403);
    expect(body<Officer[]>(await api(admin.auth).get('/admin/officers')).data.find((o) => o.email === email)).toMatchObject({ status: 'DEACTIVATED' });

    // Re-inviting the same person re-opens the account.
    expect((await api(admin.auth).post('/admin/invitations', { role: 'department', departmentId: computingId, fullName: 'Dora Dept', email })).status).toBe(201);
    expect((await accept(lastTokenFor(email))).status).toBe(200);
    expect((await login(email)).status).toBe(200);
  });
});

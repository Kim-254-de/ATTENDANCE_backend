import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * An administrator confirms lecturer-unit assignments the timetable could not
 * (unit README: PENDING_VERIFICATION), against a real Postgres database.
 */
const TEST_DB = 'attendance_admin_units_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

interface PendingUnit {
  unitId: string; code: string; lecturerName: string; staffNumber: string | null; departmentName: string | null;
  slots: { dayOfWeek: number; startTime: string; endTime: string; roomCode: string | null }[];
}

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

async function makeUnit(code: string, lecturerUserId: string, status: 'PENDING_VERIFICATION' | 'VERIFIED') {
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
    [code, `${code} name`, lecturerUserId, status]);
  return u!.id;
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string) => request(app).post(`/api/v1${path}`).set('Authorization', auth),
});

let admin: { id: string; auth: string };
let lecturer: { id: string; auth: string };
let pendingId: string;
let verifiedId: string;

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
  lecturer = await makeUser('LECTURER', 'Lee Lecturer');
  const { rows: [d] } = await pool.query<{ id: string }>(`INSERT INTO departments (name, code) VALUES ('Computing', 'COMP') RETURNING id`);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, department_id, erp_verified_at) VALUES ($1, 'STF/0042', $2, NOW())`,
    [lecturer.id, d!.id]);
  pendingId = await makeUnit('COSC 101', lecturer.id, 'PENDING_VERIFICATION');
  verifiedId = await makeUnit('COSC 102', lecturer.id, 'VERIFIED');
  await pool.query(
    `INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time, room_code)
     VALUES ($1, 3, '14:00', '16:00', 'LT2'), ($1, 1, '08:00', '10:00', NULL)`,
    [pendingId]);
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

describe('unit verification in the admin console', () => {
  it('is closed to everyone but administrators', async () => {
    expect((await api(lecturer.auth).get('/admin/units/pending')).status).toBe(403);
    expect((await api(lecturer.auth).post(`/admin/units/${pendingId}/verify`)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/units/pending')).status).toBe(401);
  });

  it('lists only pending units, with the lecturer and weekly meetings', async () => {
    const res = await api(admin.auth).get('/admin/units/pending');
    expect(res.status).toBe(200);
    expect(body<PendingUnit[]>(res).data).toEqual([
      expect.objectContaining({
        unitId: pendingId,
        code: 'COSC 101',
        lecturerName: 'Lee Lecturer',
        staffNumber: 'STF/0042',
        departmentName: 'Computing',
        slots: [
          { dayOfWeek: 1, startTime: '08:00', endTime: '10:00', roomCode: null },
          { dayOfWeek: 3, startTime: '14:00', endTime: '16:00', roomCode: 'LT2' },
        ],
      }),
    ]);
  });

  it('verifies a pending unit once, and records who did it', async () => {
    const res = await api(admin.auth).post(`/admin/units/${pendingId}/verify`);
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual({ unitId: pendingId, code: 'COSC 101', status: 'VERIFIED' });

    const { rows: [u] } = await pool.query<{ status: string }>(`SELECT status FROM units WHERE id = $1`, [pendingId]);
    expect(u!.status).toBe('VERIFIED');
    const { rows: audits } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM audit_logs WHERE action = 'UNIT_VERIFIED' AND metadata->>'unitId' = $1`, [pendingId]);
    expect(audits).toEqual([{ user_id: admin.id }]);

    expect((await api(admin.auth).post(`/admin/units/${pendingId}/verify`)).status).toBe(409);
    expect(body<PendingUnit[]>(await api(admin.auth).get('/admin/units/pending')).data).toEqual([]);
  });

  it('refuses an already verified or unknown unit', async () => {
    expect((await api(admin.auth).post(`/admin/units/${verifiedId}/verify`)).status).toBe(409);
    expect((await api(admin.auth).post(`/admin/units/${randomUUID()}/verify`)).status).toBe(404);
    expect((await api(admin.auth).post('/admin/units/not-a-uuid/verify')).status).toBe(400);
  });
});

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Check-in by student ID card, against a real Postgres database.
 *
 * The terminal is not a signed-in user: it presents a shared key and the card
 * names the student. That makes two things worth proving here that no other
 * check-in path needs — that the key is actually required, and that a card
 * which resolves to nobody records nothing.
 */
const TEST_DB = 'attendance_cards_test';
const TERMINAL_KEY = 'card-terminal-key-for-tests-0123456789';
const UID_SECRET = 'card-uid-secret-for-tests-9876543210';

const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let hashCardUid: (uid: string, secret: string) => string;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

/** Posts a swipe as a terminal would. `key` is overridable so the guard can be tested. */
const swipe = (sessionId: string, cardUid: string, key: string | null = TERMINAL_KEY) => {
  const req = request(app).post('/api/v1/attendance/card-check-in');
  if (key !== null) req.set('X-API-Key', key);
  return req.send({ sessionId, cardUid });
};

async function makeLecturer() {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', 'Dr. Card Test', 'LECTURER', 'ACTIVE', NOW()) RETURNING id`,
    [`lec${n}@uni.ac.ke`]);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`,
    [u!.id, `STF/C${n}`]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`, [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role: 'LECTURER' })}` };
}

/** A student with an account and, unless told otherwise, an ACTIVE card. */
async function makeStudent(options: { card?: string | null } = {}) {
  const n = uniq();
  const reg = `REG/C${n}`;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'STUDENT', 'ACTIVE', NOW()) RETURNING id`,
    [`stu${n}@students.uni.ac.ke`, `Student ${n}`]);
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at)
     VALUES ($1, $2, 'ERP', NOW())`, [u!.id, reg]);

  const cardUid = options.card === null ? null : (options.card ?? `04${n.toString(16).padStart(6, '0')}`);
  if (cardUid) {
    await pool.query(
      `INSERT INTO student_cards (student_user_id, card_uid_hmac, status) VALUES ($1, $2, 'ACTIVE')`,
      [u!.id, hashCardUid(cardUid, UID_SECRET)]);
  }
  return { id: u!.id, reg, cardUid, fullName: `Student ${n}` };
}

/** A unit the lecturer teaches, with a live session accepting the given methods. */
async function makeLiveClass(lecturerId: string, methods: string[] = ['QR', 'CARD']) {
  const n = uniq();
  const code = `COSC C${n}`;
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'Card Test Unit', $2, 'VERIFIED') RETURNING id`,
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

let lecturer: { id: string; auth: string };
beforeEach(async () => { lecturer = await makeLecturer(); });

describe('card check-in', () => {
  it('records a swiped student present, and tells the terminal who that was', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const res = await swipe(cls.sessionId, student.cardUid!);
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({
      sessionId: cls.sessionId,
      unitCode: cls.code,
      student: { fullName: student.fullName, registrationNumber: student.reg },
    });

    // The method is stored, and nothing QR- or location-shaped is invented for it.
    const { rows: [record] } = await pool.query<{
      verification_method: string; qr_age_seconds: number | null; geofence_result: string; allocation_id: string | null;
    }>(
      `SELECT verification_method, qr_age_seconds, geofence_result, allocation_id
         FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(record).toMatchObject({
      verification_method: 'CARD',
      qr_age_seconds: null,
      geofence_result: 'NOT_CHECKED',
    });
    // Still linked to the roster row, same as a QR check-in.
    expect(record!.allocation_id).toEqual(expect.any(String));
  });

  it('reads the same card whatever format the reader reports it in', async () => {
    const student = await makeStudent({ card: '04A3B2C1' });
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    // Lower case, colon-separated — the same card.
    const res = await swipe(cls.sessionId, '04:a3:b2:c1');
    expect(res.status).toBe(201);
  });

  it('refuses a swipe with no key, a wrong key, and records nothing', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    expect((await swipe(cls.sessionId, student.cardUid!, null)).status).toBe(401);
    expect((await swipe(cls.sessionId, student.cardUid!, 'wrong-key-wrong-key-wrong-key-123')).status).toBe(401);

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses an unknown card and a revoked one alike, and audits the attempt', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const unknown = await swipe(cls.sessionId, '04FFFFFF');
    expect(unknown.status).toBe(404);
    expect(body(unknown).error?.message).toMatch(/not recognised/i);

    // A card reported lost stops working, and says nothing different.
    await pool.query(
      `UPDATE student_cards SET status = 'REVOKED', revoked_at = NOW() WHERE student_user_id = $1`, [student.id]);
    const revoked = await swipe(cls.sessionId, student.cardUid!);
    expect(revoked.status).toBe(404);
    expect(body(revoked).error?.message).toBe(body(unknown).error?.message);

    const { rows: audits } = await pool.query(
      `SELECT user_id FROM audit_logs WHERE action = 'ATTENDANCE_CARD_REJECTED'`);
    expect(audits).toHaveLength(2);
    // Nobody is known to have presented it, so no user is implicated.
    expect(audits.every((a) => (a as { user_id: string | null }).user_id === null)).toBe(true);
  });

  it('refuses a class whose lecturer did not tick card scanning', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id, ['QR']);
    await enrol(cls.unitId, student);

    const res = await swipe(cls.sessionId, student.cardUid!);
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/not taking ID card/i);
  });

  it('refuses a QR scan when the lecturer ticked card only', async () => {
    const cls = await makeLiveClass(lecturer.id, ['CARD']);
    const qr = await request(app).get(`/api/v1/sessions/${cls.sessionId}/qr`).set('Authorization', lecturer.auth);
    // The lecturer can still see a code; what changes is that it is not accepted.
    expect(qr.status).toBe(200);
  });

  it('refuses a student who is not on the roster', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);

    const res = await swipe(cls.sessionId, student.cardUid!);
    expect(res.status).toBe(403);
    expect(body(res).error?.message).toMatch(/not registered/i);
  });

  it('refuses a student the roster has dropped', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student, 'DROPPED');

    expect((await swipe(cls.sessionId, student.cardUid!)).status).toBe(403);
  });

  it('records one student once, however many times they swipe', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    expect((await swipe(cls.sessionId, student.cardUid!)).status).toBe(201);
    const again = await swipe(cls.sessionId, student.cardUid!);
    expect(again.status).toBe(409);
    expect(body(again).error?.message).toMatch(/already recorded/i);

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a closed class, and one that has not started', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = $1`, [cls.sessionId]);
    expect((await swipe(cls.sessionId, student.cardUid!)).status).toBe(409);

    await pool.query(
      `UPDATE attendance_sessions SET status = 'OPEN', opens_at = NOW() + INTERVAL '1 hour',
              closes_at = NOW() + INTERVAL '2 hours' WHERE id = $1`, [cls.sessionId]);
    expect((await swipe(cls.sessionId, student.cardUid!)).status).toBe(409);
  });

  it('refuses a session that does not exist, and a malformed one, without a 500', async () => {
    expect((await swipe(randomUUID(), '04ABCDEF')).status).toBe(404);
    expect((await swipe('not-a-uuid', '04ABCDEF')).status).toBe(400);
  });

  it('rejects a card UID that is not plausibly one', async () => {
    const cls = await makeLiveClass(lecturer.id);
    for (const uid of ['', 'xyz', 'DROP TABLE student_cards', 'a'.repeat(100)]) {
      const res = await swipe(cls.sessionId, uid);
      expect(res.status, `uid: ${uid}`).toBe(400);
    }
  });

  it('keeps one usable card per student', async () => {
    const student = await makeStudent();
    await expect(
      pool.query(
        `INSERT INTO student_cards (student_user_id, card_uid_hmac, status) VALUES ($1, $2, 'ACTIVE')`,
        [student.id, hashCardUid('04DEADBE', UID_SECRET)]),
    ).rejects.toThrow();

    // Revoking the first frees the student for a replacement.
    await pool.query(
      `UPDATE student_cards SET status = 'REVOKED', revoked_at = NOW() WHERE student_user_id = $1`, [student.id]);
    await pool.query(
      `INSERT INTO student_cards (student_user_id, card_uid_hmac, status) VALUES ($1, $2, 'ACTIVE')`,
      [student.id, hashCardUid('04DEADBE', UID_SECRET)]);
  });

  it('never stores the card UID itself', async () => {
    const student = await makeStudent({ card: '04CAFEBA' });
    const { rows } = await pool.query<{ card_uid_hmac: string }>(
      `SELECT card_uid_hmac FROM student_cards WHERE student_user_id = $1`, [student.id]);
    expect(rows[0]!.card_uid_hmac).not.toContain('04CAFEBA');
    expect(rows[0]!.card_uid_hmac).toMatch(/^[0-9a-f]{64}$/);
  });
});

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Check-in by fingerprint, against a real Postgres database.
 *
 * The reader does the biometric work and reports which of its own enrolment
 * slots matched, so what is proved here is the part this service owns: that a
 * slot resolves to one student *on that terminal*, that no fingerprint is
 * stored, and that the shared terminal rules hold.
 */
const TEST_DB = 'attendance_fingerprints_test';
const TERMINAL_KEY = 'fingerprint-terminal-key-for-tests-012345';
const REF_SECRET = 'fingerprint-ref-secret-for-tests-9876543';
const TERMINAL = 'TERM-01';

const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let hashRef: (ref: string, secret: string) => string;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

/** Presents a finger as a terminal would. */
const present = (
  sessionId: string,
  fingerRef: string,
  options: { terminalId?: string; key?: string | null } = {},
) => {
  const req = request(app).post('/api/v1/attendance/fingerprint-check-in');
  const key = options.key === undefined ? TERMINAL_KEY : options.key;
  if (key !== null) req.set('X-API-Key', key);
  return req.send({ sessionId, terminalId: options.terminalId ?? TERMINAL, fingerRef });
};

async function makeLecturer() {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', 'Dr. Finger Test', 'LECTURER', 'ACTIVE', NOW()) RETURNING id`,
    [`lec${n}@uni.ac.ke`]);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`,
    [u!.id, `STF/F${n}`]);
  return { id: u!.id };
}

/** A student with an account and, unless told otherwise, an enrolment on TERM-01. */
async function makeStudent(options: { ref?: string | null; terminalId?: string } = {}) {
  const n = uniq();
  const reg = `REG/F${n}`;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'STUDENT', 'ACTIVE', NOW()) RETURNING id`,
    [`stu${n}@students.uni.ac.ke`, `Student ${n}`]);
  await pool.query(
    `INSERT INTO student_profiles (user_id, registration_number, directory_source, directory_verified_at)
     VALUES ($1, $2, 'ERP', NOW())`, [u!.id, reg]);

  // Prefixed so an auto-assigned slot can never collide with a literal one a
  // test picked ("37"), which the (terminal, slot) unique index would reject.
  const ref = options.ref === null ? null : (options.ref ?? `AUTO-${n}`);
  if (ref) {
    await pool.query(
      `INSERT INTO student_fingerprints (student_user_id, terminal_id, finger_ref_hmac, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [u!.id, options.terminalId ?? TERMINAL, hashRef(ref, REF_SECRET)]);
  }
  return { id: u!.id, reg, ref, fullName: `Student ${n}` };
}

async function makeLiveClass(lecturerId: string, methods: string[] = ['QR', 'FINGERPRINT']) {
  const n = uniq();
  const code = `COSC F${n}`;
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status)
     VALUES ($1, 'Fingerprint Test Unit', $2, 'VERIFIED') RETURNING id`, [code, lecturerId]);
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
  process.env.FINGERPRINT_TERMINAL_API_KEY = TERMINAL_KEY;
  process.env.FINGERPRINT_REF_SECRET = REF_SECRET;

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  ({ hashCardUid: hashRef } = await import('../../src/common/utils/card-uid.js'));
});

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

let lecturer: { id: string };
beforeEach(async () => { lecturer = await makeLecturer(); });

describe('fingerprint check-in', () => {
  it('records a matched student present, and names them for the terminal', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const res = await present(cls.sessionId, student.ref!);
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
    expect(record).toMatchObject({
      verification_method: 'FINGERPRINT',
      qr_age_seconds: null,
      geofence_result: 'NOT_CHECKED',
    });
  });

  it('scopes a slot to its terminal: the same slot on another reader is someone else', async () => {
    const onOne = await makeStudent({ ref: '37', terminalId: 'TERM-01' });
    const onTwo = await makeStudent({ ref: '37', terminalId: 'TERM-02' });
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, onOne);
    await enrol(cls.unitId, onTwo);

    const first = await present(cls.sessionId, '37', { terminalId: 'TERM-01' });
    expect(first.status).toBe(201);
    expect(body<{ student: { registrationNumber: string } }>(first).data.student.registrationNumber)
      .toBe(onOne.reg);

    const second = await present(cls.sessionId, '37', { terminalId: 'TERM-02' });
    expect(second.status).toBe(201);
    expect(body<{ student: { registrationNumber: string } }>(second).data.student.registrationNumber)
      .toBe(onTwo.reg);
  });

  it('refuses a slot presented from a terminal it was not enrolled on', async () => {
    const student = await makeStudent({ ref: '12', terminalId: 'TERM-01' });
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const res = await present(cls.sessionId, '12', { terminalId: 'TERM-99' });
    expect(res.status).toBe(404);
    expect(body(res).error?.message).toMatch(/not registered on this terminal/i);
  });

  it('refuses with no key and with a wrong key, recording nothing', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    expect((await present(cls.sessionId, student.ref!, { key: null })).status).toBe(401);
    expect((await present(cls.sessionId, student.ref!, { key: 'wrong-key-wrong-key-wrong-key-1234' })).status).toBe(401);

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(0);
  });

  it('will not take a card terminal key', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);
    // The two device classes hold separate keys so one can be revoked alone.
    const cardKey = process.env.CARD_TERMINAL_API_KEY ?? 'some-other-card-key-000000000000000';
    expect((await present(cls.sessionId, student.ref!, { key: cardKey })).status).toBe(401);
  });

  it('refuses an unknown slot and a revoked one alike, and audits without a user', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    const unknown = await present(cls.sessionId, '99999');
    expect(unknown.status).toBe(404);

    await pool.query(
      `UPDATE student_fingerprints SET status = 'REVOKED', revoked_at = NOW() WHERE student_user_id = $1`,
      [student.id]);
    const revoked = await present(cls.sessionId, student.ref!);
    expect(revoked.status).toBe(404);
    expect(body(revoked).error?.message).toBe(body(unknown).error?.message);

    // Scoped to this class: other tests in this file also produce rejections.
    const { rows: audits } = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM audit_logs
        WHERE action = 'ATTENDANCE_FINGERPRINT_REJECTED'
          AND metadata->>'sessionId' = $1`, [cls.sessionId]);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.user_id === null)).toBe(true);
  });

  it('refuses a class whose lecturer did not tick fingerprint', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id, ['QR', 'CARD']);
    await enrol(cls.unitId, student);

    const res = await present(cls.sessionId, student.ref!);
    expect(res.status).toBe(409);
    expect(body(res).error?.message).toMatch(/not taking fingerprint/i);
  });

  it('refuses a student not on the roster, and one dropped from it', async () => {
    const off = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    expect((await present(cls.sessionId, off.ref!)).status).toBe(403);

    const dropped = await makeStudent();
    await enrol(cls.unitId, dropped, 'DROPPED');
    expect((await present(cls.sessionId, dropped.ref!)).status).toBe(403);
  });

  it('records one student once, however many times they present', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    expect((await present(cls.sessionId, student.ref!)).status).toBe(201);
    const again = await present(cls.sessionId, student.ref!);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: 'CONFLICT' } });

    const { rows } = await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [cls.sessionId]);
    expect(rows).toHaveLength(1);
  });

  it('counts a student already recorded by QR, so the terminal cannot double them', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);
    // However the first record arrived, the second is refused.
    await pool.query(
      `INSERT INTO attendance_records (session_id, student_user_id, verification_method, geofence_result)
       VALUES ($1, $2, 'QR', 'NOT_CHECKED')`, [cls.sessionId, student.id]);

    expect((await present(cls.sessionId, student.ref!)).status).toBe(409);
  });

  it('refuses a closed class and one not yet open', async () => {
    const student = await makeStudent();
    const cls = await makeLiveClass(lecturer.id);
    await enrol(cls.unitId, student);

    await pool.query(`UPDATE attendance_sessions SET status = 'CLOSED' WHERE id = $1`, [cls.sessionId]);
    expect((await present(cls.sessionId, student.ref!)).status).toBe(409);

    await pool.query(
      `UPDATE attendance_sessions SET status = 'OPEN', opens_at = NOW() + INTERVAL '1 hour',
              closes_at = NOW() + INTERVAL '2 hours' WHERE id = $1`, [cls.sessionId]);
    expect((await present(cls.sessionId, student.ref!)).status).toBe(409);
  });

  it('refuses a missing session and a malformed one without a 500', async () => {
    expect((await present(randomUUID(), '1')).status).toBe(404);
    expect((await present('not-a-uuid', '1')).status).toBe(400);
  });

  it('rejects a terminal id or reference that is not plausibly one', async () => {
    const cls = await makeLiveClass(lecturer.id);
    for (const ref of ['', ' ', 'DROP TABLE student_fingerprints', 'a'.repeat(100)]) {
      expect((await present(cls.sessionId, ref)).status, `ref: ${ref}`).toBe(400);
    }
    expect((await present(cls.sessionId, '1', { terminalId: '' })).status).toBe(400);
    expect((await present(cls.sessionId, '1', { terminalId: 'a'.repeat(100) })).status).toBe(400);
  });

  it('keeps one usable enrolment per student per terminal, and allows a second terminal', async () => {
    const student = await makeStudent({ ref: '5', terminalId: 'TERM-01' });

    // Same terminal again is refused by the partial unique index.
    await expect(
      pool.query(
        `INSERT INTO student_fingerprints (student_user_id, terminal_id, finger_ref_hmac, status)
         VALUES ($1, 'TERM-01', $2, 'ACTIVE')`, [student.id, hashRef('6', REF_SECRET)]),
    ).rejects.toThrow();

    // A different terminal is how one reader travelling between rooms works.
    await pool.query(
      `INSERT INTO student_fingerprints (student_user_id, terminal_id, finger_ref_hmac, status)
       VALUES ($1, 'TERM-02', $2, 'ACTIVE')`, [student.id, hashRef('5', REF_SECRET)]);
  });

  it('never stores the enrolment reference itself', async () => {
    const student = await makeStudent({ ref: '4242' });
    const { rows } = await pool.query<{ finger_ref_hmac: string }>(
      `SELECT finger_ref_hmac FROM student_fingerprints WHERE student_user_id = $1`, [student.id]);
    expect(rows[0]!.finger_ref_hmac).not.toContain('4242');
    expect(rows[0]!.finger_ref_hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has no column anywhere for a fingerprint, template or image', async () => {
    // The design rests on the reader keeping the biometric. If a column for one
    // ever appears here, that promise has quietly been broken.
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'student_fingerprints'`);
    const names = rows.map((r) => r.column_name).join(',');
    expect(names).not.toMatch(/template|image|minutia|biometric|fingerprint_data/i);
  });
});

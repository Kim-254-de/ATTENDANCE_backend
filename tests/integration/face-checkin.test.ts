import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueMatchToken } from '../../src/modules/verification/face.token.js';

/**
 * Face check-in (docs/face-recognition.md) against a real Postgres database.
 * face-service is stubbed at the fetch boundary: each test photo is a name,
 * and the stub answers with the embedding that name stands for.
 */
const TEST_DB = 'attendance_face_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';
const FACE_URL = 'http://face.test.local';
const FACE_KEY = 'f'.repeat(40);

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string; details?: unknown } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;
const uniq = (() => { let n = 0; return () => ++n; })();

// --- The fake face-service --------------------------------------------------

const DIM = 128;
/** Person `p`'s face, photographed with a small variation `variant`: near-identical for one person, orthogonal across people. */
function faceOf(p: number, variant = 0): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[p] = 1;
  if (variant !== 0) v[64 + ((p + variant) % 64)] = 0.15;
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}
/** Halfway between two people: as like one as the other. */
function blend(a: number, b: number): number[] {
  const v = faceOf(a).map((x, i) => x + faceOf(b)[i]!);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

type FakePhoto =
  | { faceCount: number; embedding: number[]; width?: number; sharpness?: number }
  | 'NO_FACE' | 'INVALID' | 'DOWN';
const photos = new Map<string, FakePhoto>();
const faceCalls: Array<{ key: string | null }> = [];

/** A data URL whose content is just `name`, so the stub can look it up. */
function photo(name: string, result: FakePhoto): string {
  photos.set(name, result);
  return `data:image/jpeg;base64,${Buffer.from(name.padEnd(90, '~')).toString('base64')}`;
}

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.startsWith(FACE_URL)) return Promise.resolve(new Response('not stubbed', { status: 503 }));
    faceCalls.push({ key: new Headers(init?.headers).get('X-Face-Service-Key') });
    const { image } = JSON.parse(init?.body as string) as { image: string };
    const name = Buffer.from(image.split(',')[1]!, 'base64').toString().replace(/~+$/, '');
    const found = photos.get(name);
    if (!found || found === 'DOWN') return Promise.resolve(new Response('down', { status: 502 }));
    if (found === 'INVALID') {
      return Promise.resolve(Response.json({ success: false, error: { code: 'INVALID_IMAGE', message: 'bad' } }, { status: 400 }));
    }
    if (found === 'NO_FACE') return Promise.resolve(Response.json({ model: 'sface-2021dec', faceCount: 0, face: null }));
    return Promise.resolve(Response.json({
      model: 'sface-2021dec',
      faceCount: found.faceCount,
      face: {
        box: { x: 10, y: 10, width: found.width ?? 150, height: 180 },
        detectionScore: 0.92,
        sharpness: found.sharpness ?? 300,
        embedding: found.embedding,
      },
    }));
  });
}

const one = (embedding: number[]) => ({ faceCount: 1, embedding });
/** Three good enrollment photos of person `p`. */
const enrollPhotos = (p: number, tag = '') => [0, 1, 2].map((v) => photo(`enroll-${p}-${v}${tag}`, one(faceOf(p, v))));

// --- Fixtures ---------------------------------------------------------------

async function makeUser(role: 'LECTURER' | 'STUDENT') {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`face-${role.toLowerCase()}${n}@uni.ac.ke`, `${role === 'LECTURER' ? 'Dr. Face' : 'Student'} ${n}`, role]);
  if (role === 'LECTURER') {
    await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, `STF/F${n}`]);
  }
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

async function makeUnit(lecturerId: string) {
  const { rows: [unit] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, 'Face Unit', $2, 'VERIFIED') RETURNING id`,
    [`FACE ${uniq()}`, lecturerId]);
  return unit!.id;
}

async function addToUnit(unitId: string, studentId: string) {
  await pool.query(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, status, source)
     VALUES ($1, $2, $3, 'ACTIVE', 'SMARTTT')`,
    [unitId, `REG/F${uniq()}`, studentId]);
}

/** A class taking check-ins now. Without `methods`, the column default applies: QR and face. */
async function openSession(unitId: string, lecturerId: string, status = 'OPEN', methods?: string[]) {
  const { generateSessionSecret } = await import('../../src/modules/session/session.token.js');
  const { rows: [s] } = await pool.query<{ id: string; qr_secret: string }>(
    `INSERT INTO attendance_sessions (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '1 hour', 60) RETURNING id, qr_secret`,
    [unitId, lecturerId, generateSessionSecret(), status]);
  if (methods) await pool.query(`UPDATE attendance_sessions SET verification_methods = $2 WHERE id = $1`, [s!.id, methods]);
  return { id: s!.id, secret: s!.qr_secret };
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
  put: (path: string) => request(app).put(`/api/v1${path}`).set('Authorization', auth),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

/** A class with a lecturer and `count` students who have consented, ready to enroll. */
async function classroom(count: number) {
  const lecturer = await makeUser('LECTURER');
  const unitId = await makeUnit(lecturer.id);
  const students = [];
  for (let i = 0; i < count; i++) {
    const s = await makeUser('STUDENT');
    await addToUnit(unitId, s.id);
    await api(s.auth).put('/students/me/face-consent').expect(200);
    students.push(s);
  }
  return { lecturer, unitId, students, session: await openSession(unitId, lecturer.id) };
}

/** Each test's people get their own face numbers, so enrollments never clash across tests. */
const nextPerson = (() => { let p = 0; return () => p++ % 60; })();

function enroll(c: { lecturer: { auth: string }; unitId: string }, student: { id: string }, person: number) {
  return api(c.lecturer.auth).post(`/units/${c.unitId}/students/${student.id}/face`, { images: enrollPhotos(person) });
}

// --- Setup ------------------------------------------------------------------

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();
  process.env.SMARTTT_BASE_URL = '';
  process.env.ERP_MAX_RETRIES = '0';
  process.env.FACE_SERVICE_URL = FACE_URL;
  process.env.FACE_SERVICE_KEY = FACE_KEY;

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
});

beforeEach(stubFetch);
afterEach(() => { vi.restoreAllMocks(); faceCalls.length = 0; });

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

const audits = async (action: string) =>
  (await pool.query<{ outcome: string; user_id: string; reason: string | null; metadata: Record<string, unknown> }>(
    `SELECT outcome, user_id, reason, metadata FROM audit_logs WHERE action = $1 ORDER BY created_at`, [action])).rows;

// --- Consent ----------------------------------------------------------------

describe('consent', () => {
  it('starts off, can be given, and is audited once', async () => {
    const student = await makeUser('STUDENT');
    expect(body(await api(student.auth).get('/students/me/face').expect(200)).data)
      .toEqual({ consentGiven: false, consentedAt: null, enrolled: false, enrolledAt: null });

    const first = body<{ consentGiven: boolean; consentedAt: string }>(await api(student.auth).put('/students/me/face-consent').expect(200)).data;
    expect(first.consentGiven).toBe(true);
    const again = body<{ consentedAt: string }>(await api(student.auth).put('/students/me/face-consent').expect(200)).data;
    expect(again.consentedAt).toBe(first.consentedAt);

    expect((await audits('FACE_CONSENT_GIVEN')).filter((a) => a.user_id === student.id)).toHaveLength(1);
  });

  it('is for students only', async () => {
    const lecturer = await makeUser('LECTURER');
    await api(lecturer.auth).put('/students/me/face-consent').expect(403);
    await api(lecturer.auth).get('/students/me/face').expect(403);
  });

  it('withdrawing it deletes the face, and the student can no longer be matched', async () => {
    const c = await classroom(1);
    const [student] = c.students;
    const person = nextPerson();
    await enroll(c, student!, person).expect(201);
    const match = body<{ matchToken: string }>(await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`w-${person}`, one(faceOf(person, 5))) }).expect(200)).data;

    const status = body(await api(student!.auth).delete('/students/me/face-consent').expect(200)).data;
    expect(status).toMatchObject({ consentGiven: false, enrolled: false });
    expect((await pool.query(`SELECT 1 FROM face_enrollments WHERE student_user_id = $1`, [student!.id])).rowCount).toBe(0);

    // A match made a moment before the withdrawal can no longer be confirmed.
    await api(c.lecturer.auth).post(`/sessions/${c.session.id}/face/confirm`, { matchToken: match.matchToken }).expect(403);
    const after = body(await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`w2-${person}`, one(faceOf(person, 5))) }).expect(200)).data;
    expect(after).toMatchObject({ result: 'NO_MATCH', enrolledOnUnit: 0 });
  });
});

// --- Enrollment -------------------------------------------------------------

describe('enrollment', () => {
  it('stores three templates, sends the service key, and shows on the roster', async () => {
    const c = await classroom(1);
    const [student] = c.students;
    const res = await enroll(c, student!, nextPerson()).expect(201);
    expect(body(res).data).toMatchObject({ studentUserId: student!.id, replaced: false });
    expect(faceCalls).toHaveLength(3);
    expect(faceCalls.every((call) => call.key === FACE_KEY)).toBe(true);

    const { rows: [row] } = await pool.query<{ model: string; embeddings: number[][] }>(
      `SELECT model, embeddings FROM face_enrollments WHERE student_user_id = $1`, [student!.id]);
    expect(row!.model).toBe('sface-2021dec');
    expect(row!.embeddings).toHaveLength(3);

    const roster = body<Array<{ studentUserId: string; faceConsent: boolean; faceEnrolled: boolean }>>(
      await api(c.lecturer.auth).get(`/units/${c.unitId}/students`).expect(200)).data;
    expect(roster.find((r) => r.studentUserId === student!.id)).toMatchObject({ faceConsent: true, faceEnrolled: true });
    expect((await audits('FACE_ENROLLED')).at(-1)).toMatchObject({ outcome: 'SUCCESS', user_id: c.lecturer.id });
  });

  it('re-enrolling replaces the old templates', async () => {
    const c = await classroom(1);
    const person = nextPerson();
    await enroll(c, c.students[0]!, person).expect(201);
    const again = await api(c.lecturer.auth)
      .post(`/units/${c.unitId}/students/${c.students[0]!.id}/face`, { images: enrollPhotos(person, '-again') }).expect(201);
    expect(body(again).data).toMatchObject({ replaced: true });
  });

  it('needs the student to have consented', async () => {
    const lecturer = await makeUser('LECTURER');
    const unitId = await makeUnit(lecturer.id);
    const student = await makeUser('STUDENT');
    await addToUnit(unitId, student.id);
    const res = await enroll({ lecturer, unitId }, student, nextPerson()).expect(409);
    expect(body(res).error?.code).toBe('FACE_CONSENT_REQUIRED');
    expect(faceCalls).toHaveLength(0);
  });

  it("is refused on another lecturer's unit, or for a student not on the unit", async () => {
    const c = await classroom(1);
    const stranger = await makeUser('LECTURER');
    await api(stranger.auth).post(`/units/${c.unitId}/students/${c.students[0]!.id}/face`, { images: enrollPhotos(nextPerson()) }).expect(403);
    const outsider = await makeUser('STUDENT');
    await api(outsider.auth).put('/students/me/face-consent').expect(200);
    await enroll(c, outsider, nextPerson()).expect(404);
    await api(c.lecturer.auth).post(`/units/${randomUUID()}/students/${c.students[0]!.id}/face`, { images: enrollPhotos(nextPerson()) }).expect(404);
  });

  it('refuses a photo with two faces, and says which one', async () => {
    const c = await classroom(1);
    const p = nextPerson();
    const images = [photo(`m-${p}-0`, one(faceOf(p))), photo(`m-${p}-1`, { faceCount: 2, embedding: faceOf(p, 1) }), photo(`m-${p}-2`, one(faceOf(p, 2)))];
    const res = await api(c.lecturer.auth).post(`/units/${c.unitId}/students/${c.students[0]!.id}/face`, { images }).expect(422);
    expect(body(res).error).toMatchObject({ code: 'FACE_MULTIPLE', details: { photo: 2 } });
  });

  it("refuses photos that aren't all the same person", async () => {
    const c = await classroom(1);
    const [a, b] = [nextPerson(), nextPerson()];
    const images = [photo(`i-${a}-0`, one(faceOf(a))), photo(`i-${a}-1`, one(faceOf(a, 1))), photo(`i-${b}-0`, one(faceOf(b)))];
    const res = await api(c.lecturer.auth).post(`/units/${c.unitId}/students/${c.students[0]!.id}/face`, { images }).expect(422);
    expect(body(res).error?.code).toBe('FACE_PHOTOS_INCONSISTENT');
    expect((await audits('FACE_ENROLLMENT_REJECTED')).at(-1)).toMatchObject({ reason: 'PHOTOS_INCONSISTENT' });
  });

  it("refuses a face already enrolled as another student, without naming them", async () => {
    const c = await classroom(2);
    const person = nextPerson();
    await enroll(c, c.students[0]!, person).expect(201);
    const res = await api(c.lecturer.auth)
      .post(`/units/${c.unitId}/students/${c.students[1]!.id}/face`, { images: enrollPhotos(person, '-twin') }).expect(409);
    expect(body(res).error?.code).toBe('FACE_MATCHES_ANOTHER_STUDENT');
    expect(JSON.stringify(body(res))).not.toContain(c.students[0]!.id);
    expect((await audits('FACE_ENROLLMENT_REJECTED')).at(-1)?.metadata).toMatchObject({ otherStudentUserId: c.students[0]!.id });
  });

  it('can be removed by the lecturer', async () => {
    const c = await classroom(1);
    await enroll(c, c.students[0]!, nextPerson()).expect(201);
    expect(body(await api(c.lecturer.auth).delete(`/units/${c.unitId}/students/${c.students[0]!.id}/face`).expect(200)).data)
      .toEqual({ removed: true });
    expect(body(await api(c.students[0]!.auth).get('/students/me/face').expect(200)).data)
      .toMatchObject({ consentGiven: true, enrolled: false });
  });

  it('validates the photos', async () => {
    const c = await classroom(1);
    const path = `/units/${c.unitId}/students/${c.students[0]!.id}/face`;
    await api(c.lecturer.auth).post(path, { images: enrollPhotos(nextPerson()).slice(0, 2) }).expect(400);
    await api(c.lecturer.auth).post(path, { images: ['not an image', 'x', 'y'] }).expect(400);
    await api(c.students[0]!.auth).post(path, { images: enrollPhotos(nextPerson()) }).expect(403);
  });
});

// --- The terminal -----------------------------------------------------------

describe('identify and confirm', () => {
  it('matches, confirms, and records the student as FACE', async () => {
    const c = await classroom(3);
    const people = c.students.map(() => nextPerson());
    for (const [i, s] of c.students.entries()) await enroll(c, s, people[i]!).expect(201);

    // The student at the terminal, with someone queuing behind them.
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`t-${people[1]}`, { faceCount: 2, embedding: faceOf(people[1]!, 7) }) })
      .expect(200);
    const match = body<{ result: string; student: { studentUserId: string; fullName: string }; matchToken: string; alreadyCheckedIn: boolean; score: number }>(res).data;
    expect(match).toMatchObject({ result: 'MATCH', alreadyCheckedIn: false, facesInFrame: 2, enrolledOnUnit: 3 });
    expect(match.student.studentUserId).toBe(c.students[1]!.id);
    expect(match.score).toBeGreaterThan(0.9);

    // Nothing is recorded until the lecturer confirms.
    expect((await pool.query(`SELECT 1 FROM attendance_records WHERE session_id = $1`, [c.session.id])).rowCount).toBe(0);

    const confirmed = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/confirm`, { matchToken: match.matchToken }).expect(201);
    expect(body(confirmed).data).toMatchObject({ studentUserId: c.students[1]!.id, fullName: match.student.fullName });

    const { rows: [record] } = await pool.query<{ verification_method: string; face_score: number; confirmed_by_user_id: string; geofence_result: string }>(
      `SELECT verification_method, face_score, confirmed_by_user_id, geofence_result FROM attendance_records WHERE session_id = $1`, [c.session.id]);
    expect(record).toMatchObject({ verification_method: 'FACE', confirmed_by_user_id: c.lecturer.id, geofence_result: 'NOT_CHECKED' });
    expect(record!.face_score).toBeCloseTo(match.score, 3);

    const list = body<{ attendees: Array<{ studentUserId: string; verificationMethod: string }> }>(
      await api(c.lecturer.auth).get(`/attendance/sessions/${c.session.id}`).expect(200)).data;
    expect(list.attendees).toEqual([expect.objectContaining({ studentUserId: c.students[1]!.id, verificationMethod: 'FACE' })]);

    // Confirming the same match again is the one-record rule, like a double scan.
    await api(c.lecturer.auth).post(`/sessions/${c.session.id}/face/confirm`, { matchToken: match.matchToken }).expect(409);
  });

  it('QR and face are each the other\'s fallback, never both', async () => {
    const c = await classroom(2);
    const [byFace, byQr] = c.students;
    const [pFace, pQr] = [nextPerson(), nextPerson()];
    await enroll(c, byFace!, pFace).expect(201);
    await enroll(c, byQr!, pQr).expect(201);

    // Face first, then the student tries the QR code.
    const match = body<{ matchToken: string }>(await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`f-${pFace}`, one(faceOf(pFace, 3))) }).expect(200)).data;
    await api(c.lecturer.auth).post(`/sessions/${c.session.id}/face/confirm`, { matchToken: match.matchToken }).expect(201);
    const { payload } = body<{ payload: string }>(await api(c.lecturer.auth).get(`/sessions/${c.session.id}/qr`).expect(200)).data;
    const qr = await api(byFace!.auth).post('/attendance/check-in', { payload }).expect(409);
    expect(body(qr).error?.message).toMatch(/already been recorded/);

    // QR first, then the student goes to the terminal.
    await api(byQr!.auth).post('/attendance/check-in', { payload }).expect(201);
    const second = body<{ alreadyCheckedIn: boolean; matchToken: string | null }>(await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`q-${pQr}`, one(faceOf(pQr, 3))) }).expect(200)).data;
    expect(second).toMatchObject({ result: 'MATCH', alreadyCheckedIn: true, matchToken: null });
  });

  it('matches nobody for a face not enrolled on the unit, and audits it', async () => {
    const c = await classroom(1);
    await enroll(c, c.students[0]!, nextPerson()).expect(201);
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`u-${c.session.id}`, one(faceOf(nextPerson()))) }).expect(200);
    expect(body(res).data).toEqual({ result: 'NO_MATCH', facesInFrame: 1, enrolledOnUnit: 1 });
    expect((await audits('ATTENDANCE_FACE_NOT_MATCHED')).at(-1)).toMatchObject({ reason: 'NO_MATCH', user_id: c.lecturer.id });
  });

  it("never matches a student enrolled on another unit", async () => {
    const other = await classroom(1);
    const person = nextPerson();
    await enroll(other, other.students[0]!, person).expect(201);
    const c = await classroom(0);
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`x-${person}`, one(faceOf(person, 2))) }).expect(200);
    expect(body(res).data).toMatchObject({ result: 'NO_MATCH', enrolledOnUnit: 0 });
  });

  it('will not guess between two students who score alike', async () => {
    const c = await classroom(2);
    const [a, b] = [nextPerson(), nextPerson()];
    await enroll(c, c.students[0]!, a).expect(201);
    await enroll(c, c.students[1]!, b).expect(201);
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`b-${a}-${b}`, one(blend(a, b))) }).expect(200);
    expect(body(res).data).toMatchObject({ result: 'AMBIGUOUS' });
  });

  it.each([
    ['NO_FACE', 'FACE_NOT_FOUND'],
    [{ faceCount: 1, embedding: faceOf(1), width: 40 }, 'FACE_POOR_QUALITY'],
    [{ faceCount: 1, embedding: faceOf(1), sharpness: 5 }, 'FACE_POOR_QUALITY'],
    ['INVALID', 'FACE_IMAGE_INVALID'],
  ] as const)('asks for a retake when the photo is unusable (%j)', async (result, code) => {
    const c = await classroom(0);
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`bad-${uniq()}`, result) }).expect(422);
    expect(body(res).error?.code).toBe(code);
  });

  it('answers 503 when face-service is down, so the class can fall back to QR', async () => {
    const c = await classroom(0);
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${c.session.id}/face/identify`, { image: photo(`down-${uniq()}`, 'DOWN') }).expect(503);
    expect(body(res).error?.code).toBe('FACE_RECOGNITION_UNAVAILABLE');
  });

  it("is refused on another lecturer's session, a paused session, and for students", async () => {
    const c = await classroom(1);
    const image = photo(`r-${uniq()}`, one(faceOf(nextPerson())));
    const stranger = await makeUser('LECTURER');
    await api(stranger.auth).post(`/sessions/${c.session.id}/face/identify`, { image }).expect(403);
    await api(c.students[0]!.auth).post(`/sessions/${c.session.id}/face/identify`, { image }).expect(403);
    const paused = await openSession(c.unitId, c.lecturer.id, 'PAUSED');
    await api(c.lecturer.auth).post(`/sessions/${paused.id}/face/identify`, { image }).expect(409);
    expect(faceCalls).toHaveLength(0);
  });

  it("is refused in a class whose lecturer didn't tick face, and a class gets QR and face by default", async () => {
    const c = await classroom(1);
    await enroll(c, c.students[0]!, nextPerson()).expect(201);
    const { rows: [byDefault] } = await pool.query<{ verification_methods: string[] }>(
      `SELECT verification_methods FROM attendance_sessions WHERE id = $1`, [c.session.id]);
    expect(byDefault!.verification_methods).toEqual(['QR', 'FACE']);

    const qrOnly = await openSession(c.unitId, c.lecturer.id, 'OPEN', ['QR']);
    const callsBefore = faceCalls.length;
    const res = await api(c.lecturer.auth)
      .post(`/sessions/${qrOnly.id}/face/identify`, { image: photo(`qr-only-${uniq()}`, one(faceOf(nextPerson()))) }).expect(409);
    expect(body(res).error?.message).toBe('This class is not taking face check-ins.');
    expect(faceCalls).toHaveLength(callsBefore); // refused before the photo reaches face-service
  });

  it('confirms only a genuine, current match for this session', async () => {
    const c = await classroom(1);
    const student = c.students[0]!;
    await enroll(c, student, nextPerson()).expect(201);
    const confirm = (matchToken: string, sessionId = c.session.id) =>
      api(c.lecturer.auth).post(`/sessions/${sessionId}/face/confirm`, { matchToken });

    const expired = issueMatchToken({ sessionId: c.session.id, studentUserId: student.id, score: 0.9 }, c.session.secret, 60, new Date(Date.now() - 120_000));
    expect(body(await confirm(expired.token).expect(410)).error?.code).toBe('FACE_MATCH_EXPIRED');

    const forged = issueMatchToken({ sessionId: c.session.id, studentUserId: student.id, score: 0.9 }, 'b3RoZXItc2VjcmV0', 60);
    await confirm(forged.token).expect(400);

    // A real token from another session of the same lecturer.
    const otherSession = await openSession(c.unitId, c.lecturer.id);
    const elsewhere = issueMatchToken({ sessionId: otherSession.id, studentUserId: student.id, score: 0.9 }, otherSession.secret, 60);
    await confirm(elsewhere.token).expect(400);

    expect((await pool.query(`SELECT 1 FROM attendance_records WHERE student_user_id = $1`, [student.id])).rowCount).toBe(0);
  });
});

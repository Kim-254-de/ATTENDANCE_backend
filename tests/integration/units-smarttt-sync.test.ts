import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /units pulling a lecturer's units and registered-student counts from
 * SMARTTT (the timetable system), against a real Postgres database, with
 * SMARTTT (and the ERP, for the one lecturer-added unit) stubbed at fetch.
 */
const TEST_DB = 'attendance_smarttt_sync_test';
const SMARTTT = 'https://smarttt.test.local';
const KEY = 'smarttt-test-key';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;
let resetTimetableSyncState: () => void;
let linkAllocationsToStudent: (userId: string, reg: string) => Promise<number>;

interface UnitBody {
  id: string; code: string; name: string | null; status: string; studentCount: number;
  baseCode: string | null; group: string | null; studentsWithoutGroup: number | null;
  registeredStudents: number | null; timetableSyncedAt: string | null;
  schedule: { dayOfWeek: number; startTime: string; endTime: string } | null;
}
const units = (res: request.Response) => (res.body as { data: UnitBody[] }).data;
const byCode = (res: request.Response) => Object.fromEntries(units(res).map((u) => [u.code, u]));

const uniq = (() => { let n = 0; return () => ++n; })();

async function makeLecturer() {
  const n = uniq();
  const staffNumber = `STF/S${n}`;
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, 'LECTURER', 'ACTIVE', NOW()) RETURNING id`,
    [`lec${n}@uni.ac.ke`, `Dr. Lecturer ${n}`]);
  await pool.query(`INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at) VALUES ($1, $2, NOW())`, [u!.id, staffNumber]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  const token = await signAccessToken({ userId: u!.id, sessionId, role: 'LECTURER' });
  return { id: u!.id, auth: `Bearer ${token}`, staffNumber };
}

type SmartttAnswer = { units: unknown[] } | 'DOWN' | 'FORBIDDEN' | 'NOT_FOUND' | 'GARBAGE';
/** What SMARTTT answers per staff number. Unlisted = teaches nothing. */
let smarttt: Record<string, SmartttAnswer> = {};
let smartttCalls: URL[] = [];
let smartttHeaders: Headers[] = [];

const slot = (dayOfWeek: number, startTime = '08:00', endTime = '10:00') =>
  ({ day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, room: 'LH1', class_group: 'MAIN', program: 'BSc CS' });
type Student = { registration_number: string; full_name: string | null };
const unit = (
  code: string, registered: number, slots = [slot(1)], matchedBy: 'account' | 'name' = 'account',
  name = `${code} name`, students: Student[] = [],
) => ({ code, name, registered_students: registered, matched_by: matchedBy, slots, students });
/** One teaching group of a split unit, as SMARTTT reports it: its own class with its own lecturer and students. */
const groupUnit = (baseCode: string, group: string, registered: number, withoutGroup: number, students: Student[], slots = [slot(1)]) => ({
  ...unit(`${baseCode} ${group}`, registered, slots, 'account', 'Computer Applications', students),
  unit_code: baseCode, group, students_without_group: withoutGroup,
});
const student = (registration_number: string, full_name: string | null = `Student ${registration_number}`): Student =>
  ({ registration_number, full_name });

interface RosterRow { registrationNumber: string | null; fullName: string | null; status: string; source: string; hasAccount: boolean }
const roster = (res: request.Response) =>
  (res.body as { data: RosterRow[] }).data.map(({ registrationNumber, fullName, status, source, hasAccount }) =>
    ({ registrationNumber, fullName, status, source, hasAccount }));

function stubFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin === SMARTTT) {
      smartttCalls.push(url);
      smartttHeaders.push(new Headers(init?.headers));
      const answer = smarttt[url.searchParams.get('staff_number') ?? ''] ?? { units: [] };
      if (answer === 'DOWN') return Promise.resolve(new Response('asleep', { status: 503 }));
      if (answer === 'FORBIDDEN') return Promise.resolve(new Response('{}', { status: 403 }));
      if (answer === 'NOT_FOUND') return Promise.resolve(new Response('{}', { status: 404 }));
      if (answer === 'GARBAGE') return Promise.resolve(Response.json({ hello: 'world' }));
      return Promise.resolve(Response.json({
        staff_number: url.searchParams.get('staff_number'), lecturer_account: true,
        term: { academic_year: '2025/2026', semester: 1 }, units: answer.units,
      }));
    }
    // The ERP's issued timetable, only for POST /units in one test.
    const code = decodeURIComponent(url.pathname.split('/courses/')[1] ?? '');
    return Promise.resolve(Response.json({
      code, name: `${code} (ERP)`, staffNumber: null, dayOfWeek: 2, startTime: '11:00', endTime: '13:00', status: 'active',
    }));
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
  process.env.SMARTTT_API_KEY = KEY;
  process.env.SMARTTT_SYNC_INTERVAL_SECONDS = '60';

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  ({ resetTimetableSyncState } = await import('../../src/modules/unit/unit.service.js'));
  ({ linkAllocationsToStudent } = await import('../../src/modules/unit/index.js'));
});

beforeEach(() => {
  smarttt = {}; smartttCalls = []; smartttHeaders = [];
  resetTimetableSyncState();
  stubFetch();
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

const getUnits = (lecturer: { auth: string }) =>
  request(app).get('/api/v1/units').set('Authorization', lecturer.auth);
const getRoster = (lecturer: { auth: string }, unitId: string) =>
  request(app).get(`/api/v1/units/${unitId}/students`).set('Authorization', lecturer.auth);

describe('GET /units syncs from SMARTTT', () => {
  it('brings in the units SMARTTT timetables for the lecturer, with registered-student counts', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [
      unit('cosc  100', 42, [slot(1)]),                    // one weekly slot
      unit('COSC 200', 7, [slot(2), slot(4, '14:00', '16:00')]), // two slots
    ] };

    const res = await getUnits(lec);
    expect(res.status).toBe(200);
    const got = byCode(res);
    expect(Object.keys(got)).toEqual(['COSC 100', 'COSC 200']);
    expect(got['COSC 100']).toMatchObject({
      name: 'cosc  100 name', status: 'VERIFIED', registeredStudents: 42, studentCount: 0,
      schedule: { dayOfWeek: 1, startTime: '08:00', endTime: '10:00' },
    });
    expect(got['COSC 100']!.timetableSyncedAt).toEqual(expect.any(String));
    // Two slots don't fit unit_schedule's one-slot-per-unit, so none is set.
    expect(got['COSC 200']).toMatchObject({ registeredStudents: 7, schedule: null, status: 'VERIFIED' });

    // What went over the wire.
    expect(smartttCalls).toHaveLength(1);
    expect(smartttCalls[0]!.pathname).toBe('/api/v1/integrations/attendance/lecturer-units/');
    expect(smartttCalls[0]!.searchParams.get('staff_number')).toBe(lec.staffNumber);
    expect(smartttCalls[0]!.searchParams.get('name')).toMatch(/^Dr\. Lecturer \d+$/);
    expect(smartttHeaders[0]!.get('X-API-Key')).toBe(KEY);

    const { rows } = await pool.query(`SELECT action, metadata->>'source' AS source FROM audit_logs WHERE user_id = $1`, [lec.id]);
    expect(rows).toEqual(expect.arrayContaining([{ action: 'UNIT_CREATED', source: 'SMARTTT' }]));
  });

  it('refreshes counts and names on a later sync without duplicating units, and keeps units that drop off', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('BIT 110', 10), unit('BIT 120', 5)] };
    const first = byCode(await getUnits(lec));

    resetTimetableSyncState(); // skip the throttle
    smarttt[lec.staffNumber] = { units: [unit('BIT 110', 12, [slot(3)], 'account', 'Renamed')] };
    const second = byCode(await getUnits(lec));

    expect(second['BIT 110']).toMatchObject({ id: first['BIT 110']!.id, name: 'Renamed', registeredStudents: 12,
      schedule: { dayOfWeek: 3, startTime: '08:00', endTime: '10:00' } });
    expect(second['BIT 120']).toMatchObject({ id: first['BIT 120']!.id, registeredStudents: 5 }); // kept, last known count
  });

  it('holds back units SMARTTT only matches by name until an admin verifies them', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('EDU 300', 30, [slot(5)], 'name')] };
    const pending = byCode(await getUnits(lec))['EDU 300']!;
    expect(pending.status).toBe('PENDING_VERIFICATION');

    // Once SMARTTT links it to the lecturer's account, it is verified.
    resetTimetableSyncState();
    smarttt[lec.staffNumber] = { units: [unit('EDU 300', 30, [slot(5)], 'account')] };
    expect(byCode(await getUnits(lec))['EDU 300']!.status).toBe('VERIFIED');

    // And it never goes back down.
    resetTimetableSyncState();
    smarttt[lec.staffNumber] = { units: [unit('EDU 300', 31, [slot(5)], 'name')] };
    expect(byCode(await getUnits(lec))['EDU 300']).toMatchObject({ status: 'VERIFIED', registeredStudents: 31 });
  });

  it("never takes a unit another lecturer already holds", async () => {
    const owner = await makeLecturer();
    const other = await makeLecturer();
    smarttt[owner.staffNumber] = { units: [unit('MATH 101', 50)] };
    smarttt[other.staffNumber] = { units: [unit('MATH 101', 99, [slot(6)], 'account', 'Hijacked'), unit('MATH 102', 3)] };

    await getUnits(owner);
    const otherUnits = byCode(await getUnits(other));
    expect(Object.keys(otherUnits)).toEqual(['MATH 102']);

    const ownerUnits = byCode(await getUnits(owner));
    expect(ownerUnits['MATH 101']).toMatchObject({ name: 'MATH 101 name', registeredStudents: 50 });
  });

  it('adds SMARTTT data to a unit the lecturer had already added by code', async () => {
    const lec = await makeLecturer();
    const created = await request(app).post('/api/v1/units').set('Authorization', lec.auth).send({ code: 'PHY 101' });
    expect(created.status).toBe(201);
    const createdUnit = (created.body as { data: UnitBody }).data;
    expect(createdUnit).toMatchObject({ registeredStudents: null, timetableSyncedAt: null });

    smarttt[lec.staffNumber] = { units: [unit('PHY 101', 64, [slot(1)])] };
    const synced = byCode(await getUnits(lec))['PHY 101']!;
    expect(synced).toMatchObject({ id: createdUnit.id, registeredStudents: 64, status: 'VERIFIED' });
  });

  it.each(['DOWN', 'FORBIDDEN', 'NOT_FOUND', 'GARBAGE'] as const)(
    'still lists the units on file when SMARTTT answers %s',
    async (answer) => {
      const lec = await makeLecturer();
      const code = `CHEM ${answer}`; // a code per case: units have one owner
      smarttt[lec.staffNumber] = { units: [unit(code, 20)] };
      await getUnits(lec);

      resetTimetableSyncState();
      smarttt[lec.staffNumber] = answer;
      const res = await getUnits(lec);
      expect(res.status).toBe(200);
      expect(byCode(res)[code]).toMatchObject({ registeredStudents: 20 });
    },
  );

  it('still lists units when SMARTTT cannot be reached at all', async () => {
    const lec = await makeLecturer();
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('fetch failed'));
    const res = await getUnits(lec);
    expect(res.status).toBe(200);
    expect(units(res)).toEqual([]);
  });

  it('asks SMARTTT at most once per interval per lecturer', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('ZOO 101', 1)] };
    await Promise.all([getUnits(lec), getUnits(lec)]);
    await getUnits(lec);
    expect(smartttCalls).toHaveLength(1);
  });
});

describe('unit rosters come from SMARTTT', () => {
  it("fills each unit's roster with SMARTTT's registered students: registration numbers and names", async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [
      unit('SMA 101', 3, [slot(1)], 'account', 'Calculus', [
        student('ebt1/00002/23', 'Amina Kamau'),        // normalised to upper case
        student('EBT1/00001/23', 'Brian Otieno'),
        student('EBT1/00001/23', 'Brian Otieno (dup)'),  // listed twice: kept once
      ]),
    ] };

    const u = byCode(await getUnits(lec))['SMA 101']!;
    expect(u).toMatchObject({ registeredStudents: 3, studentCount: 2 });

    const res = await getRoster(lec, u.id);
    expect(res.status).toBe(200);
    expect(roster(res)).toEqual([
      { registrationNumber: 'EBT1/00001/23', fullName: 'Brian Otieno', status: 'ACTIVE', source: 'SMARTTT', hasAccount: false },
      { registrationNumber: 'EBT1/00002/23', fullName: 'Amina Kamau', status: 'ACTIVE', source: 'SMARTTT', hasAccount: false },
    ]);
    // The roster view goes through SMARTTT (throttled), never the ERP.
    expect(vi.mocked(globalThis.fetch).mock.calls.every(([input]) => String(input instanceof Request ? input.url : input).startsWith(SMARTTT))).toBe(true);
  });

  it('opening a roster first syncs from SMARTTT, even without visiting the units page', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('SMA 102', 1, [slot(2)], 'account', 'Algebra', [student('EBT1/00010/23', 'Faith Chebet')])] };
    await getUnits(lec);
    const unitId = (await pool.query<{ id: string }>(`SELECT id FROM units WHERE code = 'SMA 102'`)).rows[0]!.id;

    resetTimetableSyncState();
    smarttt[lec.staffNumber] = { units: [unit('SMA 102', 2, [slot(2)], 'account', 'Algebra', [
      student('EBT1/00010/23', 'Faith Chebet'), student('EBT1/00011/23', 'George Mutua'),
    ])] };
    const res = await getRoster(lec, unitId);
    expect(roster(res).map((r) => r.registrationNumber)).toEqual(['EBT1/00010/23', 'EBT1/00011/23']);
  });

  it('drops students who leave SMARTTT (and old ERP rows), keeps legacy rows and past history', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('SMA 103', 2, [slot(3)], 'account', 'Stats', [
      student('EBT1/00020/23', 'Hassan Ali'), student('EBT1/00021/23', 'Irene Wairimu'),
    ])] };
    const u = byCode(await getUnits(lec))['SMA 103']!;
    // Rows written before SMARTTT: one from the (mock) ERP, one added by a lecturer long ago.
    await pool.query(
      `INSERT INTO unit_allocations (unit_id, registration_number, full_name, status, source)
       VALUES ($1, 'MOCK/0001', 'Mock ERP Student', 'ACTIVE', 'ERP'), ($1, 'OLD/0001', 'Legacy Student', 'ACTIVE', 'LECTURER')`,
      [u.id]);

    resetTimetableSyncState();
    smarttt[lec.staffNumber] = { units: [unit('SMA 103', 1, [slot(3)], 'account', 'Stats', [student('EBT1/00021/23', null)])] };
    await getUnits(lec);

    const rows = roster(await getRoster(lec, u.id));
    const status: Record<string, [string, string]> = Object.fromEntries(
      rows.map((r): [string, [string, string]] => [r.registrationNumber ?? '', [r.status, r.source]]),
    );
    expect(status).toEqual({
      'EBT1/00021/23': ['ACTIVE', 'SMARTTT'],
      'EBT1/00020/23': ['DROPPED', 'SMARTTT'],
      'MOCK/0001': ['DROPPED', 'ERP'],
      'OLD/0001': ['ACTIVE', 'LECTURER'],
    });
    // A null name from SMARTTT keeps the name already on file.
    expect(rows.find((r) => r.registrationNumber === 'EBT1/00021/23')!.fullName).toBe('Irene Wairimu');
    expect(byCode(await getUnits(lec))['SMA 103']).toMatchObject({ registeredStudents: 1, studentCount: 2 });
  });

  it('a synced student who then creates an account is linked by registration number', async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [unit('SMA 104', 1, [slot(4)], 'account', 'Geometry', [student('EBT1/00030/23', 'Joy Njeri')])] };
    const u = byCode(await getUnits(lec))['SMA 104']!;

    const { rows: [s] } = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
       VALUES ('joy.njeri@uni.ac.ke', 'x', 'Joy Njeri', 'STUDENT', 'ACTIVE', NOW()) RETURNING id`);
    expect(await linkAllocationsToStudent(s!.id, 'ebt1/00030/23')).toBe(1);
    expect(roster(await getRoster(lec, u.id))[0]).toMatchObject({ registrationNumber: 'EBT1/00030/23', hasAccount: true });
  });

  it("never rewrites the roster of a unit another lecturer holds", async () => {
    const owner = await makeLecturer();
    const other = await makeLecturer();
    smarttt[owner.staffNumber] = { units: [unit('SMA 105', 1, [slot(5)], 'account', 'Topology', [student('EBT1/00040/23', 'Kevin Tuei')])] };
    const u = byCode(await getUnits(owner))['SMA 105']!;

    smarttt[other.staffNumber] = { units: [unit('SMA 105', 1, [slot(5)], 'account', 'Topology', [student('EBT1/99999/23', 'Intruder')])] };
    await getUnits(other);

    resetTimetableSyncState();
    smarttt[owner.staffNumber] = 'DOWN'; // so the owner's view can't re-sync it back
    expect(roster(await getRoster(owner, u.id)).map((r) => r.registrationNumber)).toEqual(['EBT1/00040/23']);
  });
});

describe('units split into groups taught by different lecturers', () => {
  it('gives each group its own unit, lecturer and roster, and says how many have not picked a group', async () => {
    const a = await makeLecturer();
    const b = await makeLecturer();
    smarttt[a.staffNumber] = { units: [groupUnit('COSC 103', 'GR A', 2, 40, [student('EBT1/00101/23', 'Amina Kamau'), student('EBT1/00102/23', 'Brian Otieno')])] };
    smarttt[b.staffNumber] = { units: [groupUnit('COSC 103', 'GR B', 1, 40, [student('EBT1/00103/23', 'Cynthia Ouma')], [slot(2)])] };

    const unitA = byCode(await getUnits(a))['COSC 103 GR A']!;
    const unitB = byCode(await getUnits(b))['COSC 103 GR B']!;
    expect(unitA).toMatchObject({ baseCode: 'COSC 103', group: 'GR A', registeredStudents: 2, studentsWithoutGroup: 40, studentCount: 2, status: 'VERIFIED' });
    expect(unitB).toMatchObject({ baseCode: 'COSC 103', group: 'GR B', registeredStudents: 1, studentsWithoutGroup: 40, studentCount: 1, status: 'VERIFIED' });
    expect(unitA.schedule).toEqual({ dayOfWeek: 1, startTime: '08:00', endTime: '10:00' });
    expect(unitB.schedule).toEqual({ dayOfWeek: 2, startTime: '08:00', endTime: '10:00' });

    expect(roster(await getRoster(a, unitA.id)).map((r) => r.registrationNumber)).toEqual(['EBT1/00101/23', 'EBT1/00102/23']);
    expect(roster(await getRoster(b, unitB.id)).map((r) => r.registrationNumber)).toEqual(['EBT1/00103/23']);
    // Each lecturer only reaches their own group.
    expect((await getRoster(a, unitB.id)).status).toBe(403);
  });

  it("keeps a lecturer's whole-class lecture and their group as two units", async () => {
    const lec = await makeLecturer();
    smarttt[lec.staffNumber] = { units: [
      { ...unit('COSC 104', 5, [slot(5)], 'account', 'Discrete Maths', []), unit_code: 'COSC 104', group: null, students_without_group: 0 },
      groupUnit('COSC 104', 'GR_C', 2, 3, [], [slot(3)]),
    ] };
    const got = byCode(await getUnits(lec));
    expect(Object.keys(got)).toEqual(['COSC 104', 'COSC 104 GR_C']);
    expect(got['COSC 104']).toMatchObject({ group: null, registeredStudents: 5, studentsWithoutGroup: 0 });
    expect(got['COSC 104 GR_C']).toMatchObject({ group: 'GR_C', registeredStudents: 2, studentsWithoutGroup: 3 });
  });

  it('stores class codes longer than the 32 characters typed-in unit codes allow', async () => {
    const lec = await makeLecturer();
    const long = 'EDFO 111 GR BED ARTS KISWAHILI HISTORY';
    smarttt[lec.staffNumber] = { units: [groupUnit('EDFO 111', 'GR BED ARTS KISWAHILI HISTORY', 1, 0, [])] };
    expect(byCode(await getUnits(lec))[long]).toMatchObject({ baseCode: 'EDFO 111' });
  });
});

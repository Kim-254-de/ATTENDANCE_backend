import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The quality-assurance module against a real Postgres database: standards,
 * checklist templates, the audit -> finding -> CAPA lifecycle, the KPI
 * dashboard's rollup math, and every CSV/PDF export. Every reported figure
 * is kept checkable by hand — one department, one audit with a known mix of
 * ratings, one attendance session with a known rate.
 */
const TEST_DB = 'attendance_qa_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let app: Express;
let pool: pg.Pool;

interface Body<T = Record<string, unknown>> { data: T; error?: { code: string; message: string } }
const body = <T = Record<string, unknown>>(res: request.Response) => res.body as Body<T>;

const uniq = (() => { let n = 0; return () => ++n; })();

async function makeUser(role: 'LECTURER' | 'STUDENT' | 'DEPARTMENT' | 'QA', fullName: string) {
  const n = uniq();
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, 'x', $2, $3, 'ACTIVE', NOW()) RETURNING id`,
    [`${role.toLowerCase()}${n}@uni.ac.ke`, fullName, role]);
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, 'x', NOW() + INTERVAL '1 hour')`,
    [sessionId, u!.id]);
  const { signAccessToken } = await import('../../src/modules/auth/auth.session.js');
  return { id: u!.id, auth: `Bearer ${await signAccessToken({ userId: u!.id, sessionId, role })}` };
}

async function makeQaOfficer(fullName: string) {
  const user = await makeUser('QA', fullName);
  await pool.query(`INSERT INTO qa_profiles (user_id, title) VALUES ($1, 'QA Officer')`, [user.id]);
  return user;
}

async function makeFaculty(name: string): Promise<string> {
  const { rows: [f] } = await pool.query<{ id: string }>(`INSERT INTO faculties (name) VALUES ($1) RETURNING id`, [name]);
  return f!.id;
}

async function makeDepartment(name: string, facultyId: string | null): Promise<string> {
  const { rows: [d] } = await pool.query<{ id: string }>(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2) RETURNING id`, [name, facultyId]);
  return d!.id;
}

async function makeLecturer(fullName: string, departmentId: string) {
  const user = await makeUser('LECTURER', fullName);
  await pool.query(
    `INSERT INTO lecturer_profiles (user_id, staff_number, erp_verified_at, department_id, department)
     VALUES ($1, $2, NOW(), $3, (SELECT name FROM departments WHERE id = $3))`,
    [user.id, `STF/Q${uniq()}`, departmentId]);
  return user;
}

async function makeUnit(code: string, lecturerUserId: string): Promise<string> {
  const { rows: [u] } = await pool.query<{ id: string }>(
    `INSERT INTO units (code, name, lecturer_user_id, status) VALUES ($1, $2, $3, 'VERIFIED') RETURNING id`,
    [code, `${code} Course`, lecturerUserId]);
  return u!.id;
}

async function allocate(unitId: string, studentUserId: string, registrationNumber: string, fullName: string) {
  const { rows: [a] } = await pool.query<{ id: string }>(
    `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source)
     VALUES ($1, $2, $3, $4, 'ACTIVE', 'ERP') RETURNING id`,
    [unitId, registrationNumber, studentUserId, fullName]);
  return a!.id;
}

async function makeSession(args: { unitId: string; lecturerUserId: string; scheduledStartAt: Date; opensAt: Date }): Promise<string> {
  const { rows: [s] } = await pool.query<{ id: string }>(
    `INSERT INTO attendance_sessions
       (unit_id, lecturer_user_id, qr_secret, status, opens_at, closes_at, rotation_seconds, scheduled_start_at)
     VALUES ($1, $2, $3, 'CLOSED', $4::timestamptz, $4::timestamptz + INTERVAL '1 hour', 60, $5) RETURNING id`,
    [args.unitId, args.lecturerUserId, randomUUID(), args.opensAt, args.scheduledStartAt]);
  return s!.id;
}

async function recordAttendance(sessionId: string, studentUserId: string, allocationId: string) {
  await pool.query(
    `INSERT INTO attendance_records (session_id, student_user_id, allocation_id) VALUES ($1, $2, $3)`,
    [sessionId, studentUserId, allocationId]);
}

const api = (auth: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Authorization', auth),
  post: (path: string, data?: object) => request(app).post(`/api/v1${path}`).set('Authorization', auth).send(data),
  patch: (path: string, data?: object) => request(app).patch(`/api/v1${path}`).set('Authorization', auth).send(data),
  put: (path: string, data?: object) => request(app).put(`/api/v1${path}`).set('Authorization', auth).send(data),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Authorization', auth),
});

// --- the fixture -------------------------------------------------------------

const BASE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

interface Fixture {
  qa: { id: string; auth: string };
  lecturer: { id: string; auth: string };
  departmentId: string;
  departmentName: string;
  standardId: string;
  standardCode: string;
  templateId: string;
  itemId: string;
}
let fx: Fixture;

async function seed(): Promise<Fixture> {
  const qa = await makeQaOfficer('QA Officer');

  const facultyId = await makeFaculty('Faculty of Science and Technology');
  const departmentName = 'Department of Computer Science';
  const departmentId = await makeDepartment(departmentName, facultyId);
  const lecturer = await makeLecturer('Dr. Reviewed', departmentId);

  const unit = await makeUnit('CSC 101', lecturer.id);
  const student = await makeUser('STUDENT', 'Ama Mensah');
  const allocationId = await allocate(unit, student.id, 'REG/Q001', 'Ama Mensah');
  // One session, fully attended -> avg_attendance_rate 100 for this department.
  const session = await makeSession({ unitId: unit, lecturerUserId: lecturer.id, scheduledStartAt: BASE, opensAt: BASE });
  await recordAttendance(session, student.id, allocationId);

  const { rows: [standard] } = await pool.query<{ id: string }>(
    `INSERT INTO qa_standards (code, category, title) VALUES ('STD-TEST-01', 'GOVERNANCE', 'Test standard') RETURNING id`);
  const { rows: [template] } = await pool.query<{ id: string }>(
    `INSERT INTO qa_checklist_templates (name, created_by_user_id) VALUES ('Test Template', $1) RETURNING id`, [qa.id]);
  const { rows: [item] } = await pool.query<{ id: string }>(
    `INSERT INTO qa_checklist_items (template_id, standard_id, prompt) VALUES ($1, $2, 'Meets the test standard?') RETURNING id`,
    [template!.id, standard!.id]);

  return {
    qa,
    lecturer,
    departmentId,
    departmentName,
    standardId: standard!.id,
    standardCode: 'STD-TEST-01',
    templateId: template!.id,
    itemId: item!.id,
  };
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  app = (await import('../../src/app.js')).createApp();
  fx = await seed();
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
});

// ---------------------------------------------------------------------------

describe('the QA role', () => {
  it('widens the users.role CHECK constraint to include QA', async () => {
    const { rows: [constraint] } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conname = 'users_role_check'
            AND pg_get_constraintdef(oid) LIKE '%QA%') AS ok`);
    expect(constraint!.ok).toBe(true);
  });

  it('resolves a QA officer at sign-in', async () => {
    const { findAccountForLogin } = await import('../../src/modules/auth/auth.session.repository.js');
    const { rows: [u] } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [fx.qa.id]);
    const candidate = await findAccountForLogin(u!.email);
    expect(candidate?.role).toBe('QA');
    expect(candidate?.account).toMatchObject({ role: 'qa', title: 'QA Officer' });
  });

  it('rejects every other role from the QA endpoints', async () => {
    const res = await api(fx.lecturer.auth).get('/quality-assurance/standards');
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/quality-assurance/standards');
    expect(res.status).toBe(401);
  });
});

describe('standards', () => {
  it('creates, lists, filters by category/active, and updates', async () => {
    const created = await api(fx.qa.auth).post('/quality-assurance/standards', {
      code: 'STD-NEW-01',
      category: 'STUDENTS',
      title: 'New standard',
    });
    expect(created.status).toBe(201);
    const id = body(created).data.id as string;

    const list = await api(fx.qa.auth).get('/quality-assurance/standards?category=STUDENTS');
    expect((body<Array<{ id: string }>>(list).data)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );

    const deactivated = await api(fx.qa.auth).patch(`/quality-assurance/standards/${id}`, { isActive: false });
    expect(deactivated.status).toBe(200);

    const activeOnly = await api(fx.qa.auth).get('/quality-assurance/standards?active=true');
    expect((body<Array<{ id: string }>>(activeOnly).data).map((s) => s.id)).not.toContain(id);
  });

  it('rejects a duplicate code with 409', async () => {
    const res = await api(fx.qa.auth).post('/quality-assurance/standards', {
      code: fx.standardCode,
      category: 'GOVERNANCE',
      title: 'Duplicate',
    });
    expect(res.status).toBe(409);
  });
});

describe('checklist templates and items', () => {
  it('refuses to delete an item that already has a finding recorded against it', async () => {
    // Create a throwaway audit + finding against a fresh item, then try to delete that item.
    const { rows: [item] } = await pool.query<{ id: string }>(
      `INSERT INTO qa_checklist_items (template_id, standard_id, prompt) VALUES ($1, $2, 'Throwaway') RETURNING id`,
      [fx.templateId, fx.standardId],
    );
    const auditRes = await api(fx.qa.auth).post('/quality-assurance/audits', {
      title: 'Throwaway audit',
      targetDepartmentId: fx.departmentId,
      checklistTemplateId: fx.templateId,
      leadAuditorUserId: fx.qa.id,
      scheduledDate: '2026-01-01',
    });
    const auditId = body(auditRes).data.id as string;
    await api(fx.qa.auth).put(`/quality-assurance/audits/${auditId}/findings/${item!.id}`, { rating: 'COMPLIANT' });

    const del = await api(fx.qa.auth).delete(`/quality-assurance/checklist-templates/${fx.templateId}/items/${item!.id}`);
    expect(del.status).toBe(409);
  });
});

describe('audits and findings', () => {
  it('requires exactly one of targetDepartmentId/targetFacultyId', async () => {
    const neither = await api(fx.qa.auth).post('/quality-assurance/audits', {
      title: 'Bad audit',
      checklistTemplateId: fx.templateId,
      leadAuditorUserId: fx.qa.id,
      scheduledDate: '2026-01-01',
    });
    expect(neither.status).toBe(400);
  });

  it('runs a full audit lifecycle: create, fill checklist, complete, gated by missing findings', async () => {
    const created = await api(fx.qa.auth).post('/quality-assurance/audits', {
      title: 'Lifecycle audit',
      targetDepartmentId: fx.departmentId,
      checklistTemplateId: fx.templateId,
      leadAuditorUserId: fx.qa.id,
      scheduledDate: '2026-02-01',
    });
    expect(created.status).toBe(201);
    const audit = body(created).data as { id: string; totalItems: number };
    expect(audit.totalItems).toBeGreaterThanOrEqual(1);

    // Cannot complete with missing findings.
    const tooEarly = await api(fx.qa.auth).patch(`/quality-assurance/audits/${audit.id}`, { status: 'COMPLETED' });
    expect(tooEarly.status).toBe(400);

    // Cannot skip PLANNED -> COMPLETED either, independent of findings.
    const skip = await api(fx.qa.auth).patch(`/quality-assurance/audits/${audit.id}`, { status: 'IN_PROGRESS' });
    expect(skip.status).toBe(200);

    const checklist = await api(fx.qa.auth).get(`/quality-assurance/audits/${audit.id}/checklist`);
    const items = body<Array<{ checklistItemId: string }>>(checklist).data;
    for (const item of items) {
      const upsert = await api(fx.qa.auth).put(
        `/quality-assurance/audits/${audit.id}/findings/${item.checklistItemId}`,
        { rating: 'COMPLIANT' },
      );
      expect(upsert.status).toBe(200);
    }

    const completed = await api(fx.qa.auth).patch(`/quality-assurance/audits/${audit.id}`, { status: 'COMPLETED' });
    expect(completed.status).toBe(200);
    expect(body(completed).data).toMatchObject({ status: 'COMPLETED' });

    // Backwards transition refused.
    const backwards = await api(fx.qa.auth).patch(`/quality-assurance/audits/${audit.id}`, { status: 'PLANNED' });
    expect(backwards.status).toBe(400);
  });

  it('upserts a finding: same checklist item twice updates the same row', async () => {
    const created = await api(fx.qa.auth).post('/quality-assurance/audits', {
      title: 'Upsert audit',
      targetDepartmentId: fx.departmentId,
      checklistTemplateId: fx.templateId,
      leadAuditorUserId: fx.qa.id,
      scheduledDate: '2026-03-01',
    });
    const auditId = body(created).data.id as string;

    const first = await api(fx.qa.auth).put(
      `/quality-assurance/audits/${auditId}/findings/${fx.itemId}`,
      { rating: 'PARTIAL', evidenceNotes: 'first pass' },
    );
    const second = await api(fx.qa.auth).put(
      `/quality-assurance/audits/${auditId}/findings/${fx.itemId}`,
      { rating: 'NON_COMPLIANT', evidenceNotes: 'second pass' },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(body(first).data.id).toBe(body(second).data.id);
    expect(body(second).data).toMatchObject({ rating: 'NON_COMPLIANT', evidenceNotes: 'second pass' });

    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM qa_audit_findings WHERE audit_id = $1`,
      [auditId],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('corrective actions (CAPA)', () => {
  async function makeNonCompliantFinding(): Promise<{ auditId: string; findingId: string }> {
    const created = await api(fx.qa.auth).post('/quality-assurance/audits', {
      title: 'CAPA source audit',
      targetDepartmentId: fx.departmentId,
      checklistTemplateId: fx.templateId,
      leadAuditorUserId: fx.qa.id,
      scheduledDate: '2026-04-01',
    });
    const auditId = body(created).data.id as string;
    const finding = await api(fx.qa.auth).put(
      `/quality-assurance/audits/${auditId}/findings/${fx.itemId}`,
      { rating: 'NON_COMPLIANT', evidenceNotes: 'gap found' },
    );
    return { auditId, findingId: body(finding).data.id as string };
  }

  it('refuses a CAPA raised against a COMPLIANT finding', async () => {
    const { auditId } = await makeNonCompliantFinding();
    const compliant = await api(fx.qa.auth).put(
      `/quality-assurance/audits/${auditId}/findings/${fx.itemId}`,
      { rating: 'COMPLIANT' },
    );
    const findingId = body(compliant).data.id as string;

    const res = await api(fx.qa.auth).post('/quality-assurance/corrective-actions', {
      findingId,
      description: 'Should not be allowed',
      ownerUserId: fx.qa.id,
      dueDate: '2026-05-01',
    });
    expect(res.status).toBe(400);
  });

  it('runs the forward-only status workflow and stamps verification from the caller, not the body', async () => {
    const { findingId } = await makeNonCompliantFinding();
    const created = await api(fx.qa.auth).post('/quality-assurance/corrective-actions', {
      findingId,
      description: 'Fix the gap',
      ownerUserId: fx.qa.id,
      dueDate: '2026-05-01',
    });
    expect(created.status).toBe(201);
    const capaId = body(created).data.id as string;
    expect(body(created).data).toMatchObject({ status: 'OPEN', verifiedByUserId: null });

    // Skipping straight to VERIFIED is refused.
    const skip = await api(fx.qa.auth).patch(`/quality-assurance/corrective-actions/${capaId}`, { status: 'VERIFIED' });
    expect(skip.status).toBe(400);

    await api(fx.qa.auth).patch(`/quality-assurance/corrective-actions/${capaId}`, { status: 'IN_PROGRESS' });

    // A client-supplied verifiedByUserId must be ignored -- the caller's own id wins.
    const verified = await api(fx.qa.auth).patch(`/quality-assurance/corrective-actions/${capaId}`, {
      status: 'VERIFIED',
      verifiedByUserId: 'not-a-real-id',
    });
    expect(verified.status).toBe(200);
    expect(body(verified).data).toMatchObject({ status: 'VERIFIED', verifiedByUserId: fx.qa.id });

    const closed = await api(fx.qa.auth).patch(`/quality-assurance/corrective-actions/${capaId}`, { status: 'CLOSED' });
    expect(body(closed).data).toMatchObject({ status: 'CLOSED', verifiedByUserId: fx.qa.id });
  });
});

describe('KPI dashboard', () => {
  it('reports the attendance trend using the same per-session rate shape as the department module', async () => {
    const dashboard = await api(fx.qa.auth).get(`/quality-assurance/dashboard?targetDepartmentId=${fx.departmentId}`);
    expect(dashboard.status).toBe(200);
    const trends = body<{ attendanceTrends: Array<{ departmentId: string; avgAttendanceRate: number }> }>(dashboard).data.attendanceTrends;
    expect(trends).toEqual(
      expect.arrayContaining([expect.objectContaining({ departmentId: fx.departmentId, avgAttendanceRate: 100 })]),
    );
  });
});

describe('exports', () => {
  it('audits CSV has the expected header and content type', async () => {
    const res = await api(fx.qa.auth).get('/quality-assurance/audits/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text.split('\n')[0]).toBe(
      'Title,Target,Checklist Template,Lead Auditor,Scheduled Date,Status,Items,Findings Recorded',
    );
  });

  it('corrective-actions CSV has the expected header', async () => {
    const res = await api(fx.qa.auth).get('/quality-assurance/corrective-actions/export.csv');
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toBe('Audit,Standard,Description,Owner,Due Date,Status,Verified By,Verified At');
  });

  it('every PDF export starts with the %PDF- magic bytes', async () => {
    for (const url of [
      '/quality-assurance/audits/export.pdf',
      '/quality-assurance/corrective-actions/export.pdf',
      '/quality-assurance/dashboard/export.pdf',
    ]) {
      const res = await api(fx.qa.auth).get(url).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      const buf = res.body as Buffer;
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buf.length).toBeGreaterThan(500);
    }
  });
});

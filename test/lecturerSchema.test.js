import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import pg from 'pg';

const TEST_DB = 'attendance_schema_test';
const adminUrl = process.env.DATABASE_URL;
let pool;

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  process.env.DATABASE_URL = adminUrl.replace(/\/[^/]+$/, `/${TEST_DB}`);
  const db = await import('../src/db.js');
  await db.migrate();
  await db.migrate(); // idempotent
  pool = db.pool;
});
after(() => pool.end());

const ins = (name, email, staff, extra = '') =>
  pool.query(`INSERT INTO lecturers (full_name, email, staff_number, password_hash ${extra ? ',' + extra.split('=')[0] : ''})
              VALUES ($1,$2,$3,'hash' ${extra ? ',' + extra.split('=')[1] : ''}) RETURNING *`, [name, email, staff]);

test('new lecturer defaults to pending, unverified, zero failures', async () => {
  const { rows: [l] } = await ins('Dr A', 'a@uni.ac.ke', 'STF/0001');
  assert.equal(l.status, 'pending');
  assert.equal(l.email_verified_at, null);
  assert.equal(l.failed_login_count, 0);
});
test('email and staff number are unique, case-insensitively', async () => {
  await assert.rejects(ins('Other', 'A@UNI.AC.KE', 'STF/0002'), { code: '23505' });
  await assert.rejects(ins('Other', 'b@uni.ac.ke', 'stf/0001'), { code: '23505' });
});
test('rejects bad status and malformed email', async () => {
  await assert.rejects(ins('X', 'x@uni.ac.ke', 'STF/0003', "status='banned'"), { code: '23514' });
  await assert.rejects(ins('X', 'not-an-email', 'STF/0004'), { code: '23514' });
});
test('tokens: purpose constrained, cascade on lecturer delete', async () => {
  const { rows: [l] } = await ins('Dr B', 'b@uni.ac.ke', 'STF/0005');
  await pool.query(`INSERT INTO lecturer_tokens (lecturer_id, purpose, token_hash, expires_at) VALUES ($1,'password_reset','h1', now() + interval '1 hour')`, [l.id]);
  await assert.rejects(pool.query(`INSERT INTO lecturer_tokens (lecturer_id, purpose, token_hash, expires_at) VALUES ($1,'bogus','h2', now())`, [l.id]), { code: '23514' });
  await pool.query('DELETE FROM lecturers WHERE id = $1', [l.id]);
  const { rowCount } = await pool.query('SELECT 1 FROM lecturer_tokens WHERE lecturer_id = $1', [l.id]);
  assert.equal(rowCount, 0);
});
test('login attempts are kept when the lecturer row is deleted; updated_at trigger works', async () => {
  const { rows: [l] } = await ins('Dr C', 'c@uni.ac.ke', 'STF/0006');
  await pool.query(`INSERT INTO lecturer_login_attempts (lecturer_id, identifier, success) VALUES ($1,'c@uni.ac.ke',false)`, [l.id]);
  await new Promise((r) => setTimeout(r, 20));
  const { rows: [u] } = await pool.query(`UPDATE lecturers SET status='active' WHERE id=$1 RETURNING updated_at, created_at`, [l.id]);
  assert.ok(u.updated_at > u.created_at);
  await pool.query('DELETE FROM lecturers WHERE id = $1', [l.id]);
  const { rows } = await pool.query(`SELECT lecturer_id FROM lecturer_login_attempts WHERE identifier='c@uni.ac.ke'`);
  assert.equal(rows.length, 1); assert.equal(rows[0].lecturer_id, null);
});

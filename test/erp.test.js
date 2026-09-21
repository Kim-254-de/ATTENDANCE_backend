import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import 'dotenv/config';
import pg from 'pg';

// Tests run in their own database so they never touch real ERP data.
const TEST_DB = 'attendance_test';
const adminUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = adminUrl.replace(/\/[^/]+$/, `/${TEST_DB}`);
process.env.ERP_API_KEY = 'test-key';
let base, server, dbmod;
before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  dbmod = await import('../src/db.js');
  await dbmod.migrate();
  const { createApp } = await import('../src/app.js');
  await (await import('../src/erp/seed.js')).seedErp();
  await new Promise((ok) => { server = createApp().listen(0, () => { base = `http://localhost:${server.address().port}/api/erp`; ok(); }); });
});
after(async () => { server.close(); await dbmod.pool.end(); });
const call = (p, method = 'GET', body, key = 'test-key') =>
  fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': key }, body: body && JSON.stringify(body) });

test('seed is idempotent (does not overwrite edits)', async () => {
  const { seedErp } = await import('../src/erp/seed.js');
  assert.deepEqual(await seedErp(), { students: 0, staff: 0 });
});
test('requires API key', async () => {
  assert.equal((await call('/students', 'GET', undefined, 'nope')).status, 401);
  assert.equal((await fetch(base + '/students')).status, 401);
});
test('lists and searches', async () => {
  const all = await (await call('/students')).json();
  assert.equal(all.count, 10);
  const q = await (await call('/students?q=amina')).json();
  assert.equal(q.count, 1);
});
test('lookup by id with slash in reg number', async () => {
  const j = await (await call('/students/' + encodeURIComponent('SC211/0001/2022'))).json();
  assert.equal(j.found, true); assert.equal(j.active, true);
  const inactive = await (await call('/students/' + encodeURIComponent('SC211/0007/2020'))).json();
  assert.equal(inactive.active, false);
  assert.equal((await call('/staff/NOPE')).status, 404);
});
test('create, update, delete staff', async () => {
  const body = { staffNumber: 'STF/0099', fullName: 'Test Lecturer', department: 'Maths' };
  assert.equal((await call('/staff', 'POST', body)).status, 201);
  assert.equal((await call('/staff', 'POST', body)).status, 409);
  const up = await call('/staff/' + encodeURIComponent('STF/0099'), 'PUT', { ...body, status: 'left' });
  assert.equal((await up.json()).record.status, 'left');
  assert.equal((await call('/staff', 'POST', { staffNumber: 'X', fullName: 'X', status: 'bad' })).status, 400);
  assert.equal((await call('/staff/' + encodeURIComponent('STF/0099'), 'DELETE')).status, 200);
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';
import pg from 'pg';

// Runs against its own throwaway database, never the real mock-ERP data.
const TEST_DB = 'erp_mock_test';
const base = new URL(process.env.MOCK_ERP_DATABASE_URL);
base.pathname = '/postgres';
process.env.MOCK_ERP_DATABASE_URL = new URL(`/${TEST_DB}`, base).toString();
process.env.ERP_API_KEY = 'test-key';

let url, server, dbmod;
before(async () => {
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.end();
  dbmod = await import('../src/db.js');
  await dbmod.migrate();
  await (await import('../src/seed.js')).seedErp();
  const { createApp } = await import('../src/app.js');
  await new Promise((ok) => { server = createApp().listen(0, () => { url = `http://localhost:${server.address().port}/api/erp`; ok(); }); });
});
after(async () => { server.close(); await dbmod.pool.end(); });

const call = (p, method = 'GET', body, key = 'test-key') =>
  fetch(url + p, { method, headers: { 'content-type': 'application/json', 'x-api-key': key }, body: body && JSON.stringify(body) });

test('requires the API key', async () => {
  assert.equal((await call('/students', 'GET', undefined, 'nope')).status, 401);
  assert.equal((await fetch(url + '/staff/STF%2F0001')).status, 401);
});
test('staff lookup returns the bare record the API expects, id case-insensitive', async () => {
  const r = await call('/staff/' + encodeURIComponent('stf/0001'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.staffNumber, 'STF/0001');
  assert.equal(j.status, 'active');
  assert.equal(j.title, 'Dr.');
});
test('unknown staff number is a 404; left/suspended staff are returned with that status', async () => {
  assert.equal((await call('/staff/NOPE')).status, 404);
  assert.equal((await (await call('/staff/' + encodeURIComponent('STF/0005'))).json()).status, 'left');
  assert.equal((await (await call('/staff/' + encodeURIComponent('STF/0006'))).json()).status, 'suspended');
});
test('student lookup and list/search', async () => {
  assert.equal((await (await call('/students/' + encodeURIComponent('SC211/0007/2020'))).json()).status, 'graduated');
  assert.equal((await (await call('/students?q=amina')).json()).count, 1);
});
test('create, duplicate, update, delete staff', async () => {
  const body = { staffNumber: 'STF/0099', fullName: 'Test Lecturer', department: 'Maths' };
  assert.equal((await call('/staff', 'POST', body)).status, 201);
  assert.equal((await call('/staff', 'POST', body)).status, 409);
  assert.equal((await (await call('/staff/STF%2F0099', 'PUT', { ...body, status: 'left' })).json()).record.status, 'left');
  assert.equal((await call('/staff', 'POST', { staffNumber: 'X', fullName: 'X', status: 'bad' })).status, 400);
  assert.equal((await call('/staff/STF%2F0099', 'DELETE')).status, 200);
});
test('PUT with a partial body does not blank fields it did not send', async () => {
  const id = encodeURIComponent('STF/0001');
  const r = await call(`/staff/${id}`, 'PUT', { fullName: 'Peter Kamami', department: 'Computer Science', status: 'active' });
  const rec = (await r.json()).record;
  assert.equal(rec.email, 'peter.kamami@uni.ac.ke');
  assert.equal(rec.title, 'Dr.');
  assert.equal(rec.faculty, 'School of Computing');
});
test('course lookup returns the bare record the unit module expects, code case-insensitive', async () => {
  const r = await call('/courses/' + encodeURIComponent('cosc 310'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.code, 'COSC 310');
  assert.equal(j.staffNumber, 'STF/0002');
  assert.equal(j.status, 'active');
});
test('unknown course code is a 404; a course with no assigned lecturer has a null staffNumber', async () => {
  assert.equal((await call('/courses/NOPE')).status, 404);
  assert.equal((await (await call('/courses/' + encodeURIComponent('COSC 415'))).json()).staffNumber, null);
});
test('create, duplicate, update, delete course', async () => {
  const body = { code: 'COSC 999', name: 'Test Course', dayOfWeek: 1, startTime: '09:00', endTime: '10:00' };
  assert.equal((await call('/courses', 'POST', body)).status, 201);
  assert.equal((await call('/courses', 'POST', body)).status, 409);
  assert.equal((await (await call('/courses/COSC%20999', 'PUT', { ...body, status: 'inactive' })).json()).record.status, 'inactive');
  assert.equal((await call('/courses', 'POST', { code: 'X', name: 'X', dayOfWeek: 9, startTime: 'nope', endTime: 'nope' })).status, 400);
  assert.equal((await call('/courses/COSC%20999', 'DELETE')).status, 200);
});
test('course roster lists enrolled students in the plain student shape', async () => {
  const r = await call('/courses/' + encodeURIComponent('cosc 205') + '/students');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.count, 3);
  assert.deepEqual(j.results.map((s) => s.registrationNumber).sort(), ['SC211/0001/2022', 'SC211/0002/2022', 'SC211/0006/2021']);
  assert.equal(j.results.find((s) => s.registrationNumber === 'SC211/0001/2022').fullName, 'Amina Wanjiku Kamau');
});
test('a course with nobody enrolled has an empty roster; an unknown course code is a 404', async () => {
  assert.deepEqual((await (await call('/courses/' + encodeURIComponent('COSC 415') + '/students')).json()).results, []);
  assert.equal((await call('/courses/NOPE/students')).status, 404);
});
test('enrol and unenrol a student', async () => {
  assert.equal((await call('/courses/COSC%20415/students', 'POST', { registrationNumber: 'SC211/0005/2024' })).status, 201);
  assert.equal((await call('/courses/COSC%20415/students', 'POST', { registrationNumber: 'SC211/0005/2024' })).status, 409);
  assert.equal((await (await call('/courses/COSC%20415/students')).json()).count, 1);
  assert.equal((await call('/courses/COSC%20415/students/SC211%2F0005%2F2024', 'DELETE')).status, 200);
  assert.equal((await call('/courses/COSC%20415/students/SC211%2F0005%2F2024', 'DELETE')).status, 404);
});
test('seeding twice does not overwrite edits', async () => {
  assert.deepEqual(await (await import('../src/seed.js')).seedErp(), { students: 0, staff: 0, courses: 0, enrollments: 0 });
});

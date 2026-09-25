import { Router } from 'express';
import { query } from './db.js';
import { requireErpKey } from './erpKey.js';

const r = Router();
// Wrap async handlers so rejected promises reach Express' error handler.
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
r.use(requireErpKey);

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// One config per entity keeps the students/staff routes identical.
const entities = {
  students: {
    table: 'erp_students', key: 'reg_number', keyLabel: 'registrationNumber',
    statuses: ['active', 'deferred', 'graduated', 'discontinued'],
    fields: { full_name: 'fullName', programme: 'programme', year_of_study: 'yearOfStudy', status: 'status' },
  },
  staff: {
    table: 'erp_staff', key: 'staff_number', keyLabel: 'staffNumber',
    statuses: ['active', 'left', 'suspended'],
    fields: { full_name: 'fullName', email: 'email', department: 'department', faculty: 'faculty', title: 'title', status: 'status' },
  },
};

const toApi = (e, row) => row && {
  [e.keyLabel]: row[e.key],
  ...Object.fromEntries(Object.entries(e.fields).map(([col, name]) => [name, row[col]])),
};

function parse(e, body, { requireKey }) {
  const errors = {};
  const key = str(body?.[e.keyLabel]);
  if (requireKey && !key) errors[e.keyLabel] = 'Required';
  const fullName = str(body?.fullName);
  if (!fullName) errors.fullName = 'Required';
  const status = str(body?.status) || 'active';
  if (!e.statuses.includes(status)) errors.status = `Must be one of: ${e.statuses.join(', ')}`;
  let year = null;
  if (e.table === 'erp_students' && body?.yearOfStudy !== undefined && body.yearOfStudy !== '' && body.yearOfStudy !== null) {
    year = Number(body.yearOfStudy);
    if (!Number.isInteger(year) || year < 1 || year > 8) errors.yearOfStudy = 'Must be a whole number 1-8';
  }
  const values = { full_name: fullName, status, programme: str(body?.programme) || null, department: str(body?.department) || null, faculty: str(body?.faculty) || null, title: str(body?.title) || null, email: str(body?.email).toLowerCase() || null, year_of_study: year };
  return { key, values, errors };
}

for (const [name, e] of Object.entries(entities)) {
  const valueCols = Object.keys(e.fields);
  const byKey = `SELECT * FROM ${e.table} WHERE ${e.key} = $1`;

  // List / search:  ?q=text (matches id or name)  &status=active
  r.get(`/${name}`, h(async (req, res) => {
    const q = str(req.query.q), status = str(req.query.status);
    const where = [], args = [];
    if (q) { args.push(`%${q}%`); where.push(`(${e.key}::text ILIKE $${args.length} OR full_name ILIKE $${args.length})`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    const { rows } = await query(`SELECT * FROM ${e.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${e.key} LIMIT 500`, args);
    res.json({ count: rows.length, results: rows.map((x) => toApi(e, x)) });
  }));

  // Lookup one: returns the bare record; `status` says whether the person is still active. 404 if unknown.
  r.get(`/${name}/:id`, h(async (req, res) => {
    const { rows: [row] } = await query(byKey, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found in ERP' });
    res.json(toApi(e, row));
  }));

  r.post(`/${name}`, h(async (req, res) => {
    const { key, values, errors } = parse(e, req.body, { requireKey: true });
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', errors });
    try {
      const { rows: [row] } = await query(
        `INSERT INTO ${e.table} (${e.key}, ${valueCols.join(',')}) VALUES (${['$1', ...valueCols.map((_, i) => `$${i + 2}`)].join(',')}) RETURNING *`,
        [key, ...valueCols.map((c) => values[c])]);
      res.status(201).json({ record: toApi(e, row) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Already exists', errors: { [e.keyLabel]: 'Already exists' } });
      throw err;
    }
  }));

  // PUT updates only the fields present in the body (fullName and status are always applied),
  // so a client that doesn't know about a column can't blank it.
  r.put(`/${name}/:id`, h(async (req, res) => {
    const { values, errors } = parse(e, req.body, { requireKey: false });
    if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', errors });
    const sent = valueCols.filter((c) => c === 'full_name' || c === 'status' || req.body?.[e.fields[c]] !== undefined);
    const { rows: [row] } = await query(
      `UPDATE ${e.table} SET ${sent.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE ${e.key} = $1 RETURNING *`,
      [req.params.id, ...sent.map((c) => values[c])]);
    if (!row) return res.status(404).json({ error: 'Not found in ERP' });
    res.json({ record: toApi(e, row) });
  }));

  r.delete(`/${name}/:id`, h(async (req, res) => {
    const { rowCount } = await query(`DELETE FROM ${e.table} WHERE ${e.key} = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found in ERP' });
    res.json({ ok: true });
  }));
}

// ---------------------------------------------------------------------------
// Courses: the issued timetable. Shaped differently from students/staff (a
// schedule slot and a staff assignment, no name/status-only record), so it
// gets its own routes rather than being squeezed into the `entities` loop above.
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const courseStatuses = ['active', 'inactive'];

const courseToApi = (row) => row && {
  code: row.code,
  name: row.name,
  staffNumber: row.staff_number,
  dayOfWeek: row.day_of_week,
  startTime: row.start_time.slice(0, 5),
  endTime: row.end_time.slice(0, 5),
  status: row.status,
};

function parseCourse(body, { requireCode }) {
  const errors = {};
  const code = str(body?.code);
  if (requireCode && !code) errors.code = 'Required';
  const name = str(body?.name);
  if (!name) errors.name = 'Required';
  const dayOfWeek = Number(body?.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) errors.dayOfWeek = 'Must be 0-6 (Sun-Sat)';
  const startTime = str(body?.startTime);
  if (!HHMM.test(startTime)) errors.startTime = 'Must be HH:MM';
  const endTime = str(body?.endTime);
  if (!HHMM.test(endTime)) errors.endTime = 'Must be HH:MM';
  if (HHMM.test(startTime) && HHMM.test(endTime) && endTime <= startTime) errors.endTime = 'Must be after startTime';
  const status = str(body?.status) || 'active';
  if (!courseStatuses.includes(status)) errors.status = `Must be one of: ${courseStatuses.join(', ')}`;
  const staffNumber = str(body?.staffNumber) || null;
  return { code, values: { name, staff_number: staffNumber, day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, status }, errors };
}

// List / search: ?q=text (matches code or name) &status=active &staffNumber=STF/0001
r.get('/courses', h(async (req, res) => {
  const q = str(req.query.q), status = str(req.query.status), staffNumber = str(req.query.staffNumber);
  const where = [], args = [];
  if (q) { args.push(`%${q}%`); where.push(`(code::text ILIKE $${args.length} OR name ILIKE $${args.length})`); }
  if (status) { args.push(status); where.push(`status = $${args.length}`); }
  if (staffNumber) { args.push(staffNumber); where.push(`staff_number = $${args.length}`); }
  const { rows } = await query(`SELECT * FROM erp_courses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY code LIMIT 500`, args);
  res.json({ count: rows.length, results: rows.map(courseToApi) });
}));

// Lookup one: the unit module calls this to verify a code exists and pull its real name/schedule. 404 if unknown.
r.get('/courses/:code', h(async (req, res) => {
  const { rows: [row] } = await query('SELECT * FROM erp_courses WHERE code = $1', [req.params.code]);
  if (!row) return res.status(404).json({ error: 'Not found in ERP' });
  res.json(courseToApi(row));
}));

r.post('/courses', h(async (req, res) => {
  const { code, values, errors } = parseCourse(req.body, { requireCode: true });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', errors });
  try {
    const { rows: [row] } = await query(
      `INSERT INTO erp_courses (code, name, staff_number, day_of_week, start_time, end_time, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code, values.name, values.staff_number, values.day_of_week, values.start_time, values.end_time, values.status]);
    res.status(201).json({ record: courseToApi(row) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already exists', errors: { code: 'Already exists' } });
    throw err;
  }
}));

r.put('/courses/:code', h(async (req, res) => {
  const { values, errors } = parseCourse(req.body, { requireCode: false });
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Validation failed', errors });
  const { rows: [row] } = await query(
    `UPDATE erp_courses SET name = $2, staff_number = $3, day_of_week = $4, start_time = $5, end_time = $6, status = $7
      WHERE code = $1 RETURNING *`,
    [req.params.code, values.name, values.staff_number, values.day_of_week, values.start_time, values.end_time, values.status]);
  if (!row) return res.status(404).json({ error: 'Not found in ERP' });
  res.json({ record: courseToApi(row) });
}));

r.delete('/courses/:code', h(async (req, res) => {
  const { rowCount } = await query('DELETE FROM erp_courses WHERE code = $1', [req.params.code]);
  if (!rowCount) return res.status(404).json({ error: 'Not found in ERP' });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Enrollments: who's on a course's real class list. The unit module syncs a
// unit's roster from this instead of a lecturer adding students by hand.
// ---------------------------------------------------------------------------

// List: the shape matches a plain student lookup (registrationNumber, fullName, ...),
// so the same mapper as /students is reused. 404 if the course itself is unknown.
r.get('/courses/:code/students', h(async (req, res) => {
  const { rows: [course] } = await query('SELECT code FROM erp_courses WHERE code = $1', [req.params.code]);
  if (!course) return res.status(404).json({ error: 'Not found in ERP' });
  const { rows } = await query(
    `SELECT s.* FROM erp_enrollments e
       JOIN erp_students s ON s.reg_number = e.reg_number
      WHERE e.course_code = $1
      ORDER BY s.full_name`,
    [req.params.code],
  );
  res.json({ count: rows.length, results: rows.map((x) => toApi(entities.students, x)) });
}));

// Enrol one student (for seeding/testing the roster sync).
r.post('/courses/:code/students', h(async (req, res) => {
  const regNumber = str(req.body?.registrationNumber);
  if (!regNumber) return res.status(400).json({ error: 'Validation failed', errors: { registrationNumber: 'Required' } });
  const { rows: [course] } = await query('SELECT code FROM erp_courses WHERE code = $1', [req.params.code]);
  if (!course) return res.status(404).json({ error: 'Not found in ERP' });
  try {
    await query('INSERT INTO erp_enrollments (course_code, reg_number) VALUES ($1, $2)', [req.params.code, regNumber]);
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Already enrolled' });
    throw err;
  }
}));

r.delete('/courses/:code/students/:regNumber', h(async (req, res) => {
  const { rowCount } = await query(
    'DELETE FROM erp_enrollments WHERE course_code = $1 AND reg_number = $2',
    [req.params.code, req.params.regNumber],
  );
  if (!rowCount) return res.status(404).json({ error: 'Not found in ERP' });
  res.json({ ok: true });
}));

export default r;

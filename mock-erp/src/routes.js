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

export default r;

// DEV ONLY. The unit's existence/schedule is already verified automatically against the
// ERP timetable (unit.service.ts createUnit); this script stands in for the one part that
// still needs a human — confirming the lecturer-unit assignment — since there's no admin
// endpoint for that yet:
//   npm run dev:verify-unit -- "COSC 100"
// Moves a unit that landed PENDING_VERIFICATION to VERIFIED and writes an audit row.
// Refuses to run against production.
import 'dotenv/config';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }
const code = process.argv[2]?.trim().replace(/\s+/g, ' ').toUpperCase();
if (!code) { console.error('Usage: npm run dev:verify-unit -- <UNIT_CODE>'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows: [u] } = await client.query(`SELECT id, code, status FROM units WHERE code = $1`, [code]);
  if (!u) throw new Error(`No unit with the code ${code} exists.`);
  if (u.status === 'VERIFIED') { console.log(`${code} is already VERIFIED`); process.exit(0); }
  await client.query('BEGIN');
  await client.query(`UPDATE units SET status = 'VERIFIED' WHERE id = $1`, [u.id]);
  await client.query(
    `INSERT INTO audit_logs (action, outcome, reason, metadata)
     VALUES ('UNIT_VERIFIED', 'SUCCESS', 'verified via dev script', $1)`,
    [JSON.stringify({ dev: true, unitId: u.id, unitCode: code })],
  );
  await client.query('COMMIT');
  console.log(`${code}: PENDING_VERIFICATION -> VERIFIED`);
} catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await client.end(); }

// DEV ONLY. There is no administrator approval endpoint yet, so this stands in for it locally:
//   npm run dev:approve -- STF/0003
// Moves a lecturer whose email is confirmed (PENDING_APPROVAL) to ACTIVE and writes an audit row.
// Refuses to run against production.
import 'dotenv/config';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }
const staffNumber = process.argv[2]?.trim().toUpperCase();
if (!staffNumber) { console.error('Usage: npm run dev:approve -- <STAFF_NUMBER>'); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows: [u] } = await client.query(
    `SELECT u.id, u.email, u.status FROM users u JOIN lecturer_profiles p ON p.user_id = u.id WHERE p.staff_number = $1`, [staffNumber]);
  if (!u) throw new Error(`No lecturer registered with staff number ${staffNumber}`);
  if (u.status === 'PENDING_VERIFICATION') throw new Error('Email not confirmed yet - open the verification link first.');
  if (u.status === 'ACTIVE') { console.log(`${staffNumber} is already ACTIVE`); process.exit(0); }
  await client.query('BEGIN');
  await client.query(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [u.id]);
  await client.query(
    `INSERT INTO audit_logs (action, outcome, user_id, subject_email, subject_staff_number, reason, metadata)
     VALUES ('ACCOUNT_APPROVED', 'SUCCESS', $1, $2, $3, 'approved via dev script', '{"dev":true}')`, [u.id, u.email, staffNumber]);
  await client.query('COMMIT');
  console.log(`${staffNumber} (${u.email}): ${u.status} -> ACTIVE`);
} catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e.message); process.exitCode = 1; }
finally { await client.end(); }

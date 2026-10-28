// DEV ONLY. There is no administrator interface for fingerprints yet, so this stands in for it,
// the same way dev-enrol-card.mjs does for cards.
//
// IMPORTANT: this does not enrol a fingerprint. The reader does that — you put the student's
// finger on it, it stores the template in one of its own slots and tells you which. This only
// records that "slot N on terminal T is this student". No fingerprint reaches this database.
//
//   npm run dev:enrol-fingerprint -- REG/001 TERM-01 37            student, terminal, reader slot
//   npm run dev:enrol-fingerprint -- REG/001 TERM-01 37 --label "right index"
//   npm run dev:enrol-fingerprint -- REG/001 TERM-01 --revoke      free that terminal's slot
//   npm run dev:enrol-fingerprint -- REG/001 --revoke-all          leaving the institution
//   npm run dev:enrol-fingerprint -- REG/001 --list
//
// Only an HMAC of the slot reference is stored, so it cannot be read back — to move a student to
// a different slot, revoke and enrol again. Writes an audit row. Refuses to run in production.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const USAGE = 'Usage: npm run dev:enrol-fingerprint -- <REGISTRATION_NUMBER> <TERMINAL_ID> <SLOT> [--label "<label>"]\n'
  + '       npm run dev:enrol-fingerprint -- <REGISTRATION_NUMBER> <TERMINAL_ID> --revoke\n'
  + '       npm run dev:enrol-fingerprint -- <REGISTRATION_NUMBER> --revoke-all\n'
  + '       npm run dev:enrol-fingerprint -- <REGISTRATION_NUMBER> --list';

const secret = process.env.FINGERPRINT_REF_SECRET;
if (!secret) {
  console.error('FINGERPRINT_REF_SECRET is not set. Slot references are stored under an HMAC keyed\n'
    + 'with it; without it this script cannot produce the hash the API will look up.');
  process.exit(1);
}

// Must match normaliseCardUid + hashCardUid in src/common/utils/card-uid.ts, which the
// fingerprint path reuses — otherwise an enrolment would never match at the terminal.
const hashRef = (ref) => createHmac('sha256', secret)
  .update(ref.trim().replace(/[\s:-]/g, '').toUpperCase()).digest('hex');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i === -1) return false; args.splice(i, 1); return true; };
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) { console.error(`${name} needs a value.\n${USAGE}`); process.exit(1); }
  args.splice(i, 2);
  return value;
};

const revoking = flag('--revoke');
const revokingAll = flag('--revoke-all');
const listing = flag('--list');
const label = option('--label') ?? null;
const [registrationNumber, terminalId, slot] = args;

if (!registrationNumber) { console.error(USAGE); process.exit(1); }
if (!listing && !revokingAll && !terminalId) { console.error(`A terminal id is required.\n${USAGE}`); process.exit(1); }
if (!listing && !revokingAll && !revoking && !slot) { console.error(`A reader slot is required.\n${USAGE}`); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const reg = registrationNumber.trim().toUpperCase();
const { rows: [student] } = await client.query(
  `SELECT p.user_id, u.full_name
     FROM student_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.registration_number = $1 AND u.deleted_at IS NULL`, [reg]);
if (!student) {
  console.error(`No student account for ${reg}. They must register before a finger can be bound to them.`);
  await client.end();
  process.exit(1);
}

const audit = (action, metadata) => client.query(
  `INSERT INTO audit_logs (action, outcome, user_id, subject_registration_number, reason, metadata)
   VALUES ($1, 'SUCCESS', $2, $3, 'dev-enrol-fingerprint.mjs', $4)`,
  [action, student.user_id, reg, JSON.stringify(metadata)]);

try {
  if (listing) {
    const { rows } = await client.query(
      `SELECT terminal_id, label, status, enrolled_at, revoked_at FROM student_fingerprints
        WHERE student_user_id = $1 ORDER BY status = 'ACTIVE' DESC, enrolled_at DESC`, [student.user_id]);
    console.log(`${reg} (${student.full_name}): ${rows.length} enrolment(s)`);
    for (const r of rows) {
      const when = r.status === 'ACTIVE' ? `enrolled ${r.enrolled_at.toISOString()}` : `revoked ${r.revoked_at.toISOString()}`;
      console.log(`  ${r.status.padEnd(8)} ${r.terminal_id.padEnd(12)} ${when}${r.label ? `  "${r.label}"` : ''}`);
    }
    process.exit(0);
  }

  if (revokingAll) {
    const { rowCount } = await client.query(
      `UPDATE student_fingerprints SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
        WHERE student_user_id = $1 AND status = 'ACTIVE'`, [student.user_id]);
    if (!rowCount) { console.log(`${reg} (${student.full_name}) has no active enrolments.`); process.exit(0); }
    await audit('STUDENT_FINGERPRINT_REVOKED', { scope: 'all', revoked: rowCount });
    console.log(`${reg} (${student.full_name}): ${rowCount} enrolment(s) revoked across all terminals.`);
    console.log('The templates themselves are still on those readers — clear them there too.');
    process.exit(0);
  }

  const terminal = terminalId.trim();

  if (revoking) {
    const { rowCount } = await client.query(
      `UPDATE student_fingerprints SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
        WHERE student_user_id = $1 AND terminal_id = $2 AND status = 'ACTIVE'`, [student.user_id, terminal]);
    if (!rowCount) { console.log(`${reg} (${student.full_name}) has no active enrolment on ${terminal}.`); process.exit(0); }
    await audit('STUDENT_FINGERPRINT_REVOKED', { terminalId: terminal });
    console.log(`${reg} (${student.full_name}): enrolment on ${terminal} revoked.`);
    console.log(`The template is still in that reader's slot — clear it on the device too.`);
    process.exit(0);
  }

  const { rows: [existing] } = await client.query(
    `SELECT 1 FROM student_fingerprints
      WHERE student_user_id = $1 AND terminal_id = $2 AND status = 'ACTIVE'`, [student.user_id, terminal]);
  if (existing) {
    console.error(`${reg} already has an active enrolment on ${terminal}. Revoke it first:\n`
      + `  npm run dev:enrol-fingerprint -- ${reg} ${terminal} --revoke`);
    process.exit(1);
  }

  const { rows: [row] } = await client.query(
    `INSERT INTO student_fingerprints
       (student_user_id, terminal_id, finger_ref_hmac, label, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE') RETURNING id`,
    [student.user_id, terminal, hashRef(slot), label]);
  await audit('STUDENT_FINGERPRINT_ENROLLED', { enrolmentId: row.id, terminalId: terminal, label });
  console.log(`${reg} (${student.full_name}): slot ${slot} on ${terminal} is now theirs.`);
  console.log('Make sure the template is actually enrolled in that slot on the reader itself.');
} catch (error) {
  if (error.code === '23505') {
    console.error(`That slot on ${terminalId} is already taken by someone else. Each slot belongs to one student.`);
    process.exit(1);
  }
  throw error;
} finally {
  await client.end();
}

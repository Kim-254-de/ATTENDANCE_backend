// DEV ONLY. There is no administrator interface for cards yet, so this stands in for it locally,
// the same way dev-set-room.mjs does for rooms.
//   npm run dev:enrol-card -- REG/001 04:A3:B2:C1              bind a card to a registration number
//   npm run dev:enrol-card -- REG/001 04A3B2C1 --label "re-issued Oct 2026"
//   npm run dev:enrol-card -- REG/001 --revoke                 take the current card out of use
//   npm run dev:enrol-card -- REG/001 --list                   the student's cards, current first
// Only the HMAC of the UID is stored (common/utils/card-uid.ts), so the UID cannot be read back out
// — a lost card is revoked and a new one enrolled, never looked up. Writes an audit row.
// Refuses to run against production: enrolling a card is enrolling a credential.
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const USAGE = 'Usage: npm run dev:enrol-card -- <REGISTRATION_NUMBER> <CARD_UID> [--label "<label>"]\n'
  + '       npm run dev:enrol-card -- <REGISTRATION_NUMBER> --revoke\n'
  + '       npm run dev:enrol-card -- <REGISTRATION_NUMBER> --list';

const secret = process.env.CARD_UID_SECRET;
if (!secret) {
  console.error('CARD_UID_SECRET is not set. Card UIDs are stored under an HMAC keyed with it;\n'
    + 'without it this script cannot produce the same hash the API will look up.');
  process.exit(1);
}

// Must match normaliseCardUid + hashCardUid in src/common/utils/card-uid.ts exactly,
// or an enrolled card would never match at the door.
const normaliseUid = (uid) => uid.trim().replace(/[\s:-]/g, '').toUpperCase();
const hashUid = (uid) => createHmac('sha256', secret).update(normaliseUid(uid)).digest('hex');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined) { console.error(`${name} needs a value.\n${USAGE}`); process.exit(1); }
  args.splice(i, 2);
  return value;
};

const revoking = flag('--revoke');
const listing = flag('--list');
const label = option('--label') ?? null;
const [registrationNumber, cardUid] = args;

if (!registrationNumber) { console.error(USAGE); process.exit(1); }
if (!revoking && !listing && !cardUid) { console.error(`A card UID is required.\n${USAGE}`); process.exit(1); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const reg = registrationNumber.trim().toUpperCase();
const { rows: [student] } = await client.query(
  `SELECT p.user_id, u.full_name
     FROM student_profiles p JOIN users u ON u.id = p.user_id
    WHERE p.registration_number = $1 AND u.deleted_at IS NULL`,
  [reg],
);
if (!student) {
  console.error(`No student account for ${reg}. They must register before a card can be bound to them.`);
  await client.end();
  process.exit(1);
}

if (listing) {
  const { rows } = await client.query(
    `SELECT label, status, issued_at, revoked_at FROM student_cards
      WHERE student_user_id = $1 ORDER BY status = 'ACTIVE' DESC, issued_at DESC`,
    [student.user_id],
  );
  console.log(`${reg} (${student.full_name}): ${rows.length} card(s)`);
  for (const r of rows) {
    const when = r.status === 'ACTIVE' ? `issued ${r.issued_at.toISOString()}` : `revoked ${r.revoked_at.toISOString()}`;
    console.log(`  ${r.status.padEnd(8)} ${when}${r.label ? `  "${r.label}"` : ''}`);
  }
  await client.end();
  process.exit(0);
}

if (revoking) {
  const { rows: [revoked] } = await client.query(
    `UPDATE student_cards SET status = 'REVOKED', revoked_at = NOW(), updated_at = NOW()
      WHERE student_user_id = $1 AND status = 'ACTIVE' RETURNING id`,
    [student.user_id],
  );
  if (!revoked) {
    console.log(`${reg} (${student.full_name}) has no active card.`);
    await client.end();
    process.exit(0);
  }
  await client.query(
    `INSERT INTO audit_logs (action, outcome, user_id, subject_registration_number, reason, metadata)
     VALUES ('STUDENT_CARD_REVOKED', 'SUCCESS', $1, $2, 'dev-enrol-card.mjs', $3)`,
    [student.user_id, reg, JSON.stringify({ cardId: revoked.id })],
  );
  console.log(`${reg} (${student.full_name}): card revoked. They cannot check in by card until a new one is enrolled.`);
  await client.end();
  process.exit(0);
}

// Enrolling. The partial unique index allows one ACTIVE card per student, so say
// so plainly rather than surfacing a constraint name.
const { rows: [existing] } = await client.query(
  `SELECT 1 FROM student_cards WHERE student_user_id = $1 AND status = 'ACTIVE'`,
  [student.user_id],
);
if (existing) {
  console.error(`${reg} already has an active card. Revoke it first:\n`
    + `  npm run dev:enrol-card -- ${reg} --revoke`);
  await client.end();
  process.exit(1);
}

try {
  const { rows: [card] } = await client.query(
    `INSERT INTO student_cards (student_user_id, card_uid_hmac, label, status)
     VALUES ($1, $2, $3, 'ACTIVE') RETURNING id`,
    [student.user_id, hashUid(cardUid), label],
  );
  await client.query(
    `INSERT INTO audit_logs (action, outcome, user_id, subject_registration_number, reason, metadata)
     VALUES ('STUDENT_CARD_ENROLLED', 'SUCCESS', $1, $2, 'dev-enrol-card.mjs', $3)`,
    [student.user_id, reg, JSON.stringify({ cardId: card.id, label })],
  );
  console.log(`${reg} (${student.full_name}): card enrolled as ${normaliseUid(cardUid)}.`);
  console.log('They can now check in by swiping it at a terminal, in classes where the lecturer ticked ID card scanning.');
} catch (error) {
  if (error.code === '23505') {
    console.error('That card is already enrolled, to this student or another. Each card belongs to one person.');
    await client.end();
    process.exit(1);
  }
  throw error;
} finally {
  await client.end();
}

// DEV ONLY. There is no student registration module yet, so there are no real
// student accounts to generate believable attendance history against — this
// creates synthetic ones directly, the same way dev-approve-lecturer.mjs
// stands in for the (also unbuilt) admin-approval endpoint.
//   npm run dev:seed-attendance -- STF/0001
// For every unit the given lecturer already owns: tops up a roster of ~20
// synthetic students (idempotent — re-running doesn't duplicate them, keyed
// by a deterministic email/registration number), then opens 5 CLOSED
// sessions in the past with a randomised 70-97% attendance rate each.
// Refuses to run against production.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }
const staffNumber = process.argv[2]?.trim().toUpperCase();
if (!staffNumber) { console.error('Usage: npm run dev:seed-attendance -- <STAFF_NUMBER>'); process.exit(1); }

const ROSTER_SIZE = 20;
const SESSIONS_PER_UNIT = 5;
const FIRST_NAMES = ['Amina', 'Brian', 'Cynthia', 'David', 'Esther', 'Felix', 'Grace', 'Hassan', 'Irene', 'James', 'Kevin', 'Linda', 'Moses', 'Naomi', 'Otieno', 'Purity', 'Quinter', 'Robert', 'Susan', 'Titus'];
const LAST_NAMES = ['Wanjiku', 'Otieno', 'Achieng', 'Njoroge', 'Wekesa', 'Rotich', 'Musyoka', 'Mohamed', 'Koech', 'Mwaura'];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: [lecturer] } = await client.query(
    `SELECT u.id, u.full_name FROM users u JOIN lecturer_profiles p ON p.user_id = u.id WHERE p.staff_number = $1`,
    [staffNumber],
  );
  if (!lecturer) throw new Error(`No lecturer registered with staff number ${staffNumber}`);

  const { rows: units } = await client.query(
    `SELECT id, code, name FROM units WHERE lecturer_user_id = $1 ORDER BY code`,
    [lecturer.id],
  );
  if (units.length === 0) throw new Error(`${staffNumber} has no units yet — add one first.`);

  for (const unit of units) {
    const unitSlug = unit.code.replace(/\s+/g, '').toLowerCase();

    // Top up the roster to ROSTER_SIZE, without duplicating students from a previous run.
    const { rows: [{ n: existing }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM unit_allocations WHERE unit_id = $1 AND registration_number LIKE $2`,
      [unit.id, `SEED/${unitSlug}/%`],
    );
    const toCreate = Math.max(0, ROSTER_SIZE - existing);

    for (let i = existing; i < existing + toCreate; i++) {
      const fullName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
      const email = `seed.${unitSlug}.${i}@test.local`;
      const registrationNumber = `SEED/${unitSlug.toUpperCase()}/${String(i).padStart(3, '0')}`;

      await client.query('BEGIN');
      const { rows: [student] } = await client.query(
        `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
         VALUES ($1, 'seed-script-no-login', $2, 'STUDENT', 'ACTIVE', NOW())
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [email, fullName],
      );
      await client.query(
        `INSERT INTO unit_allocations (unit_id, registration_number, student_user_id, full_name, status, source, added_by_user_id)
         VALUES ($1, $2, $3, $4, 'ACTIVE', 'LECTURER', $5)
         ON CONFLICT (unit_id, registration_number) WHERE registration_number IS NOT NULL DO NOTHING`,
        [unit.id, registrationNumber, student.id, fullName, lecturer.id],
      );
      await client.query('COMMIT');
    }

    const { rows: roster } = await client.query(
      `SELECT id AS allocation_id, student_user_id FROM unit_allocations
        WHERE unit_id = $1 AND status = 'ACTIVE' AND student_user_id IS NOT NULL`,
      [unit.id],
    );

    for (let s = 0; s < SESSIONS_PER_UNIT; s++) {
      const daysAgo = 3 + s * 4 + rand(3); // spread across the past ~6 weeks, newest first
      const opensAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
      opensAt.setHours(9 + rand(6), pick([0, 15, 30, 45]), 0, 0);
      const closesAt = new Date(opensAt.getTime() + 60 * 60_000);

      await client.query('BEGIN');
      const { rows: [session] } = await client.query(
        `INSERT INTO attendance_sessions
           (unit_id, lecturer_user_id, qr_secret, status, title, opens_at, closes_at, rotation_seconds)
         VALUES ($1, $2, $3, 'CLOSED', NULL, $4, $5, 45)
         RETURNING id`,
        [unit.id, lecturer.id, randomUUID(), opensAt, closesAt],
      );

      const rate = 0.70 + Math.random() * 0.27; // 70-97%
      const attendees = shuffle(roster).slice(0, Math.round(roster.length * rate));
      for (const attendee of attendees) {
        const recordedAt = new Date(opensAt.getTime() + rand(15 * 60_000)); // within the first 15 min
        await client.query(
          `INSERT INTO attendance_records (session_id, student_user_id, allocation_id, recorded_at, qr_age_seconds)
           VALUES ($1, $2, $3, $4, $5)`,
          [session.id, attendee.student_user_id, attendee.allocation_id, recordedAt, rand(40)],
        );
      }
      await client.query('COMMIT');
    }

    console.log(`${unit.code}: roster ${existing + toCreate} (+${toCreate} new), ${SESSIONS_PER_UNIT} sessions seeded`);
  }

  console.log(`Done seeding attendance for ${staffNumber}.`);
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

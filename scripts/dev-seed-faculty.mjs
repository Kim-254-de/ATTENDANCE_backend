// DEV ONLY. There is no registration flow for the FACULTY role and there
// never will be a self-service one: a faculty officer has no ERP staff
// record to verify against, so an open sign-up form would have nothing to
// check. Accounts are provisioned directly, and this stands in for that until
// there is an admin interface.
//   node scripts/dev-seed-faculty.mjs
//   node scripts/dev-seed-faculty.mjs "Physical Engineering and Technologies" faculty.pet@test.local
// Creates one faculty (if it does not already exist) and one ACTIVE
// faculty-officer user with a faculty_profiles row, then prints the sign-in
// credentials.
// Idempotent — re-running updates the existing rows rather than duplicating
// them, keyed by faculty name and the officer's email.
// Refuses to run against production.
import 'dotenv/config';
import { hash, Algorithm } from '@node-rs/argon2';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const FACULTY = process.argv[2]?.trim() || 'Faculty of Science and Technology';
const EMAIL = (process.argv[3]?.trim() || 'faculty.officer@test.local').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD || 'FacultyOfficer#2024';

// The same Argon2id parameters src/config/env.ts defaults to, so the hash this
// writes verifies against the running API without re-hashing.
const argon2 = {
  algorithm: Algorithm.Argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 19456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  const { rows: [faculty] } = await client.query(
    `INSERT INTO faculties (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [FACULTY],
  );

  const { rows: [officer] } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, $2, $3, 'FACULTY', 'ACTIVE', NOW())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = 'FACULTY',
           status = 'ACTIVE',
           email_verified_at = NOW()
     RETURNING id`,
    [EMAIL, await hash(PASSWORD, argon2), `${FACULTY} Officer`],
  );

  await client.query(
    `INSERT INTO faculty_profiles (user_id, faculty_id, title)
     VALUES ($1, $2, 'Prof.')
     ON CONFLICT (user_id) DO UPDATE SET faculty_id = EXCLUDED.faculty_id`,
    [officer.id, faculty.id],
  );

  const { rows: [{ count: departmentCount }] } = await client.query(
    `SELECT COUNT(*)::int AS count FROM departments WHERE faculty_id = $1`,
    [faculty.id],
  );

  await client.query('COMMIT');

  console.log(`Faculty: ${FACULTY} (${faculty.id})`);
  console.log(`Departments in this faculty: ${departmentCount}`);
  console.log('');
  console.log('Sign in with:');
  console.log(`  identifier: ${EMAIL}`);
  console.log(`  password:   ${PASSWORD}`);
  console.log('');
  console.log('A faculty officer has no staff or registration number, so sign-in is by email only.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

// DEV ONLY. There is no registration flow for the DEPARTMENT role and there
// never will be a self-service one: a department officer has no ERP staff
// record to verify against, so an open sign-up form would have nothing to
// check. Accounts are provisioned directly, and this stands in for that until
// there is an admin interface.
//   node scripts/dev-seed-department.mjs
//   node scripts/dev-seed-department.mjs "School of Computing" "Computer Science" dept.cs@test.local
// Creates one faculty, one department and one ACTIVE department-officer user
// with a department_profiles row, then prints the sign-in credentials.
// Idempotent — re-running updates the existing rows rather than duplicating
// them, keyed by faculty/department name and the officer's email.
// Refuses to run against production.
import 'dotenv/config';
import { hash, Algorithm } from '@node-rs/argon2';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const FACULTY = process.argv[2]?.trim() || 'Faculty of Science and Technology';
const DEPARTMENT = process.argv[3]?.trim() || 'Department of Computer Science';
const EMAIL = (process.argv[4]?.trim() || 'department.officer@test.local').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD || 'DeptOfficer#2024';

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

  const { rows: [department] } = await client.query(
    `INSERT INTO departments (name, faculty_id) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET faculty_id = EXCLUDED.faculty_id
     RETURNING id`,
    [DEPARTMENT, faculty.id],
  );

  const { rows: [officer] } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, $2, $3, 'DEPARTMENT', 'ACTIVE', NOW())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = 'DEPARTMENT',
           status = 'ACTIVE',
           email_verified_at = NOW()
     RETURNING id`,
    [EMAIL, await hash(PASSWORD, argon2), `${DEPARTMENT} Officer`],
  );

  await client.query(
    `INSERT INTO department_profiles (user_id, department_id, title)
     VALUES ($1, $2, 'Dr.')
     ON CONFLICT (user_id) DO UPDATE SET department_id = EXCLUDED.department_id`,
    [officer.id, department.id],
  );

  // Attach any lecturer the ERP already filed under this department name, so
  // the seeded officer has something to oversee on a database that already has
  // lecturers in it.
  const { rowCount: attached } = await client.query(
    `UPDATE lecturer_profiles SET department_id = $1
      WHERE department_id IS NULL AND department = $2`,
    [department.id, DEPARTMENT],
  );

  await client.query('COMMIT');

  console.log(`Faculty:    ${FACULTY}`);
  console.log(`Department: ${DEPARTMENT} (${department.id})`);
  console.log(`Lecturers attached by name: ${attached}`);
  console.log('');
  console.log('Sign in with:');
  console.log(`  identifier: ${EMAIL}`);
  console.log(`  password:   ${PASSWORD}`);
  console.log('');
  console.log('A department officer has no staff or registration number, so sign-in is by email only.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

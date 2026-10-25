// DEV ONLY. There is no registration flow for the QA role and there never
// will be a self-service one: a QA officer has no ERP staff record to verify
// against, so an open sign-up form would have nothing to check. Accounts are
// provisioned directly, and this stands in for that until there is an admin
// interface.
//   node scripts/dev-seed-qa.mjs
//   node scripts/dev-seed-qa.mjs "QA Officer" qa.officer@test.local
// Creates one ACTIVE QA-role user with a qa_profiles row, then idempotently
// seeds the default 8-category standards catalog and one default checklist
// template (one item per standard), and prints the sign-in credentials.
// Idempotent — re-running updates existing rows rather than duplicating them.
// Refuses to run against production.
import 'dotenv/config';
import { hash, Algorithm } from '@node-rs/argon2';
import pg from 'pg';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const TITLE = process.argv[2]?.trim() || 'QA Officer';
const EMAIL = (process.argv[3]?.trim() || 'qa.officer@test.local').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD || 'QaOfficer#2024';

// The same Argon2id parameters src/config/env.ts defaults to, so the hash this
// writes verifies against the running API without re-hashing.
const argon2 = {
  algorithm: Algorithm.Argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_COST ?? 19456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
};

// Matches qa_standards' CHECK constraint (db/migrations/028_qa_standards.sql).
const DEFAULT_STANDARDS = [
  { code: 'STD-GOV-01', category: 'GOVERNANCE', title: 'Institutional governance and leadership' },
  { code: 'STD-PROG-01', category: 'ACADEMIC_PROGRAMS', title: 'Curriculum design and academic programs' },
  { code: 'STD-STAFF-01', category: 'STAFF', title: 'Staff qualifications and development' },
  { code: 'STD-STU-01', category: 'STUDENTS', title: 'Student support and welfare' },
  { code: 'STD-FAC-01', category: 'FACILITIES', title: 'Physical and learning facilities' },
  { code: 'STD-FIN-01', category: 'FINANCE', title: 'Financial management and sustainability' },
  { code: 'STD-RES-01', category: 'RESEARCH', title: 'Research output and supervision' },
  { code: 'STD-COM-01', category: 'COMMUNITY_ENGAGEMENT', title: 'Community engagement and outreach' },
];

const DEFAULT_TEMPLATE_NAME = 'General Internal Audit Checklist';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query('BEGIN');

  const { rows: [officer] } = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at)
     VALUES ($1, $2, $3, 'QA', 'ACTIVE', NOW())
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = 'QA',
           status = 'ACTIVE',
           email_verified_at = NOW()
     RETURNING id`,
    [EMAIL, await hash(PASSWORD, argon2), TITLE],
  );

  await client.query(
    `INSERT INTO qa_profiles (user_id, title)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET title = EXCLUDED.title`,
    [officer.id, TITLE],
  );

  const standardIds = {};
  for (const s of DEFAULT_STANDARDS) {
    const { rows: [row] } = await client.query(
      `INSERT INTO qa_standards (code, category, title)
       VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET category = EXCLUDED.category, title = EXCLUDED.title
       RETURNING id`,
      [s.code, s.category, s.title],
    );
    standardIds[s.code] = row.id;
  }

  // No unique constraint on qa_checklist_templates.name — look up first so
  // re-running this script does not create a second "General Internal Audit
  // Checklist" every time.
  let { rows: [template] } = await client.query(
    `SELECT id FROM qa_checklist_templates WHERE name = $1`,
    [DEFAULT_TEMPLATE_NAME],
  );
  if (!template) {
    ({ rows: [template] } = await client.query(
      `INSERT INTO qa_checklist_templates (name, description, created_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [DEFAULT_TEMPLATE_NAME, 'One checklist item per standard, for a routine department audit.', officer.id],
    ));
  }

  let itemsCreated = 0;
  for (const s of DEFAULT_STANDARDS) {
    const { rows: [existing] } = await client.query(
      `SELECT id FROM qa_checklist_items WHERE template_id = $1 AND standard_id = $2`,
      [template.id, standardIds[s.code]],
    );
    if (existing) continue;
    await client.query(
      `INSERT INTO qa_checklist_items (template_id, standard_id, prompt)
       VALUES ($1, $2, $3)`,
      [template.id, standardIds[s.code], `Does the unit under review meet "${s.title}"?`],
    );
    itemsCreated += 1;
  }

  await client.query('COMMIT');

  console.log(`QA officer:        ${TITLE} (${officer.id})`);
  console.log(`Standards seeded:  ${DEFAULT_STANDARDS.length}`);
  console.log(`Checklist template: ${DEFAULT_TEMPLATE_NAME} (${template.id})`);
  console.log(`Checklist items created this run: ${itemsCreated}`);
  console.log('');
  console.log('Sign in with:');
  console.log(`  identifier: ${EMAIL}`);
  console.log(`  password:   ${PASSWORD}`);
  console.log('');
  console.log('A QA officer has no staff or registration number, so sign-in is by email only.');
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

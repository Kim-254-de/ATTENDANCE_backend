// Applies db/migrations/*.sql in order, once each. Usage: npm run db:migrate
import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const dir = new URL('./migrations/', import.meta.url);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
  if (done.has(f)) { console.log('skip ', f); continue; }
  await client.query('BEGIN');
  try {
    await client.query(fs.readFileSync(new URL(f, dir), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    await client.query('COMMIT');
    console.log('apply', f);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}
await client.end();

import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

const url = process.env.MOCK_ERP_DATABASE_URL;
export const pool = new pg.Pool({ connectionString: url });
export const query = (text, params) => pool.query(text, params);

// The mock ERP has its OWN database, separate from the application's, exactly as the real ERP would be.
async function ensureDatabase() {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: u.toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  await admin.end();
}

export async function migrate() {
  await ensureDatabase();
  await pool.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
}

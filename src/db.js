import 'dotenv/config';
import fs from 'node:fs';
import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  await pool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
}

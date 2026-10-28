import fs from 'node:fs';
import { parse } from 'dotenv';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { bootstrapAdmin as BootstrapAdmin } from '../../src/modules/auth/auth.invitation.js';

/**
 * The first administrator, invited at boot from BOOTSTRAP_ADMIN_EMAIL
 * (auth.invitation.ts bootstrapAdmin), against a real Postgres database.
 * It runs on every start of a free Render instance, so repeating it must
 * neither fail nor send another email.
 */
const sent: { to: string }[] = [];
let failNextEmail = false;
vi.mock('../../src/modules/notification/index.js', () => ({
  notificationService: {
    sendOfficerInvitation: vi.fn((message: { to: string }) => {
      if (failNextEmail) {
        failNextEmail = false;
        return Promise.reject(new Error('resend refused'));
      }
      sent.push({ to: message.to });
      return Promise.resolve();
    }),
  },
}));

const TEST_DB = 'attendance_admin_bootstrap_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

const EMAIL = 'first.admin@uni.ac.ke';
const NAME = 'First Admin';

let pool: pg.Pool;
let bootstrapAdmin: typeof BootstrapAdmin;

const invitations = async () =>
  (await pool.query<{ consumed_at: Date | null; invalidated_at: Date | null }>(
    `SELECT i.consumed_at, i.invalidated_at FROM account_invitations i JOIN users u ON u.id = i.user_id
      WHERE u.email = $1 ORDER BY i.created_at`, [EMAIL])).rows;
const live = async () => (await invitations()).filter((i) => !i.consumed_at && !i.invalidated_at);

beforeAll(async () => {
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.query(`CREATE DATABASE ${TEST_DB}`);
  await pgAdmin.end();

  const testUrl = new URL(realUrl); testUrl.pathname = `/${TEST_DB}`;
  process.env.DATABASE_URL = testUrl.toString();

  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const f of fs.readdirSync(new URL('../../db/migrations/', import.meta.url)).sort()) {
    await pool.query(fs.readFileSync(new URL(`../../db/migrations/${f}`, import.meta.url), 'utf8'));
  }
  ({ bootstrapAdmin } = await import('../../src/modules/auth/auth.invitation.js'));
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

beforeEach(() => { sent.length = 0; });

describe('bootstrapping the first administrator', () => {
  it('withdraws the link when the email fails, so the next start tries again', async () => {
    failNextEmail = true;
    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('EMAIL_FAILED');
    expect(await live()).toHaveLength(0);

    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('RESENT');
    expect(sent).toEqual([{ to: EMAIL }]);
    expect(await live()).toHaveLength(1);
  });

  it('does nothing while the invitation is still valid', async () => {
    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('INVITATION_PENDING');
    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('INVITATION_PENDING');
    expect(sent).toHaveLength(0);
  });

  it('sends a new link once the old one has expired', async () => {
    await pool.query(
      `UPDATE account_invitations SET expires_at = NOW() - INTERVAL '1 minute'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [EMAIL]);
    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('RESENT');
    expect(sent).toEqual([{ to: EMAIL }]);
    expect(await live()).toHaveLength(1);
  });

  it('stops for good once an administrator is active', async () => {
    await pool.query(`UPDATE users SET status = 'ACTIVE' WHERE email = $1`, [EMAIL]);
    expect(await bootstrapAdmin(EMAIL, NAME)).toBe('ADMIN_EXISTS');
    expect(await bootstrapAdmin('someone.else@uni.ac.ke', 'Someone Else')).toBe('ADMIN_EXISTS');
    expect(sent).toHaveLength(0);
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE role = 'ADMIN'`);
    expect(rows).toHaveLength(1);
  });

  it('refuses an email already held by a different kind of account', async () => {
    await pool.query(`UPDATE users SET status = 'DEACTIVATED' WHERE email = $1`, [EMAIL]);
    await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role, status) VALUES ('lec@uni.ac.ke', 'x', 'Lee Lecturer', 'LECTURER', 'ACTIVE')`);
    await expect(bootstrapAdmin('lec@uni.ac.ke', 'Lee Lecturer')).rejects.toMatchObject({ statusCode: 409 });
  });
});

import fs from 'node:fs';
import { parse } from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgresRateLimitStore as Store } from '../../src/middleware/rate-limit-store.js';

/**
 * The Postgres rate-limit store (src/middleware/rate-limit-store.ts): two
 * instances of the API, here two stores, must count against one bucket.
 */
const TEST_DB = 'attendance_rate_limit_test';
const realUrl = parse(fs.readFileSync(new URL('../../.env', import.meta.url)))['DATABASE_URL']!;
const adminUrl = new URL(realUrl); adminUrl.pathname = '/postgres';

let pool: pg.Pool;
let PostgresRateLimitStore: typeof Store;

const storeFor = (name: string, windowMs = 60_000) => {
  const store = new PostgresRateLimitStore(name);
  store.init({ windowMs } as Parameters<Store['init']>[0]);
  return store;
};

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
  ({ PostgresRateLimitStore } = await import('../../src/middleware/rate-limit-store.js'));
}, 60_000);

afterAll(async () => {
  await pool.end();
  await (await import('../../src/db/database.js')).closeDatabase();
  const pgAdmin = new pg.Client({ connectionString: adminUrl.toString() });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await pgAdmin.end();
});

describe('Postgres rate-limit store', () => {
  it('counts hits from two instances in one bucket, per limiter name', async () => {
    const a = storeFor('login');
    const b = storeFor('login');
    expect((await a.increment('1.2.3.4')).totalHits).toBe(1);
    expect((await b.increment('1.2.3.4')).totalHits).toBe(2);
    expect((await storeFor('global').increment('1.2.3.4')).totalHits).toBe(1);
    expect((await a.increment('5.6.7.8')).totalHits).toBe(1);
  });

  it('starts a new window once the old one has passed', async () => {
    const store = storeFor('short', 50);
    await store.increment('k');
    const second = await store.increment('k');
    expect(second.totalHits).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const fresh = await store.increment('k');
    expect(fresh.totalHits).toBe(1);
    expect(fresh.resetTime!.getTime()).toBeGreaterThan(second.resetTime!.getTime());
  });

  it('decrements and resets a key', async () => {
    const store = storeFor('undo');
    await store.increment('k');
    await store.increment('k');
    await store.decrement('k');
    expect((await store.increment('k')).totalHits).toBe(2);
    await store.resetKey('k');
    expect((await store.increment('k')).totalHits).toBe(1);
  });

  it('enforces a limit shared by two app instances', async () => {
    const instance = () => {
      const app = express();
      app.get('/', rateLimit({ windowMs: 60_000, limit: 3, store: new PostgresRateLimitStore('shared') }), (_req, res) => { res.send('ok'); });
      return app;
    };
    const [one, two] = [instance(), instance()];
    const statuses = [];
    for (const app of [one, two, one, two]) statuses.push((await request(app).get('/')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});

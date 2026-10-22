import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import { query, queryOne } from '../db/database.js';
import { logger } from '../config/logger.js';

/**
 * express-rate-limit store kept in Postgres (db/migrations/035_rate_limit_hits.sql),
 * so every API instance counts against the same buckets. The default memory
 * store gives each instance its own, multiplying every limit by the number of
 * instances and resetting on every deploy.
 *
 * One upsert per counted request: a row whose window has passed restarts at 1.
 */
export class PostgresRateLimitStore implements Store {
  /** Keys are shared across instances; tells express-rate-limit not to assume otherwise. */
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(name: string) {
    this.prefix = `${name}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const row = await queryOne<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limit_hits (key, hits, reset_at)
       VALUES ($1, 1, NOW() + make_interval(secs => $2::double precision / 1000))
       ON CONFLICT (key) DO UPDATE SET
         hits     = CASE WHEN rate_limit_hits.reset_at <= NOW() THEN 1 ELSE rate_limit_hits.hits + 1 END,
         reset_at = CASE WHEN rate_limit_hits.reset_at <= NOW() THEN EXCLUDED.reset_at ELSE rate_limit_hits.reset_at END
       RETURNING hits, reset_at`,
      [this.prefix + key, this.windowMs],
    );
    if (Math.random() < 0.01) sweepExpired();
    return { totalHits: row!.hits, resetTime: row!.reset_at };
  }

  async decrement(key: string): Promise<void> {
    await query(`UPDATE rate_limit_hits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND reset_at > NOW()`, [this.prefix + key]);
  }

  async resetKey(key: string): Promise<void> {
    await query(`DELETE FROM rate_limit_hits WHERE key = $1`, [this.prefix + key]);
  }
}

/** Drops finished windows, now and then, off the request path. */
function sweepExpired(): void {
  query(`DELETE FROM rate_limit_hits WHERE reset_at <= NOW()`).catch((error: unknown) => {
    logger.warn({ err: error }, 'rate limit sweep failed');
  });
}

import pg from 'pg';
// pg is CommonJS: runtime values come off the default import, types come from
// named type imports. Using the default import as a type namespace would not
// compile.
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env, isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Connection to the existing institutional database.
 *
 * This service does not create, migrate or own the schema — it connects to a
 * database that is already there and issues queries against it. There is no
 * migration tooling here on purpose.
 */

const { Pool: PgPool } = pg;

/**
 * Postgres returns BIGINT and NUMERIC as strings by default, because they can
 * exceed IEEE-754 precision. Counts from COUNT(*) are small and are far more
 * useful as numbers, so BIGINT is parsed. NUMERIC is deliberately left as a
 * string — silently rounding money or attendance percentages would be worse
 * than handling a string.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

export const pool: Pool = new PgPool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
  // A query that hangs must not hold a pooled connection open forever.
  statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: !env.DATABASE_SSL_ALLOW_SELF_SIGNED } } : {}),
});

// An idle client erroring (a dropped connection, a server restart) is emitted
// on the pool. Without a listener, Node treats it as an unhandled 'error'
// event and terminates the process.
pool.on('error', (error) => {
  logger.error({ err: error }, 'idle database client error');
});

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<PoolClient, 'query'>;

/**
 * Runs a parameterised query.
 *
 * Values are ALWAYS passed as parameters, never interpolated into the SQL
 * string — that is what makes injection impossible rather than merely unlikely.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client: Queryable = pool,
): Promise<QueryResult<T>> {
  const startedAt = performance.now();
  try {
    const result = await client.query<T>(text, params as unknown[]);
    if (!isProduction) {
      logger.debug(
        { sql: collapse(text), rows: result.rowCount, durationMs: round(performance.now() - startedAt) },
        'query',
      );
    }
    return result;
  } catch (error) {
    // The SQL is logged, the parameters are not — they hold password hashes,
    // email addresses and token hashes.
    logger.error({ err: error, sql: collapse(text) }, 'query failed');
    throw error;
  }
}

/** Returns the first row, or null when the query matched nothing. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client: Queryable = pool,
): Promise<T | null> {
  const result = await query<T>(text, params, client);
  return result.rows[0] ?? null;
}

/**
 * Runs `work` inside a transaction, committing on success and rolling back on
 * any thrown error. The client is always released, including when the rollback
 * itself fails — a leaked client would eventually exhaust the pool.
 */
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres SQLSTATE codes this service reacts to by name rather than by number. */
export const PgErrorCode = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_COLUMN: '42703',
  QUERY_CANCELED: '57014',
} as const;

export interface PostgresError extends Error {
  code: string;
  /** Name of the constraint that failed, when the server reports one. */
  constraint?: string;
  detail?: string;
  table?: string;
}

export function isPostgresError(error: unknown): error is PostgresError {
  return error instanceof Error && typeof (error as PostgresError).code === 'string';
}

export function isUniqueViolation(error: unknown): error is PostgresError {
  return isPostgresError(error) && error.code === PgErrorCode.UNIQUE_VIOLATION;
}

/**
 * Verifies the database is reachable and that the tables this service queries
 * actually exist. Called at boot so a missing table fails loudly at startup
 * rather than as a 500 on the first registration.
 */
export async function verifyDatabaseConnection(): Promise<void> {
  const required = ['users', 'lecturer_profiles', 'email_verification_tokens', 'audit_logs'];

  const result = await query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [required],
  );

  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = required.filter((table) => !found.has(table));

  if (missing.length > 0) {
    throw new Error(
      `The database is reachable but is missing tables this service queries: ${missing.join(', ')}. ` +
        `This service does not create the schema — see docs/expected-schema.md for what it expects.`,
    );
  }

  logger.info({ tables: required.length }, 'database connected and schema verified');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  logger.info('database pool closed');
}

const collapse = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const round = (ms: number): number => Math.round(ms * 100) / 100;

-- Rate-limit counters shared by every API instance (src/middleware/rate-limit-store.ts).
-- One row per limiter and client key; a row past reset_at is a fresh window.
-- Expired rows are swept by the store, so the table stays small.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key       TEXT PRIMARY KEY,                  -- "<limiter>:<client key>"
  hits      INTEGER NOT NULL CHECK (hits >= 0),
  reset_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_reset_idx ON rate_limit_hits (reset_at);

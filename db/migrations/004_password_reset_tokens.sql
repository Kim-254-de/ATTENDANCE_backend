-- Password reset (README section 4.1: "support password reset through a verified email address").
-- The API service never runs this; apply it with `npm run db:migrate`.

-- Only the SHA-256 hash of the token is stored. The plaintext exists in exactly
-- one place -- the email -- so a database leak cannot be replayed to seize an
-- account. SHA-256 is adequate here: unlike a password, the token is 256 bits
-- of uniform randomness and is not brute-forceable.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,            -- SHA-256 hex
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,                            -- set when the reset completes
  -- Set when a newer request supersedes this one, so only the most recent link
  -- in someone's inbox works.
  invalidated_at TIMESTAMPTZ,
  requested_ip  VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports both the "supersede my older tokens" update and reset-history lookups.
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id, created_at DESC);

-- Lets expired rows be swept without scanning the table.
CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

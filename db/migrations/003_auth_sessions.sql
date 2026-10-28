-- Server-side sessions. The access token (short-lived JWT) carries the session id;
-- the refresh token's hash lives here so it can be rotated, revoked on sign-out,
-- and a replayed (stolen) refresh token can be detected.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  VARCHAR(64) NOT NULL,           -- SHA-256 hex of the current refresh token
  ip_address          VARCHAR(64),
  user_agent          TEXT,
  expires_at          TIMESTAMPTZ NOT NULL,           -- absolute end of the session
  revoked_at          TIMESTAMPTZ,                    -- set on sign-out / reuse detection / suspension
  revoked_reason      VARCHAR(64),
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;

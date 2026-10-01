-- Tables the auth module queries. Matches docs/expected-schema.md.
-- The API service itself never runs this; apply it with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  VARCHAR(255) NOT NULL UNIQUE,
  password_hash          VARCHAR(255) NOT NULL,           -- Argon2id, never plaintext
  full_name              VARCHAR(160) NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('LECTURER','STUDENT','ADMIN')),
  status                 TEXT NOT NULL CHECK (status IN
                           ('PENDING_VERIFICATION','PENDING_APPROVAL','ACTIVE','SUSPENDED','DEACTIVATED')),
  email_verified_at      TIMESTAMPTZ,
  failed_login_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until           TIMESTAMPTZ,
  last_login_at          TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at             TIMESTAMPTZ,                     -- soft delete: attendance history outlives accounts
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE INDEX IF NOT EXISTS users_role_status_idx ON users (role, status);

CREATE TABLE IF NOT EXISTS lecturer_profiles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  staff_number     VARCHAR(64) NOT NULL UNIQUE,           -- stored uppercased
  title            VARCHAR(32),
  department       VARCHAR(160),
  faculty          VARCHAR(160),
  phone            VARCHAR(32),
  erp_staff_id     VARCHAR(128),
  erp_verified_at  TIMESTAMPTZ NOT NULL,
  erp_snapshot     JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lecturer_profiles_staff_upper CHECK (staff_number = upper(staff_number))
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    VARCHAR(64) NOT NULL UNIQUE,              -- SHA-256 hex
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- Append-only. A rejected registration writes here even though no user row exists.
CREATE TABLE IF NOT EXISTS audit_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action                TEXT NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE')),
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  subject_email         VARCHAR(255),
  subject_staff_number  VARCHAR(64),
  erp_outcome           TEXT CHECK (erp_outcome IN ('VERIFIED','NOT_FOUND','INACTIVE','IDENTITY_MISMATCH','UNAVAILABLE')),
  reason                VARCHAR(255),
  ip_address            VARCHAR(64),
  user_agent            TEXT,
  request_id            VARCHAR(64),
  metadata              JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx    ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_staff_idx   ON audit_logs (subject_staff_number, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx  ON audit_logs (action, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS users_updated ON users;
CREATE TRIGGER users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS lecturer_profiles_updated ON lecturer_profiles;
CREATE TRIGGER lecturer_profiles_updated BEFORE UPDATE ON lecturer_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Audit rows must never be edited or removed.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_logs_no_change ON audit_logs;
CREATE TRIGGER audit_logs_no_change BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

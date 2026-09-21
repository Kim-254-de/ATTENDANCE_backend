-- Attendance system schema. Idempotent: safe to run on every start.
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive text for ids

-- ---------------------------------------------------------------
-- MOCK UNIVERSITY ERP (stand-in until real ERP access exists)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS erp_students (
  reg_number     CITEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  programme      TEXT,
  year_of_study  SMALLINT CHECK (year_of_study BETWEEN 1 AND 8),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','deferred','graduated','discontinued')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp_staff (
  staff_number   CITEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  department     TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','left','suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erp_students_name_idx ON erp_students (lower(full_name));
CREATE INDEX IF NOT EXISTS erp_staff_name_idx    ON erp_staff (lower(full_name));

-- Keep updated_at current on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS erp_students_updated ON erp_students;
CREATE TRIGGER erp_students_updated BEFORE UPDATE ON erp_students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS erp_staff_updated ON erp_staff;
CREATE TRIGGER erp_staff_updated BEFORE UPDATE ON erp_staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------
-- LECTURER SIGN-UP / SIGN-IN  (blueprint §3.1, §4.1)
-- ---------------------------------------------------------------
-- staff_number is validated against the ERP at registration time (erpService.lookupStaff),
-- deliberately NOT a foreign key: the ERP is an external system, so the mock tables
-- can be swapped for the real ERP without touching this table.
CREATE TABLE IF NOT EXISTS lecturers (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name             TEXT    NOT NULL,
  email                 CITEXT  NOT NULL UNIQUE,
  staff_number          CITEXT  NOT NULL UNIQUE,
  password_hash         TEXT    NOT NULL,             -- bcrypt/argon2 hash, never plain text

  -- account status: pending until email verified + admin approves
  status                TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','suspended','deactivated')),
  email_verified_at     TIMESTAMPTZ,
  approved_at           TIMESTAMPTZ,
  approved_by           BIGINT,                       -- future admins.id (no FK until that table exists)
  status_reason         TEXT,                         -- why suspended/deactivated

  -- brute-force protection (blueprint: repeated failed sign-ins are rate-limited)
  failed_login_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lecturers_email_format CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE INDEX IF NOT EXISTS lecturers_status_idx ON lecturers (status);

DROP TRIGGER IF EXISTS lecturers_updated ON lecturers;
CREATE TRIGGER lecturers_updated BEFORE UPDATE ON lecturers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time tokens for email verification and password reset.
-- Only a hash of the token is stored; the raw token goes in the email link.
CREATE TABLE IF NOT EXISTS lecturer_tokens (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lecturer_id   BIGINT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  purpose       TEXT   NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  token_hash    TEXT   NOT NULL UNIQUE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lecturer_tokens_lookup_idx ON lecturer_tokens (lecturer_id, purpose);

-- Server-side sessions so sign-out truly revokes access.
CREATE TABLE IF NOT EXISTS lecturer_sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lecturer_id   BIGINT NOT NULL REFERENCES lecturers(id) ON DELETE CASCADE,
  token_hash    TEXT   NOT NULL UNIQUE,               -- hash of the session/refresh token
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,                          -- set on sign-out
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS lecturer_sessions_lecturer_idx ON lecturer_sessions (lecturer_id);

-- Every sign-in attempt (success or failure): drives rate limiting and audit.
-- `identifier` is what was typed (staff number or email), kept even if no account matches.
CREATE TABLE IF NOT EXISTS lecturer_login_attempts (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lecturer_id   BIGINT REFERENCES lecturers(id) ON DELETE SET NULL,
  identifier    CITEXT NOT NULL,
  ip_address    INET,
  success       BOOLEAN NOT NULL,
  failure_reason TEXT,
  attempted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lecturer_login_attempts_ident_idx ON lecturer_login_attempts (identifier, attempted_at DESC);
CREATE INDEX IF NOT EXISTS lecturer_login_attempts_ip_idx    ON lecturer_login_attempts (ip_address, attempted_at DESC);

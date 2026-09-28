-- Student accounts (src/modules/auth: registerStudent, sign-in, /auth/me).
-- A student registers with their registration number, checked against the
-- student directory (SMARTTT when configured, otherwise the ERP), and is
-- ACTIVE once their email is confirmed: there is no admin approval step.
-- Their registration number is what links them to the unit rosters synced
-- from SMARTTT (unit_allocations.registration_number, linkAllocationsToStudent).
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS student_profiles (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  registration_number  VARCHAR(64) NOT NULL UNIQUE,          -- stored uppercased
  programme            VARCHAR(200),
  year_of_study        SMALLINT CHECK (year_of_study BETWEEN 1 AND 8),
  directory_source     TEXT NOT NULL CHECK (directory_source IN ('SMARTTT', 'ERP')),
  directory_verified_at TIMESTAMPTZ NOT NULL,
  directory_snapshot   JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT student_profiles_reg_upper CHECK (registration_number = upper(registration_number))
);

DROP TRIGGER IF EXISTS student_profiles_updated ON student_profiles;
CREATE TRIGGER student_profiles_updated BEFORE UPDATE ON student_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Rejected student registrations are audited with the registration number.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS subject_registration_number VARCHAR(64);
CREATE INDEX IF NOT EXISTS audit_logs_registration_idx
  ON audit_logs (subject_registration_number, created_at DESC);

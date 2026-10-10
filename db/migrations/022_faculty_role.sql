-- Faculty officers: the same oversight role as department.DEPARTMENT, one
-- level up — read-only across every department in one faculty.
--
-- The schema for this already exists (021_departments.sql's faculties table
-- and departments.faculty_id were built for exactly this milestone); this
-- migration only adds the role and its profile table.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- The role column's CHECK was written inline and unnamed in
-- 001_auth_schema.sql, so Postgres named it users_role_check.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('LECTURER','STUDENT','ADMIN','DEPARTMENT','FACULTY'));

-- A faculty officer: oversees every department in one faculty. Mirrors
-- department_profiles exactly — there is no ERP staff record to verify an
-- officer against, so they are provisioned directly
-- (scripts/dev-seed-faculty.mjs locally) and there is no self-registration.
CREATE TABLE IF NOT EXISTS faculty_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  faculty_id  UUID NOT NULL REFERENCES faculties(id),
  title       VARCHAR(32),
  phone       VARCHAR(32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS faculty_profiles_faculty_idx ON faculty_profiles (faculty_id);

DROP TRIGGER IF EXISTS faculty_profiles_updated ON faculty_profiles;
CREATE TRIGGER faculty_profiles_updated BEFORE UPDATE ON faculty_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

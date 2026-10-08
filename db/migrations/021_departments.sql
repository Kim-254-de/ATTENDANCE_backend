-- Departments as real rows, and the department-officer role that oversees one.
--
-- "Department" has only ever been free text: lecturer_profiles.department and
-- .faculty are VARCHAR(160) written verbatim from the ERP lookup at
-- registration (auth.service.ts). That is fine for printing on a profile, but
-- nothing can be *scoped* to a department that way — two spellings of the same
-- department are two departments, and there is nowhere to hang a department's
-- own staff off. A faculty-level role is the next milestone and would have the
-- same problem one level up, so both are normalised here.
--
-- The free-text columns STAY. The ERP sync still writes them on every
-- registration and profile refresh, and nothing in this migration changes that;
-- department_id is the normalised key beside them, backfilled by name.
--
-- units deliberately gets NO department_id: a unit's department is its
-- lecturer's (units.lecturer_user_id -> lecturer_profiles.user_id ->
-- department_id). Storing it twice would let the two disagree the first time a
-- unit changes hands.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS faculties (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(160) NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(160) NOT NULL UNIQUE,
  -- Nullable: the ERP names a department for every lecturer but not always a
  -- faculty, so a backfilled department can legitimately have no faculty yet.
  faculty_id  UUID REFERENCES faculties(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS departments_faculty_idx ON departments (faculty_id);

-- Backfill from what the ERP has already written, so existing lecturers land in
-- their department without a manual data entry pass.
INSERT INTO faculties (name)
SELECT DISTINCT faculty FROM lecturer_profiles
 WHERE faculty IS NOT NULL AND faculty <> ''
ON CONFLICT (name) DO NOTHING;

-- DISTINCT ON, not plain DISTINCT: the same department spelled against two
-- different faculties would otherwise offer two rows for one unique name and
-- let ON CONFLICT pick arbitrarily. First non-null faculty wins, deterministically.
INSERT INTO departments (name, faculty_id)
SELECT DISTINCT ON (lp.department) lp.department, f.id
  FROM lecturer_profiles lp
  LEFT JOIN faculties f ON f.name = lp.faculty
 WHERE lp.department IS NOT NULL AND lp.department <> ''
 ORDER BY lp.department, f.id NULLS LAST
ON CONFLICT (name) DO NOTHING;

ALTER TABLE lecturer_profiles ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id);
UPDATE lecturer_profiles lp
   SET department_id = d.id
  FROM departments d
 WHERE d.name = lp.department AND lp.department_id IS NULL;
-- Every department query starts by selecting the department's lecturers, the
-- same way units_lecturer_idx backs every "this lecturer's units" query.
CREATE INDEX IF NOT EXISTS lecturer_profiles_department_idx ON lecturer_profiles (department_id);

-- A department officer: the person who oversees one department's teaching.
-- Mirrors lecturer_profiles minus the ERP columns — there is no ERP staff
-- record to verify an officer against, so they are provisioned directly
-- (scripts/dev-seed-department.mjs locally) and there is no self-registration.
CREATE TABLE IF NOT EXISTS department_profiles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  department_id  UUID NOT NULL REFERENCES departments(id),
  title          VARCHAR(32),
  phone          VARCHAR(32),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS department_profiles_department_idx ON department_profiles (department_id);

-- The role column's CHECK was written inline and unnamed in
-- 001_auth_schema.sql, so Postgres named it users_role_check.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('LECTURER','STUDENT','ADMIN','DEPARTMENT'));

-- Lecturer punctuality: when the scheduled meeting this session was activated
-- inside was due to start, captured at activation (session.service.ts
-- resolveWindow) the same way room_code is. Null for a session with no
-- schedule behind it (legacy units, client-supplied closesAt) — there is
-- nothing to compare those against, so they are excluded from every
-- timekeeping figure rather than counted as on time.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;

DROP TRIGGER IF EXISTS faculties_updated ON faculties;
CREATE TRIGGER faculties_updated BEFORE UPDATE ON faculties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS departments_updated ON departments;
CREATE TRIGGER departments_updated BEFORE UPDATE ON departments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS department_profiles_updated ON department_profiles;
CREATE TRIGGER department_profiles_updated BEFORE UPDATE ON department_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

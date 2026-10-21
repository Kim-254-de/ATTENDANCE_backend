-- Quality Assurance officers: an institution-wide role that runs internal
-- audits against every department/faculty, tracks findings and corrective
-- actions, and reports compliance KPIs.
--
-- Unlike department_profiles/faculty_profiles, qa_profiles has no
-- department/faculty FK — a QA officer's remit is the whole institution, not
-- one org unit, so there is nothing to scope the row to. Provisioned
-- directly (scripts/dev-seed-qa.mjs locally); no self-registration.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- The role column's CHECK was written inline and unnamed in
-- 001_auth_schema.sql, so Postgres named it users_role_check.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('LECTURER','STUDENT','ADMIN','DEPARTMENT','FACULTY','QA'));

CREATE TABLE IF NOT EXISTS qa_profiles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(32),
  phone       VARCHAR(32),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS qa_profiles_updated ON qa_profiles;
CREATE TRIGGER qa_profiles_updated BEFORE UPDATE ON qa_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

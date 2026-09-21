CREATE EXTENSION IF NOT EXISTS citext;

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
  email          TEXT,
  department     TEXT,
  faculty        TEXT,
  title          TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','left','suspended')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_students_name_idx ON erp_students (lower(full_name));
CREATE INDEX IF NOT EXISTS erp_staff_name_idx    ON erp_staff (lower(full_name));

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS erp_students_updated ON erp_students;
CREATE TRIGGER erp_students_updated BEFORE UPDATE ON erp_students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS erp_staff_updated ON erp_staff;
CREATE TRIGGER erp_staff_updated BEFORE UPDATE ON erp_staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();

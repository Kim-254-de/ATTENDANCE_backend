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
-- The institution's issued timetable: one row per course, who it's assigned to
-- teach, and its weekly meeting slot. The application's unit module looks a
-- code up here instead of taking a lecturer's word for the name/schedule.
CREATE TABLE IF NOT EXISTS erp_courses (
  code           CITEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  -- Null when the timetable has nobody assigned yet; not a FK so a course can
  -- be seeded before its lecturer is, same as unit_allocations.registration_number.
  staff_number   CITEXT,
  day_of_week    SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun..6=Sat
  start_time     TIME NOT NULL,
  end_time       TIME NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','inactive')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT erp_courses_window CHECK (end_time > start_time)
);
-- Who's enrolled in each course — the registrar's real class list. The
-- application's unit module syncs a unit's roster from here on view instead
-- of letting a lecturer add students or a student self-enrol.
CREATE TABLE IF NOT EXISTS erp_enrollments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_code  CITEXT NOT NULL,
  reg_number   CITEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT erp_enrollments_uq UNIQUE (course_code, reg_number)
);
CREATE INDEX IF NOT EXISTS erp_students_name_idx ON erp_students (lower(full_name));
CREATE INDEX IF NOT EXISTS erp_staff_name_idx    ON erp_staff (lower(full_name));
CREATE INDEX IF NOT EXISTS erp_courses_staff_idx ON erp_courses (staff_number);
CREATE INDEX IF NOT EXISTS erp_enrollments_course_idx ON erp_enrollments (course_code);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS erp_students_updated ON erp_students;
CREATE TRIGGER erp_students_updated BEFORE UPDATE ON erp_students FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS erp_staff_updated ON erp_staff;
CREATE TRIGGER erp_staff_updated BEFORE UPDATE ON erp_staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS erp_courses_updated ON erp_courses;
CREATE TRIGGER erp_courses_updated BEFORE UPDATE ON erp_courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

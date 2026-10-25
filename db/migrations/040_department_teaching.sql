-- What each department teaches in a term of the Timetable Generator, entered
-- by its officers here (it used to be the separate Timetable Allocator): its
-- courses (cohorts, which become the Generator's class rows), its units with
-- the courses that take them, and each unit's groups, each with its lecturer.
-- An officer publishes the department's list to the Director, which locks it
-- until an officer reopens it; the Generator imports what is published
-- (GET /integrations/generator/terms/:termId/submissions).
--
-- Terms are the Generator's: `generator_term_id` is its id, not a foreign key.
-- Lecturers are each department's own list (title, name, staff number, FT/PT,
-- weekly hour limit), not attendance accounts: a part-timer without an
-- account can teach. The staff number is how the same person is known on
-- another department's list, by the Generator's solver and by SMARTTT.
--
-- Replaces course_offerings (023) as how a department allocates lecturers;
-- that table is left in place because units.offering_id still points at it.
--
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS teaching_lecturers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id     UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  title             VARCHAR(30) NOT NULL DEFAULT '',
  full_name         VARCHAR(255) NOT NULL,
  staff_number      VARCHAR(64),
  employment_type   VARCHAR(10) NOT NULL DEFAULT 'full_time' CHECK (employment_type IN ('full_time', 'part_time')),
  phone             VARCHAR(40) NOT NULL DEFAULT '',
  email             VARCHAR(255) NOT NULL DEFAULT '',
  max_weekly_hours  INTEGER CHECK (max_weekly_hours BETWEEN 1 AND 60),
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS teaching_lecturers_department_idx ON teaching_lecturers (department_id);
-- One person per staff number on a department's list (stored upper case).
CREATE UNIQUE INDEX IF NOT EXISTS teaching_lecturers_staff_number_uq
  ON teaching_lecturers (department_id, staff_number) WHERE staff_number IS NOT NULL;

-- A cohort: programme + year + study semester (+ sub-class), e.g.
-- "BSC.CS Y1S1, 120 students". Entered once per term, by its department;
-- every department reads every course, to pick one for a unit it services.
CREATE TABLE IF NOT EXISTS teaching_courses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generator_term_id  VARCHAR(64) NOT NULL,
  department_id      UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  programme          VARCHAR(64) NOT NULL,
  year               INTEGER NOT NULL CHECK (year BETWEEN 1 AND 7),
  semester           INTEGER NOT NULL CHECK (semester BETWEEN 1 AND 3),
  sub_class          VARCHAR(10) NOT NULL DEFAULT '',
  students           INTEGER NOT NULL CHECK (students BETWEEN 1 AND 5000),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teaching_courses_cohort_uq UNIQUE (generator_term_id, programme, year, semester, sub_class)
);
CREATE INDEX IF NOT EXISTS teaching_courses_department_idx ON teaching_courses (generator_term_id, department_id);

-- A unit a department teaches this term, entered once per term by the
-- department that owns it. `code_key` is the code without spaces or
-- punctuation, upper case: 'COSC 103' and 'cosc103' are one unit.
CREATE TABLE IF NOT EXISTS teaching_units (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generator_term_id    VARCHAR(64) NOT NULL,
  department_id        UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  code                 VARCHAR(64) NOT NULL,
  code_key             VARCHAR(64) NOT NULL,
  title                VARCHAR(255) NOT NULL,
  weekly_hours         INTEGER NOT NULL CHECK (weekly_hours BETWEEN 1 AND 20),
  class_length         INTEGER NOT NULL CHECK (class_length BETWEEN 1 AND 6),
  room_type            VARCHAR(20) NOT NULL DEFAULT 'lecture_hall' CHECK (room_type IN ('lecture_hall', 'lab', 'seminar')),
  -- What the unit was when the department last published (a hash); null
  -- until then. A unit that differs is "changed since published".
  published_signature  VARCHAR(64),
  entered_by_name      VARCHAR(255) NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teaching_units_code_uq UNIQUE (generator_term_id, code_key)
);
CREATE INDEX IF NOT EXISTS teaching_units_department_idx ON teaching_units (generator_term_id, department_id);

-- Which courses take a unit (its own department's or, servicing, another's).
CREATE TABLE IF NOT EXISTS teaching_unit_courses (
  unit_id    UUID NOT NULL REFERENCES teaching_units(id) ON DELETE CASCADE,
  course_id  UUID NOT NULL REFERENCES teaching_courses(id) ON DELETE RESTRICT,
  PRIMARY KEY (unit_id, course_id)
);
CREATE INDEX IF NOT EXISTS teaching_unit_courses_course_idx ON teaching_unit_courses (course_id);

-- One class of a unit: the whole class (label '') or one group of a split
-- ('GR A'), its lecturer and the allocation form's L/P/CF semester hours.
CREATE TABLE IF NOT EXISTS teaching_groups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id          UUID NOT NULL REFERENCES teaching_units(id) ON DELETE CASCADE,
  label            VARCHAR(50) NOT NULL DEFAULT '',
  lecturer_id      UUID REFERENCES teaching_lecturers(id) ON DELETE RESTRICT,
  lecture_hours    NUMERIC(6, 1),
  practical_hours  NUMERIC(6, 1),
  cf_hours         NUMERIC(6, 1),
  CONSTRAINT teaching_groups_label_uq UNIQUE (unit_id, label)
);
CREATE INDEX IF NOT EXISTS teaching_groups_lecturer_idx ON teaching_groups (lecturer_id);

-- A course in a group; `students` is its share when the course is split
-- between groups, else null (the whole course).
CREATE TABLE IF NOT EXISTS teaching_group_members (
  group_id   UUID NOT NULL REFERENCES teaching_groups(id) ON DELETE CASCADE,
  course_id  UUID NOT NULL REFERENCES teaching_courses(id) ON DELETE RESTRICT,
  students   INTEGER CHECK (students BETWEEN 1 AND 5000),
  PRIMARY KEY (group_id, course_id)
);
CREATE INDEX IF NOT EXISTS teaching_group_members_course_idx ON teaching_group_members (course_id);

-- An officer publishing the department's teaching for a term to the
-- Director. While one stands (not reopened) the department's courses, units
-- and groups are locked.
CREATE TABLE IF NOT EXISTS teaching_publications (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generator_term_id      VARCHAR(64) NOT NULL,
  department_id          UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  published_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  published_by_name      VARCHAR(255) NOT NULL,
  published_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  unit_count             INTEGER NOT NULL,
  group_count            INTEGER NOT NULL,
  reopened_at            TIMESTAMPTZ,
  reopened_by_name       VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS teaching_publications_department_idx
  ON teaching_publications (generator_term_id, department_id, published_at DESC);

DROP TRIGGER IF EXISTS teaching_lecturers_updated ON teaching_lecturers;
CREATE TRIGGER teaching_lecturers_updated BEFORE UPDATE ON teaching_lecturers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS teaching_courses_updated ON teaching_courses;
CREATE TRIGGER teaching_courses_updated BEFORE UPDATE ON teaching_courses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS teaching_units_updated ON teaching_units;
CREATE TRIGGER teaching_units_updated BEFORE UPDATE ON teaching_units FOR EACH ROW EXECUTE FUNCTION set_updated_at();

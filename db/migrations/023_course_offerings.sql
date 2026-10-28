-- A course before it has a lecturer: faculty provides it to a department,
-- the department decides how many sections it needs and assigns one of its
-- own lecturers to each — the moment that happens, the usual `units` row is
-- created and everything downstream (session activation, attendance,
-- department/faculty oversight) works exactly as it already does, because
-- it's built on the same base_code/class_group split-unit mechanism SMARTTT's
-- own grouped units already use (db/migrations/011_units_timetable_sync.sql).
--
-- units.lecturer_user_id stays NOT NULL on purpose: a unit row is only ever
-- created once a lecturer is attached (allocateLecturerToSegment), so no
-- existing query anywhere has to learn about a unit with no lecturer yet —
-- that state lives entirely in course_offerings, not in units.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS course_offerings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Same format as units.code, and the same global uniqueness: this becomes
  -- a units.code (or units.base_code, once split) the moment a segment fills.
  code                VARCHAR(32) NOT NULL UNIQUE,
  name                VARCHAR(200),
  department_id       UUID NOT NULL REFERENCES departments(id),
  -- How many lecturer-taught sections this course needs, e.g. 7 for
  -- "CSC102 GR A".."GR G". The department's call, not the faculty's.
  segments_planned    INTEGER NOT NULL DEFAULT 1 CHECK (segments_planned BETWEEN 1 AND 26),
  -- The faculty officer who provided it. Kept for traceability only — no
  -- query is scoped by it; department_id -> faculty_id is the real scope.
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS course_offerings_department_idx ON course_offerings (department_id);

-- Which offering a unit came from, so "3 of 7 segments filled" can be
-- counted. Null for every unit created the old way (lecturer-added or
-- SMARTTT-synced) — this column is additive, nothing existing is touched.
ALTER TABLE units ADD COLUMN IF NOT EXISTS offering_id UUID REFERENCES course_offerings(id);
CREATE INDEX IF NOT EXISTS units_offering_idx ON units (offering_id);

DROP TRIGGER IF EXISTS course_offerings_updated ON course_offerings;
CREATE TRIGGER course_offerings_updated BEFORE UPDATE ON course_offerings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

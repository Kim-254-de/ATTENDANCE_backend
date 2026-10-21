-- Faculties and departments belong to SMARTTT.
--
-- SMARTTT (apps/departments) is the university's record of its faculties and
-- departments; attendance kept its own list (021_departments.sql), so the two
-- drifted. Attendance now keeps a copy linked by SMARTTT's id: new ones are
-- created in SMARTTT first (an administrator adding a faculty, a faculty
-- officer adding a department), and SMARTTT's list is read back regularly
-- (src/modules/directory). Officers, terminals, course offerings and oversight
-- keep pointing at the local rows, unchanged.
--
-- NULL = not linked yet: a row created here before this change, linked by
-- name at the next sync or sent to SMARTTT by an administrator.
--
-- Apply with `npm run db:migrate`.

ALTER TABLE faculties ADD COLUMN IF NOT EXISTS smarttt_faculty_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS faculties_smarttt_faculty_id_key
  ON faculties (smarttt_faculty_id) WHERE smarttt_faculty_id IS NOT NULL;

ALTER TABLE departments ADD COLUMN IF NOT EXISTS smarttt_department_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS departments_smarttt_department_id_key
  ON departments (smarttt_department_id) WHERE smarttt_department_id IS NOT NULL;

-- Faculties play no part any more (the university confirmed it): departments
-- stand on their own, created by an administrator with a name and a code, and
-- the Timetable Allocator and Generator import them from here. SMARTTT drops
-- its faculties in the same change (departments 0002_no_faculties).
--
--   * departments lose faculty_id and gain `code` ("DCOMP"), unique across
--     the university, filled from SMARTTT by the directory sync;
--   * the FACULTY role, already shown as Management (038), becomes
--     MANAGEMENT: university-wide, so it needs no profile row at all;
--   * a QA audit targets one department; audits that targeted a faculty
--     have nothing left to point at and are deleted with their findings;
--   * lecturer_profiles.faculty (the faculty SMARTTT reported) goes;
--   * faculties and faculty_profiles are dropped.
--
-- Apply with `npm run db:migrate`.

-- QA audits of a faculty, and everything hanging off them (their findings,
-- and those findings' corrective actions, cascade).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'qa_audits' AND column_name = 'target_faculty_id') THEN
    DELETE FROM qa_audits WHERE target_faculty_id IS NOT NULL;
    ALTER TABLE qa_audits DROP CONSTRAINT IF EXISTS qa_audits_check;
    DROP INDEX IF EXISTS qa_audits_target_faculty_idx;
    ALTER TABLE qa_audits DROP COLUMN IF EXISTS target_faculty_id;
    ALTER TABLE qa_audits ALTER COLUMN target_department_id SET NOT NULL;
  END IF;
END $$;

-- Management: the faculty role, renamed, with no scope.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'MANAGEMENT' WHERE role = 'FACULTY';
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('LECTURER','STUDENT','ADMIN','DEPARTMENT','MANAGEMENT','QA'));
DROP TABLE IF EXISTS faculty_profiles;

-- Departments stand alone, known by a university-wide code.
DROP INDEX IF EXISTS departments_faculty_idx;
ALTER TABLE departments DROP COLUMN IF EXISTS faculty_id;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS code VARCHAR(32);
CREATE UNIQUE INDEX IF NOT EXISTS departments_code_key ON departments (upper(code)) WHERE code IS NOT NULL;

ALTER TABLE lecturer_profiles DROP COLUMN IF EXISTS faculty;

DROP TABLE IF EXISTS faculties;

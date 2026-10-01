-- Units and rosters synced from SMARTTT, the university timetable system
-- (unit.service.ts syncUnitsFromTimetable). SMARTTT says which classes a
-- lecturer is timetabled to teach and how many students are registered for
-- each; that count is stored here so the units page still shows it when
-- SMARTTT can't be reached.
--
-- A unit here is one CLASS: a unit plus its teaching group. Big common units
-- are split into groups taught by different lecturers (COSC 103 GR A, GR B,
-- GR P ...), and each group is its own row, so each lecturer owns their own
-- sessions, QR codes and roster. `code` is the class ("COSC 103 GR A", or
-- plain "COSC 103" when not split), `base_code` the unit and `class_group`
-- the group. Group names can make a code longer than 32 characters.
--
-- students_without_group: students registered for a split unit who haven't
-- picked their group in SMARTTT yet, so are on no group's roster.
-- Apply with `npm run db:migrate`.

ALTER TABLE units
  ALTER COLUMN code TYPE VARCHAR(80),
  ADD COLUMN IF NOT EXISTS base_code VARCHAR(80),
  ADD COLUMN IF NOT EXISTS class_group VARCHAR(50),
  ADD COLUMN IF NOT EXISTS registered_students INTEGER CHECK (registered_students >= 0),
  ADD COLUMN IF NOT EXISTS students_without_group INTEGER CHECK (students_without_group >= 0),
  ADD COLUMN IF NOT EXISTS timetable_synced_at TIMESTAMPTZ;

-- Rosters now come from SMARTTT's registrations too (unit.repository.ts
-- syncRosterAllocations): each registered student's registration number and
-- name. 'SMARTTT' joins the allowed sources; 'ERP' stays for the ERP sync
-- used when SMARTTT is not configured.
ALTER TABLE unit_allocations DROP CONSTRAINT IF EXISTS unit_allocations_source_check;
ALTER TABLE unit_allocations
  ADD CONSTRAINT unit_allocations_source_check
  CHECK (source IN ('LECTURER', 'SELF_ENROLLED', 'ERP', 'SMARTTT'));

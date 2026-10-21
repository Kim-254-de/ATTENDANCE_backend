-- A unit belongs to the department that owns its curriculum, not to whoever
-- happens to teach it.
--
-- 021_departments.sql deliberately gave units no department column: a unit's
-- department was its lecturer's. That breaks service teaching (Basic Sciences
-- lecturers teaching maths to Computer Science students count under Basic
-- Sciences) and makes cross-department allocation impossible. From here on
-- units.department_id is the owning department, and every department,
-- faculty and QA figure is scoped by it.
--
-- Where it comes from:
--   - A unit allocated from a course offering: the offering's department.
--   - Any other unit (lecturer-added, SMARTTT-synced): its lecturer's
--     department at the time it is created, filled in by the trigger below so
--     no insert site has to remember. If the lecturer has no department yet,
--     the unit stays NULL until they get one (second trigger).
--   - Moving a lecturer to another department does NOT move their units: the
--     curriculum's owner has not changed, only who teaches it.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

ALTER TABLE units ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id);
CREATE INDEX IF NOT EXISTS units_department_idx ON units (department_id);

-- Backfill: offering first (that is an explicit statement of ownership), then
-- the lecturer's department, which is what every figure used until now.
UPDATE units u
   SET department_id = co.department_id
  FROM course_offerings co
 WHERE co.id = u.offering_id AND u.department_id IS NULL;

UPDATE units u
   SET department_id = lp.department_id
  FROM lecturer_profiles lp
 WHERE lp.user_id = u.lecturer_user_id AND u.department_id IS NULL AND lp.department_id IS NOT NULL;

CREATE OR REPLACE FUNCTION units_default_department() RETURNS trigger AS $$
BEGIN
  IF NEW.department_id IS NULL THEN
    SELECT department_id INTO NEW.department_id FROM lecturer_profiles WHERE user_id = NEW.lecturer_user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS units_default_department ON units;
CREATE TRIGGER units_default_department BEFORE INSERT ON units
  FOR EACH ROW EXECUTE FUNCTION units_default_department();

-- A lecturer who signed in before their department existed has units with no
-- department. The moment they are linked to one, those units follow; units
-- that already have an owner are left alone.
CREATE OR REPLACE FUNCTION lecturer_department_claims_units() RETURNS trigger AS $$
BEGIN
  IF NEW.department_id IS NOT NULL AND NEW.department_id IS DISTINCT FROM OLD.department_id THEN
    UPDATE units SET department_id = NEW.department_id
     WHERE lecturer_user_id = NEW.user_id AND department_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lecturer_department_claims_units ON lecturer_profiles;
CREATE TRIGGER lecturer_department_claims_units AFTER UPDATE OF department_id ON lecturer_profiles
  FOR EACH ROW EXECUTE FUNCTION lecturer_department_claims_units();

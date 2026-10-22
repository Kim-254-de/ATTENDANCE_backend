-- The catalog of quality standards the institution is assessed against,
-- grouped into the eight categories a typical national QA framework covers
-- (governance, academic programs, staff, students, facilities, finance,
-- research, community engagement). Checklist items (029) each map to one
-- standard, so every audit finding can be rolled up by standard and by
-- category on the KPI dashboard.
--
-- No delete endpoint will ever exist for a standard that has been used in an
-- audit — deactivate via is_active, the same "kept, not deleted" convention
-- unit_allocations.status uses, since removing one would orphan historical
-- findings' meaning.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_standards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(32) NOT NULL UNIQUE,
  category      VARCHAR(40) NOT NULL CHECK (category IN (
                   'GOVERNANCE','ACADEMIC_PROGRAMS','STAFF','STUDENTS',
                   'FACILITIES','FINANCE','RESEARCH','COMMUNITY_ENGAGEMENT'
                 )),
  title         VARCHAR(200) NOT NULL,
  description   TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS qa_standards_category_idx ON qa_standards (category);

DROP TRIGGER IF EXISTS qa_standards_updated ON qa_standards;
CREATE TRIGGER qa_standards_updated BEFORE UPDATE ON qa_standards FOR EACH ROW EXECUTE FUNCTION set_updated_at();

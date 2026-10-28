-- ODEL and part-time students sit papers of their own: the same unit can have
-- a regular paper and an ODEL paper ("MATH 241" and "MATH 241 odel" in the
-- departments' moderation letters), each a separate draft, sat by separate
-- classes. A paper's sitting says which: 'regular' papers are sat by the
-- unit's regular, evening, weekend and school-based classes, 'odel' papers by
-- its ODEL and part-time classes. A unit is on at most one paper per sitting.
--
-- Apply with `npm run db:migrate`.

ALTER TABLE teaching_exam_papers ADD COLUMN IF NOT EXISTS sitting VARCHAR(10) NOT NULL DEFAULT 'regular'
  CHECK (sitting IN ('regular', 'odel'));

-- Copied from the paper so a unit's uniqueness can be per sitting.
ALTER TABLE teaching_exam_paper_units ADD COLUMN IF NOT EXISTS sitting VARCHAR(10) NOT NULL DEFAULT 'regular'
  CHECK (sitting IN ('regular', 'odel'));
ALTER TABLE teaching_exam_paper_units DROP CONSTRAINT IF EXISTS teaching_exam_paper_units_unit_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS teaching_exam_paper_units_unit_sitting_idx ON teaching_exam_paper_units (unit_id, sitting);

-- What departments enter for the exam timetable (it used to be the Timetable
-- Allocator's, like 040's teaching): each department's written exam papers,
-- built from its units, with an examiner each; units with no written exam;
-- practicals on dates the department sets; and, once the Director shares an
-- exam draft from the Generator, who invigilates each paper. Exam papers and
-- invigilators are published to the Director separately from the teaching,
-- each locking its own list (teaching_publications.kind).
--
-- Also: how a cohort studies (an ODEL class sits its exams in a room of its
-- own), and how many invigilation duties a lecturer can take.
--
-- Apply with `npm run db:migrate`.

ALTER TABLE teaching_courses ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'regular'
  CHECK (mode IN ('regular', 'odel', 'weekend', 'evening', 'school_based', 'part_time'));

-- Across every department's list for the same person (staff number), the smallest limit applies.
ALTER TABLE teaching_lecturers ADD COLUMN IF NOT EXISTS max_exam_duties INTEGER CHECK (max_exam_duties BETWEEN 1 AND 100);

ALTER TABLE teaching_publications ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'teaching'
  CHECK (kind IN ('teaching', 'exams', 'invigilators'));
DROP INDEX IF EXISTS teaching_publications_department_idx;
CREATE INDEX IF NOT EXISTS teaching_publications_kind_idx
  ON teaching_publications (generator_term_id, department_id, kind, published_at DESC);

-- One written paper. All groups of a unit sit one paper; one paper can carry
-- several units' codes ("BITE 131/COSC 130"). The department entering it owns
-- at least one of its units.
CREATE TABLE IF NOT EXISTS teaching_exam_papers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generator_term_id    VARCHAR(64) NOT NULL,
  department_id        UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  title                VARCHAR(255) NOT NULL,
  examiner_id          UUID REFERENCES teaching_lecturers(id) ON DELETE RESTRICT,
  notes                VARCHAR(500) NOT NULL DEFAULT '',
  -- What the paper was when last published (a hash); null until then.
  published_signature  VARCHAR(64),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS teaching_exam_papers_department_idx ON teaching_exam_papers (generator_term_id, department_id);
CREATE INDEX IF NOT EXISTS teaching_exam_papers_examiner_idx ON teaching_exam_papers (examiner_id);

-- A unit sat on a paper; unique per unit, so no unit is examined twice.
CREATE TABLE IF NOT EXISTS teaching_exam_paper_units (
  paper_id  UUID NOT NULL REFERENCES teaching_exam_papers(id) ON DELETE CASCADE,
  unit_id   UUID NOT NULL UNIQUE REFERENCES teaching_units(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, unit_id)
);

-- A unit with no written exam this term (a project, practical only...).
CREATE TABLE IF NOT EXISTS teaching_no_written_exams (
  unit_id  UUID PRIMARY KEY REFERENCES teaching_units(id) ON DELETE CASCADE
);

-- A practical exam on a date the department sets; the Generator only shows it.
CREATE TABLE IF NOT EXISTS teaching_practicals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  generator_term_id  VARCHAR(64) NOT NULL,
  department_id      UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  unit_id            UUID NOT NULL REFERENCES teaching_units(id) ON DELETE CASCADE,
  date               DATE NOT NULL,
  start_time         TIME NOT NULL,
  end_time           TIME NOT NULL CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS teaching_practicals_department_idx ON teaching_practicals (generator_term_id, department_id);

-- Who invigilates a paper of the Director's shared exam draft. `room` is ''
-- for the whole paper. Any department's lecturer can be named.
CREATE TABLE IF NOT EXISTS teaching_invigilations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id         UUID NOT NULL REFERENCES teaching_exam_papers(id) ON DELETE CASCADE,
  room             VARCHAR(30) NOT NULL DEFAULT '',
  lecturer_id      UUID NOT NULL REFERENCES teaching_lecturers(id) ON DELETE RESTRICT,
  entered_by_name  VARCHAR(255) NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teaching_invigilations_paper_room_uq UNIQUE (paper_id, room)
);
CREATE INDEX IF NOT EXISTS teaching_invigilations_lecturer_idx ON teaching_invigilations (lecturer_id);

DROP TRIGGER IF EXISTS teaching_exam_papers_updated ON teaching_exam_papers;
CREATE TRIGGER teaching_exam_papers_updated BEFORE UPDATE ON teaching_exam_papers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS teaching_invigilations_updated ON teaching_invigilations;
CREATE TRIGGER teaching_invigilations_updated BEFORE UPDATE ON teaching_invigilations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

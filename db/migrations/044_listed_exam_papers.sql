-- Exam papers a department uploads as its list (the Word document it sends
-- for moderation: unit codes and titles), sized from SMARTTT instead of from
-- the department's own units and courses.
--
--  - teaching_exam_papers.codes: the paper's unit codes as listed ("BITE 131",
--    "COSC 130"). Empty for a paper built from the department's units, whose
--    codes are its units'.
--  - teaching_exam_paper_rows: the class rows that sit a listed paper and how
--    many students each: the students who synced its units in SMARTTT, by
--    programme, year, semester and stream. `smarttt_students` is SMARTTT's
--    count when last read; `edited` means the department set `students` (or
--    added the row) itself, so a fresh count from SMARTTT doesn't overwrite it.
--
-- Apply with `npm run db:migrate`.

ALTER TABLE teaching_exam_papers ADD COLUMN IF NOT EXISTS codes TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS teaching_exam_paper_rows (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id          UUID NOT NULL REFERENCES teaching_exam_papers(id) ON DELETE CASCADE,
  programme         VARCHAR(64) NOT NULL,
  year              SMALLINT NOT NULL CHECK (year BETWEEN 1 AND 10),
  semester          SMALLINT NOT NULL CHECK (semester BETWEEN 1 AND 3),
  stream            VARCHAR(40) NOT NULL DEFAULT '',
  students          INTEGER NOT NULL CHECK (students >= 0),
  smarttt_students  INTEGER CHECK (smarttt_students >= 0),
  edited            BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (paper_id, programme, year, semester, stream)
);
CREATE INDEX IF NOT EXISTS teaching_exam_paper_rows_paper_idx ON teaching_exam_paper_rows (paper_id);

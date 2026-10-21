-- Student course evaluations: QA opens a round (a questionnaire with a
-- window), students rate each unit they are on, and QA, faculties and
-- departments read the results.
--
-- Anonymity is structural, not a promise in the code:
--   - qa_evaluation_submissions records THAT a student has evaluated a unit
--     in a round (so they cannot do it twice), and nothing about what they
--     said.
--   - qa_evaluation_responses + _answers hold WHAT was said, with no student
--     column and no timestamp, so the two tables cannot be joined back
--     together by id or by time.
--   - Results for a unit are only shown once it has min_responses responses
--     (evaluation.service.ts), so a class of two cannot be read off.
--
-- Questions are fixed once a round has its first submission: changing a
-- question after people answered it would change what their answers mean.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS qa_evaluation_rounds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title               VARCHAR(200) NOT NULL,
  instructions        TEXT,
  opens_at            TIMESTAMPTZ NOT NULL,
  closes_at           TIMESTAMPTZ NOT NULL,
  min_responses       INTEGER NOT NULL DEFAULT 3 CHECK (min_responses BETWEEN 1 AND 50),
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS qa_evaluation_rounds_window_idx ON qa_evaluation_rounds (opens_at, closes_at);

CREATE TABLE IF NOT EXISTS qa_evaluation_questions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id   UUID NOT NULL REFERENCES qa_evaluation_rounds(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL CHECK (position >= 1),
  prompt     VARCHAR(300) NOT NULL,
  -- RATING: 1 (strongly disagree) to 5 (strongly agree). TEXT: a free comment.
  kind       VARCHAR(8) NOT NULL CHECK (kind IN ('RATING','TEXT')),
  required   BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (round_id, position)
);

CREATE TABLE IF NOT EXISTS qa_evaluation_submissions (
  round_id         UUID NOT NULL REFERENCES qa_evaluation_rounds(id) ON DELETE CASCADE,
  unit_id          UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  student_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, unit_id, student_user_id)
);
CREATE INDEX IF NOT EXISTS qa_evaluation_submissions_student_idx ON qa_evaluation_submissions (student_user_id);

CREATE TABLE IF NOT EXISTS qa_evaluation_responses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id          UUID NOT NULL REFERENCES qa_evaluation_rounds(id) ON DELETE CASCADE,
  unit_id           UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  -- Who taught it and who owned it when the student answered, so a unit
  -- changing hands later does not move the feedback with it.
  lecturer_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  department_id     UUID REFERENCES departments(id)
);
CREATE INDEX IF NOT EXISTS qa_evaluation_responses_round_unit_idx ON qa_evaluation_responses (round_id, unit_id);
CREATE INDEX IF NOT EXISTS qa_evaluation_responses_department_idx ON qa_evaluation_responses (department_id);

CREATE TABLE IF NOT EXISTS qa_evaluation_answers (
  response_id  UUID NOT NULL REFERENCES qa_evaluation_responses(id) ON DELETE CASCADE,
  question_id  UUID NOT NULL REFERENCES qa_evaluation_questions(id) ON DELETE CASCADE,
  rating       SMALLINT CHECK (rating BETWEEN 1 AND 5),
  text_answer  TEXT,
  PRIMARY KEY (response_id, question_id),
  CHECK (num_nonnulls(rating, text_answer) = 1)
);

DROP TRIGGER IF EXISTS qa_evaluation_rounds_updated ON qa_evaluation_rounds;
CREATE TRIGGER qa_evaluation_rounds_updated BEFORE UPDATE ON qa_evaluation_rounds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The exam-eligibility rule: the minimum share of a unit's classes a student
-- must attend to sit its exam.
--
-- There is no national rule in Kenya; each Senate sets its own (two-thirds at
-- Kenyatta and Kirinyaga, 75% elsewhere), so it is a setting, not a constant.
-- One row for the whole institution: the Senate's rule applies to every
-- faculty alike. The QA officer edits it (quality-assurance/policy); every
-- oversight portal reads it.
--
-- The default 75 matches what the frontend hard-coded until now
-- (ATTENDANCE_fronted/src/lib/attendancePolicy.ts), so nothing a student
-- already sees changes until someone changes the setting.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS attendance_policy (
  -- Always TRUE: the CHECK plus the primary key make a second row impossible.
  id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  min_attendance_percent   NUMERIC(5,2) NOT NULL DEFAULT 75 CHECK (min_attendance_percent BETWEEN 1 AND 100),
  -- Students at or above the minimum but within this many points of it are
  -- "at risk": one or two more absences and they fall below.
  at_risk_margin_percent   NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (at_risk_margin_percent BETWEEN 0 AND 50),
  updated_by_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO attendance_policy (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

DROP TRIGGER IF EXISTS attendance_policy_updated ON attendance_policy;
CREATE TRIGGER attendance_policy_updated BEFORE UPDATE ON attendance_policy FOR EACH ROW EXECUTE FUNCTION set_updated_at();

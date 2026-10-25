-- The exam timetable, pushed by SMARTTT (apps/integrations/attendance_push.py there):
--
--  - term_modes: whether a term is in exam mode. While it is, teaching classes
--    can't be opened (src/modules/session); the Director switches it from the
--    Timetable Generator through SMARTTT.
--  - exam_sessions: one per paper per room, with who sits there (their
--    registration numbers, as SMARTTT seats them) and its invigilator, main or
--    extra. The invigilator opens it in its time slot; it then shows a rotating
--    code and is fenced like a class (src/modules/exam).
--  - exam_attendance_records: who sat it.
--
-- Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS term_modes (
  term_id      VARCHAR(64) PRIMARY KEY,                 -- SMARTTT's term id
  mode         VARCHAR(10) NOT NULL CHECK (mode IN ('teaching', 'exams')),
  switched_at  TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exam_sessions (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key                            VARCHAR(220) NOT NULL UNIQUE,   -- "<paper key>|<room>"
  term_id                        VARCHAR(64) NOT NULL,
  version                        INTEGER NOT NULL,               -- SMARTTT's exam version it came from
  paper_key                      VARCHAR(160) NOT NULL,
  unit_codes                     JSONB NOT NULL DEFAULT '[]',
  title                          VARCHAR(255) NOT NULL DEFAULT '',
  starts_at                      TIMESTAMPTZ NOT NULL,
  ends_at                        TIMESTAMPTZ NOT NULL,
  room_code                      VARCHAR(80) NOT NULL,
  candidates                     JSONB NOT NULL DEFAULT '[]',    -- class rows and registration ranges, for display
  registration_numbers           TEXT[] NOT NULL DEFAULT '{}',   -- who sits here (uppercased)
  invigilator_staff_number       VARCHAR(64) NOT NULL,
  role                           VARCHAR(10) NOT NULL CHECK (role IN ('main', 'extra')),
  main_invigilator_staff_number  VARCHAR(64),
  -- Gone from SMARTTT's latest version (moved room, paper removed); kept for its records.
  withdrawn_at                   TIMESTAMPTZ,
  -- Set when the invigilator opens it.
  opened_by_user_id              UUID REFERENCES users(id),
  qr_secret                      TEXT,
  status                         TEXT CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at                      TIMESTAMPTZ,
  closes_at                      TIMESTAMPTZ,
  rotation_seconds               INTEGER CHECK (rotation_seconds BETWEEN 15 AND 600),
  geofence_mode                  TEXT CHECK (geofence_mode IN ('ROOM', 'LECTURER_DEVICE', 'OFF')),
  latitude                       DOUBLE PRECISION,
  longitude                      DOUBLE PRECISION,
  radius_metres                  INTEGER,
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT exam_sessions_window CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS exam_sessions_invigilator_idx ON exam_sessions (invigilator_staff_number, starts_at);
CREATE INDEX IF NOT EXISTS exam_sessions_paper_idx ON exam_sessions (term_id, paper_key);
CREATE INDEX IF NOT EXISTS exam_sessions_candidates_idx ON exam_sessions USING GIN (registration_numbers);

CREATE TABLE IF NOT EXISTS exam_attendance_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_session_id      UUID NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
  student_user_id      UUID NOT NULL REFERENCES users(id),
  registration_number  VARCHAR(64) NOT NULL,
  checked_in_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_session_id, student_user_id)
);

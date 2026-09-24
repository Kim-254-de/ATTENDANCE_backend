-- Who may check in to a unit's sessions, and who did. Matches docs/expected-schema.md.
-- Apply with `npm run db:migrate`.

-- A student on a unit. Two ways in:
--   LECTURER      - the lecturer adds a registration number, verified against the ERP. ACTIVE at once.
--                   `student_user_id` stays NULL until that student has an account, when student
--                   registration links it (unit.repository.ts: linkAllocationsToStudent).
--   SELF_ENROLLED - a signed-in student asks to join by unit code. PENDING until the lecturer
--                   approves, or any student could put themselves on any unit and a forwarded QR
--                   code would work for them.
-- Only ACTIVE rows with a student_user_id can check in.
CREATE TABLE IF NOT EXISTS unit_allocations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id              UUID NOT NULL REFERENCES units(id),
  registration_number  VARCHAR(64),                        -- stored uppercased
  student_user_id      UUID REFERENCES users(id),
  full_name            VARCHAR(160),                       -- from the ERP, or the student's account
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE','PENDING','DROPPED')),
  source               TEXT NOT NULL CHECK (source IN ('LECTURER','SELF_ENROLLED')),
  added_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unit_allocations_identified CHECK (registration_number IS NOT NULL OR student_user_id IS NOT NULL),
  CONSTRAINT unit_allocations_reg_upper CHECK (registration_number = upper(registration_number))
);
-- Load-bearing: these stop the same student being put on a unit twice by concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS unit_allocations_unit_reg_uq
  ON unit_allocations (unit_id, registration_number) WHERE registration_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS unit_allocations_unit_student_uq
  ON unit_allocations (unit_id, student_user_id) WHERE student_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS unit_allocations_student_idx ON unit_allocations (student_user_id);
CREATE INDEX IF NOT EXISTS unit_allocations_reg_idx ON unit_allocations (registration_number);

-- One row per student per class meeting.
CREATE TABLE IF NOT EXISTS attendance_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       UUID NOT NULL REFERENCES attendance_sessions(id),
  student_user_id  UUID NOT NULL REFERENCES users(id),
  allocation_id    UUID REFERENCES unit_allocations(id),
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  qr_age_seconds   INTEGER,                               -- how old the scanned code was
  ip_address       VARCHAR(64),
  user_agent       TEXT,
  -- Load-bearing: the pre-insert check cannot be atomic; this is what stops two
  -- simultaneous scans both being recorded.
  CONSTRAINT attendance_records_once_per_session UNIQUE (session_id, student_user_id)
);
CREATE INDEX IF NOT EXISTS attendance_records_student_idx ON attendance_records (student_user_id);

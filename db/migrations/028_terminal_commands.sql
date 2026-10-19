-- Work a department queues for one of its terminals (docs/hardware-specs.md 6.3).
--
-- ENROL_FINGERPRINT: the officer picks a student and a device; the device picks
-- the request up when it reports in, takes the finger into one of its own
-- slots, and reports the slot back. That completes the student_fingerprints row.
--
-- DELETE_FINGERPRINT: revoking an enrolment on the server also has to clear the
-- template off the reader. The server only holds an HMAC of the slot, so the
-- command names the enrolment (fingerprint_id) and the device, which recorded
-- that id against its slot when it enrolled, frees the slot itself.

CREATE TABLE IF NOT EXISTS terminal_commands (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id           UUID NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('ENROL_FINGERPRINT', 'DELETE_FINGERPRINT')),
  student_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The enrolment a DELETE frees, or the one an ENROL produced.
  fingerprint_id        UUID REFERENCES student_fingerprints(id) ON DELETE SET NULL,
  -- Which finger, for whoever is holding the device. Never used in matching.
  label                 VARCHAR(64),
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'DONE', 'FAILED', 'CANCELLED')),
  failure_reason        VARCHAR(200),
  requested_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT terminal_commands_completed_at CHECK ((status = 'PENDING') = (completed_at IS NULL))
);

-- One outstanding enrolment per student per device.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_commands_one_pending_enrol
  ON terminal_commands (terminal_id, student_user_id)
  WHERE kind = 'ENROL_FINGERPRINT' AND status = 'PENDING';
CREATE INDEX IF NOT EXISTS terminal_commands_pending_idx
  ON terminal_commands (terminal_id, created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS terminal_commands_student_idx ON terminal_commands (student_user_id);

DROP TRIGGER IF EXISTS terminal_commands_updated ON terminal_commands;
CREATE TRIGGER terminal_commands_updated BEFORE UPDATE ON terminal_commands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

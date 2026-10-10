-- Fingerprint check-in at a terminal.
--
-- The model mirrors student_cards (019_card_verification.sql), and the reason
-- is worth stating because it is the decision this whole feature turns on:
-- **no fingerprint ever reaches this database.**
--
-- The readers used for this (R307, ZFM-20, GROW R503 and the like) hold their
-- own template store on the module and do the 1:N match themselves. On a match
-- they return the slot the template was enrolled in — a small integer. So what
-- is stored here is a mapping from "terminal X, slot N" to a student, and the
-- biometric stays on the device. That keeps template storage, retention and
-- consent out of this service entirely.
--
-- It also means a slot number is only meaningful on the terminal that enrolled
-- it: slot 37 on TERM-01 and slot 37 on TERM-02 are different people. The
-- mapping is therefore keyed on (terminal_id, finger_ref_hmac), and a student
-- who should be recognised by two terminals needs enrolling on both. If a
-- reader that exports templates is bought later and matching moves server-side,
-- terminal_id becomes a constant and the rest of this still holds.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS student_fingerprints (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** Which terminal enrolled it; a slot number means nothing without this. */
  terminal_id          VARCHAR(64) NOT NULL,
  /**
   * HMAC of the reader's enrolment reference, keyed with FINGERPRINT_REF_SECRET.
   * A slot number is tiny — often 1..1000 — so a plain hash would be
   * enumerable from a dump in microseconds, and the reference is all it takes
   * to post a check-in. See src/common/utils/card-uid.ts for the same argument.
   */
  finger_ref_hmac      VARCHAR(64) NOT NULL,
  /** Which finger, for whoever has to re-enrol it. Never used in matching. */
  label                VARCHAR(64),
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  enrolled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at           TIMESTAMPTZ,
  enrolled_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT student_fingerprints_revoked_at CHECK (
    (status = 'REVOKED') = (revoked_at IS NOT NULL)
  )
);

-- Load-bearing: one slot on one terminal resolves to one student, so a check-in
-- can never be ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS student_fingerprints_terminal_ref_uq
  ON student_fingerprints (terminal_id, finger_ref_hmac) WHERE status = 'ACTIVE';

-- One usable enrolment per student per terminal. A student may be enrolled on
-- several terminals, which is how a reader that travels between rooms works.
CREATE UNIQUE INDEX IF NOT EXISTS student_fingerprints_one_active_per_terminal
  ON student_fingerprints (student_user_id, terminal_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS student_fingerprints_student_idx
  ON student_fingerprints (student_user_id);

DROP TRIGGER IF EXISTS student_fingerprints_updated ON student_fingerprints;
CREATE TRIGGER student_fingerprints_updated BEFORE UPDATE ON student_fingerprints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

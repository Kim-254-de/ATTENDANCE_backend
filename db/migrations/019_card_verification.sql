-- Student ID card check-in, and the lecturer's choice of which verification
-- methods a class accepts.
--
-- Until now every check-in was a QR scan and nothing recorded that fact. A
-- lecturer now ticks any combination of QR code, fingerprint, face recognition
-- and card scanning when activating a class; a check-in by a method the class
-- did not enable is refused, and each record keeps the method that produced it
-- so reports can tell them apart.
--
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- --------------------------------------------------------------------------
-- What a session accepts
-- --------------------------------------------------------------------------
-- 'QR' alone is the default, which is what every existing session was.
ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS verification_methods TEXT[] NOT NULL DEFAULT ARRAY['QR']::text[];

ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_verification_methods;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_verification_methods CHECK (
    -- At least one, and nothing outside the four. Duplicates are rejected by
    -- session.schema.ts instead: expressing that here needs a subquery, which
    -- a CHECK constraint cannot contain, and a repeated method is harmless
    -- anyway — nothing reads the array's length.
    array_length(verification_methods, 1) >= 1
    AND verification_methods <@ ARRAY['QR', 'FINGERPRINT', 'FACE', 'CARD']::text[]
  );

-- --------------------------------------------------------------------------
-- Which method recorded each check-in
-- --------------------------------------------------------------------------
-- Every row that already exists came from a QR scan, so the default is honest.
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS verification_method TEXT NOT NULL DEFAULT 'QR';

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_verification_method;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_verification_method
    CHECK (verification_method IN ('QR', 'FINGERPRINT', 'FACE', 'CARD'));

-- --------------------------------------------------------------------------
-- The cards themselves
-- --------------------------------------------------------------------------
-- A card UID is only 32-56 bits, so unlike the 256-bit tokens in
-- common/utils/tokens.ts a plain SHA-256 of it could be enumerated from a
-- database dump in seconds and written onto blank cards. The stored value is
-- therefore an HMAC keyed with CARD_UID_SECRET, which a dump does not contain.
--
-- Rows are kept, never deleted: a lost card is REVOKED so that the attendance
-- it recorded kept its meaning, and so a card handed in and re-issued is
-- visible as two rows rather than one silently overwritten.
CREATE TABLE IF NOT EXISTS student_cards (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_uid_hmac        VARCHAR(64) NOT NULL UNIQUE,          -- HMAC-SHA256 hex
  /** Free text for whoever has to find a physical card again, e.g. "re-issued Oct 2026". */
  label                VARCHAR(64),
  status               TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at           TIMESTAMPTZ,
  /** Who enrolled it. NULL once that account is gone; the card still stands. */
  enrolled_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT student_cards_revoked_at CHECK (
    (status = 'REVOKED') = (revoked_at IS NOT NULL)
  )
);

-- Load-bearing: one usable card per student. Revoked rows are exempt, so a
-- replacement can be enrolled while the old row stays for the history.
CREATE UNIQUE INDEX IF NOT EXISTS student_cards_one_active_per_student
  ON student_cards (student_user_id) WHERE status = 'ACTIVE';

-- The check-in lookup: by HMAC, and only ACTIVE cards can be presented.
CREATE INDEX IF NOT EXISTS student_cards_active_hmac_idx
  ON student_cards (card_uid_hmac) WHERE status = 'ACTIVE';

DROP TRIGGER IF EXISTS student_cards_updated ON student_cards;
CREATE TRIGGER student_cards_updated BEFORE UPDATE ON student_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

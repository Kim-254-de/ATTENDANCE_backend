-- Portable check-in terminals (docs/hardware-specs.md section 6.2).
--
-- A terminal is a wireless handheld owned by a department and carried to
-- class. Each one has its own key, so a lost device is switched off alone
-- rather than by rotating a key shared by all of them. A lecturer links it to
-- their class by letting it scan a short-lived code from their screen; it can
-- only be linked to classes taught by its own department's lecturers.
--
-- `code` is the name the department gives it (e.g. TERM-01). It is also the
-- terminal id fingerprint enrolments are scoped by (student_fingerprints), so
-- it never changes once created.

CREATE TABLE IF NOT EXISTS terminals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 VARCHAR(64) NOT NULL UNIQUE,
  department_id        UUID NOT NULL REFERENCES departments(id),
  label                VARCHAR(120),
  capabilities         TEXT[] NOT NULL,
  -- PENDING: created, waiting for the device to pair. ACTIVE: paired.
  -- LOST and RETIRED: key cleared; nothing this device sends is accepted.
  status               TEXT NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'ACTIVE', 'LOST', 'RETIRED')),
  -- SHA-256 of the device's key. The key is 256 random bits, so a plain hash is sound (tokens.ts).
  key_hash             VARCHAR(64) UNIQUE,
  -- One-time code the device presents to receive its key. Cleared on use.
  pairing_code_hash    VARCHAR(64) UNIQUE,
  pairing_expires_at   TIMESTAMPTZ,
  paired_at            TIMESTAMPTZ,
  -- What the device last reported. For the department's devices page only.
  last_seen_at         TIMESTAMPTZ,
  last_ip              VARCHAR(64),
  battery_percent      SMALLINT CHECK (battery_percent BETWEEN 0 AND 100),
  network              TEXT CHECK (network IN ('WIFI', 'CELLULAR')),
  app_version          VARCHAR(32),
  -- The class it is recording for right now, if any.
  linked_session_id    UUID REFERENCES attendance_sessions(id) ON DELETE SET NULL,
  linked_at            TIMESTAMPTZ,
  created_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT terminals_capabilities CHECK (
    array_length(capabilities, 1) >= 1
    AND capabilities <@ ARRAY['BARCODE', 'CARD', 'FINGERPRINT']::text[]
  ),
  CONSTRAINT terminals_key_only_when_active CHECK (key_hash IS NULL OR status = 'ACTIVE'),
  CONSTRAINT terminals_pairing_expiry CHECK ((pairing_code_hash IS NULL) = (pairing_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS terminals_department_idx ON terminals (department_id);
CREATE INDEX IF NOT EXISTS terminals_linked_session_idx ON terminals (linked_session_id) WHERE linked_session_id IS NOT NULL;

DROP TRIGGER IF EXISTS terminals_updated ON terminals;
CREATE TRIGGER terminals_updated BEFORE UPDATE ON terminals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

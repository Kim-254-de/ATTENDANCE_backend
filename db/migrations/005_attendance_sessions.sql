-- Tables the session module needs to open a class and generate its rotating QR code.
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

-- One row per unit, ever. Rotating QR codes never add rows anywhere.
CREATE TABLE IF NOT EXISTS units (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code              VARCHAR(32) NOT NULL UNIQUE,          -- e.g. "COSC 100"
  name              VARCHAR(200),
  lecturer_user_id  UUID NOT NULL REFERENCES users(id),   -- who may open sessions for it
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS units_lecturer_idx ON units (lecturer_user_id);

-- One row per class meeting, not per QR code.
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id           UUID NOT NULL REFERENCES units(id),
  lecturer_user_id  UUID NOT NULL REFERENCES users(id),
  qr_secret         TEXT NOT NULL,                        -- HMAC key; never leaves the server
  status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAUSED','CLOSED')),
  title             VARCHAR(160),
  opens_at          TIMESTAMPTZ NOT NULL,
  closes_at         TIMESTAMPTZ NOT NULL,
  rotation_seconds  INTEGER NOT NULL CHECK (rotation_seconds BETWEEN 15 AND 600),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_sessions_window CHECK (closes_at > opens_at)
);
CREATE INDEX IF NOT EXISTS attendance_sessions_unit_idx ON attendance_sessions (unit_id);
CREATE INDEX IF NOT EXISTS attendance_sessions_lecturer_idx ON attendance_sessions (lecturer_user_id, status);

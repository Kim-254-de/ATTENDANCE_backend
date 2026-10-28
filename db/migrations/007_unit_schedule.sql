-- Each unit's issued weekly meeting slot. A class can only be activated
-- (session.service.ts createSession) while `now` falls inside its window.
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS unit_schedule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID NOT NULL UNIQUE REFERENCES units(id), -- one slot per unit for now
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun..6=Sat, matches JS Date#getDay()
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unit_schedule_window CHECK (end_time > start_time)
);

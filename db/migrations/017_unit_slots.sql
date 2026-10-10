-- Every weekly meeting of a unit, not just one.
--
-- unit_schedule holds one slot per unit, but most units meet more than once a
-- week (a lecture on Monday and another on Thursday), and a class shared by
-- several programmes is printed once per programme, so rescheduling one of
-- those rows in SMARTTT leaves the unit at two different times. The sync used
-- to drop all of them in that case, so the class could never be activated.
-- unit_slots holds them all, each with its own room; activation looks for the
-- one happening now (session.service.ts resolveSlot).
--
-- unit_schedule stays, for display: the unit's one slot when it has exactly
-- one, else no row. Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

CREATE TABLE IF NOT EXISTS unit_slots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id     UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun..6=Sat, campus time
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  room_code   VARCHAR(80),                                           -- as SMARTTT names it; null when none
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unit_slots_window CHECK (end_time > start_time),
  CONSTRAINT unit_slots_unique UNIQUE (unit_id, day_of_week, start_time, end_time)
);
CREATE INDEX IF NOT EXISTS unit_slots_day_idx ON unit_slots (day_of_week, start_time);

INSERT INTO unit_slots (unit_id, day_of_week, start_time, end_time, room_code)
SELECT unit_id, day_of_week, start_time, end_time, room_code FROM unit_schedule
ON CONFLICT (unit_id, day_of_week, start_time, end_time) DO NOTHING;

-- The room a session's meeting is in, fixed at activation: with several
-- meetings a week the unit no longer has one room to look up.
ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS room_code VARCHAR(80);
UPDATE attendance_sessions s
   SET room_code = sch.room_code
  FROM unit_schedule sch
 WHERE sch.unit_id = s.unit_id AND s.room_code IS NULL;

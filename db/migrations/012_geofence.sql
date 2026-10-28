-- Geofenced check-in: a scan is accepted only from near the room the class is
-- in (session.geofence.ts). Matches docs/expected-schema.md.
-- Apply with `npm run db:migrate`.

-- A teaching room and, once someone has stood in it with a phone, its centre
-- point (`npm run dev:set-room`). Coordinates are set by an administrator,
-- never by a lecturer: a lecturer who could move "the room" could move it to
-- wherever their absent students are.
-- A room SMARTTT names but nobody has surveyed yet has no coordinates; the
-- session then falls back to the lecturer's device location.
CREATE TABLE IF NOT EXISTS rooms (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 VARCHAR(80) NOT NULL UNIQUE,           -- as SMARTTT names it, e.g. "LH1"
  name                 VARCHAR(160),
  latitude             DOUBLE PRECISION,
  longitude            DOUBLE PRECISION,
  surveyed_accuracy_m  DOUBLE PRECISION,                      -- how precise the survey reading was
  surveyed_at          TIMESTAMPTZ,
  surveyed_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rooms_latitude_range  CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT rooms_longitude_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT rooms_accuracy_positive CHECK (surveyed_accuracy_m > 0),
  -- Surveyed means all of it: a latitude without a longitude is not a place.
  CONSTRAINT rooms_surveyed_together CHECK (
    (latitude IS NULL AND longitude IS NULL AND surveyed_at IS NULL)
    OR (latitude IS NOT NULL AND longitude IS NOT NULL AND surveyed_at IS NOT NULL)
  )
);

-- Where each unit's weekly slot is taught, as SMARTTT reports it. Deliberately
-- not a foreign key to rooms: the sync records whatever room SMARTTT names,
-- surveyed or not, and the session looks the code up in rooms when it opens.
ALTER TABLE unit_schedule
  ADD COLUMN IF NOT EXISTS room_code VARCHAR(80);

-- The fence a session enforces, fixed when the class is activated so that a
-- room re-surveyed mid-class does not move it under students already scanning.
--   ROOM            - centred on the room's surveyed point
--   LECTURER_DEVICE - centred on where the lecturer's device was at activation
--   OFF             - no location check
-- Existing sessions predate geofencing, so they are OFF. The centre is kept
-- when a lecturer switches the fence OFF, so switching it back ON can reuse it.
ALTER TABLE attendance_sessions
  ADD COLUMN IF NOT EXISTS geofence_mode TEXT NOT NULL DEFAULT 'OFF'
    CHECK (geofence_mode IN ('ROOM', 'LECTURER_DEVICE', 'OFF')),
  ADD COLUMN IF NOT EXISTS geofence_lat DOUBLE PRECISION
    CHECK (geofence_lat BETWEEN -90 AND 90),
  ADD COLUMN IF NOT EXISTS geofence_lng DOUBLE PRECISION
    CHECK (geofence_lng BETWEEN -180 AND 180),
  ADD COLUMN IF NOT EXISTS geofence_radius_m DOUBLE PRECISION
    CHECK (geofence_radius_m > 0),
  ADD COLUMN IF NOT EXISTS geofence_anchor_accuracy_m DOUBLE PRECISION
    CHECK (geofence_anchor_accuracy_m >= 0);

ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_geofence_centre;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_geofence_centre CHECK (
    geofence_mode = 'OFF'
    OR (geofence_lat IS NOT NULL AND geofence_lng IS NOT NULL AND geofence_radius_m IS NOT NULL)
  );

-- How far from the centre each check-in was. The student's raw coordinates are
-- never stored: the distance is all attendance needs, and a table of where
-- every student was at every class is a liability nobody asked for.
--   INSIDE      - the fence was on and the reading passed
--   NOT_CHECKED - the fence was off for the session (includes every earlier record)
ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS distance_m DOUBLE PRECISION CHECK (distance_m >= 0),
  ADD COLUMN IF NOT EXISTS location_accuracy_m DOUBLE PRECISION CHECK (location_accuracy_m >= 0),
  ADD COLUMN IF NOT EXISTS geofence_result TEXT NOT NULL DEFAULT 'NOT_CHECKED'
    CHECK (geofence_result IN ('INSIDE', 'NOT_CHECKED'));

ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_geofence_evidence;
ALTER TABLE attendance_records
  ADD CONSTRAINT attendance_records_geofence_evidence CHECK (
    geofence_result <> 'INSIDE' OR (distance_m IS NOT NULL AND location_accuracy_m IS NOT NULL)
  );

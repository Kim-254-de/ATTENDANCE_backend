-- A class activated from a laptop in an unsurveyed room has no centre to fence
-- around yet: the laptop's own location is too vague. Rather than refuse it,
-- the session opens AWAITING_LOCATION and the lecturer sends the room's
-- position from their phone, signed in to the same account
-- (PATCH /sessions/:id/geofence). Scans are held until then: an unfenced
-- class would be exactly the gap the fence exists to close.
-- Matches docs/expected-schema.md. Apply with `npm run db:migrate`.

ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_geofence_mode_check;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_geofence_mode_check
    CHECK (geofence_mode IN ('ROOM', 'LECTURER_DEVICE', 'AWAITING_LOCATION', 'OFF'));

ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_geofence_centre;
ALTER TABLE attendance_sessions
  ADD CONSTRAINT attendance_sessions_geofence_centre CHECK (
    geofence_mode IN ('OFF', 'AWAITING_LOCATION')
    OR (geofence_lat IS NOT NULL AND geofence_lng IS NOT NULL AND geofence_radius_m IS NOT NULL)
  );

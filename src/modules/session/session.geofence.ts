import { env } from '../../config/env.js';
import { GeofenceMode } from '../../db/types.js';

/**
 * Geofenced check-in.
 *
 * The problem the rotating code leaves open: a student in the room sends the
 * live code to a friend at home, who scans it within the same minute.
 *
 * The fix: the scan carries the phone's GPS reading, and the server accepts it
 * only if the phone was near the room's centre point. The centre is fixed when
 * the class is activated (chooseCentre); every scan is then measured against
 * it (checkReading).
 *
 * The rule, in order:
 *   1. no reading                     -> LOCATION_REQUIRED
 *   2. the OS says the fix is faked   -> LOCATION_MOCKED
 *   3. the fix is too old             -> LOCATION_STALE
 *   4. accuracy worse than the limit  -> LOCATION_TOO_IMPRECISE
 *   5. distance - accuracy > radius   -> OUTSIDE_GEOFENCE
 *
 * Step 5 gives the student the benefit of the doubt: a phone 30m out with 15m
 * accuracy might really be 15m out, so it is accepted. Step 4 is what stops
 * that generosity being abused: without it a 500m-accurate reading from
 * anywhere nearby would pass.
 *
 * What this does NOT solve: a determined student with a fake-GPS app on a
 * phone that doesn't report it. `isMocked` catches the easy cases on Android.
 *
 * This file is deliberately pure - no database, no HTTP - like
 * session.token.ts, so the maths and the rule can be tested exhaustively.
 */

/** Mean Earth radius (IUGG). The spherical error is well under 1% at classroom scale. */
const EARTH_RADIUS_METRES = 6_371_008.8;

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/** A GPS reading from a scanning student's phone. */
export interface StudentReading extends GeoPoint {
  /** 68% confidence radius in metres, as the OS reports it. */
  accuracy: number;
  /** When the phone took the fix, not when the request was sent. */
  capturedAt: Date;
  /** Android reports readings from fake-location apps. Absent on other platforms. */
  isMocked?: boolean;
}

/** The lecturer's device reading at activation. */
export interface AnchorReading extends GeoPoint {
  accuracy: number;
}

/** A room's surveyed centre, or null coordinates when nobody has surveyed it yet. */
export interface RoomLocation {
  latitude: number | null;
  longitude: number | null;
  surveyedAccuracyMetres: number | null;
}

/** The fence a session enforces, as stored on attendance_sessions. */
export interface GeofenceCentre extends GeoPoint {
  radiusMetres: number;
}

export type GeofenceRejection =
  | 'LOCATION_REQUIRED'
  | 'LOCATION_MOCKED'
  | 'LOCATION_STALE'
  | 'LOCATION_TOO_IMPRECISE'
  | 'OUTSIDE_GEOFENCE';

export type ReadingCheck =
  | { accepted: true; distanceMetres: number; accuracyMetres: number }
  | {
      accepted: false;
      reason: GeofenceRejection;
      /** Set once the reading got far enough to be measured, for the audit trail. */
      distanceMetres?: number;
      accuracyMetres?: number;
    };

export type CentreChoice =
  | {
      ok: true;
      mode: typeof GeofenceMode.ROOM | typeof GeofenceMode.LECTURER_DEVICE;
      latitude: number;
      longitude: number;
      anchorAccuracyMetres: number | null;
    }
  | {
      ok: false;
      /** NO_READING: the room isn't surveyed and the lecturer sent no location. */
      reason: 'NO_READING' | 'TOO_IMPRECISE';
      accuracyMetres?: number;
    };

export interface ReadingOptions {
  maxAccuracyMetres?: number;
  maxFixAgeSeconds?: number;
}

/** Great-circle distance in metres (haversine). */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  // min() guards against floating-point error pushing h a hair past 1 for
  // antipodal points, which would make asin return NaN.
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Step 5 on its own. Split out so the boundary can be tested with exact
 * numbers rather than coordinates that only approximate a distance.
 */
export function isWithinFence(distance: number, accuracy: number, radiusMetres: number): boolean {
  return distance - accuracy <= radiusMetres;
}

/** Checks a scanning student's reading against the session's fence. */
export function checkReading(
  centre: GeofenceCentre,
  reading: StudentReading | undefined,
  at: Date = new Date(),
  options: ReadingOptions = {},
): ReadingCheck {
  const maxAccuracy = options.maxAccuracyMetres ?? env.GEOFENCE_MAX_STUDENT_ACCURACY_METRES;
  const maxAgeSeconds = options.maxFixAgeSeconds ?? env.GEOFENCE_MAX_FIX_AGE_SECONDS;

  if (!reading || !isValidPoint(reading)) return { accepted: false, reason: 'LOCATION_REQUIRED' };
  if (reading.isMocked === true) return { accepted: false, reason: 'LOCATION_MOCKED' };

  // Checked both ways. A fix far in the future is not fresher, it's from a
  // phone whose clock is wrong, and its age can't be trusted either way.
  const ageSeconds = (at.getTime() - reading.capturedAt.getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || Math.abs(ageSeconds) > maxAgeSeconds) {
    return { accepted: false, reason: 'LOCATION_STALE' };
  }

  const distance = distanceMetres(centre, reading);
  const measured = { distanceMetres: distance, accuracyMetres: reading.accuracy };

  // A negative or non-numeric accuracy is not a precise reading; treat it as the worst kind.
  if (!Number.isFinite(reading.accuracy) || reading.accuracy < 0 || reading.accuracy > maxAccuracy) {
    return { accepted: false, reason: 'LOCATION_TOO_IMPRECISE', ...measured };
  }

  if (!isWithinFence(distance, reading.accuracy, centre.radiusMetres)) {
    return { accepted: false, reason: 'OUTSIDE_GEOFENCE', ...measured };
  }

  return { accepted: true, ...measured };
}

/**
 * Picks the centre a new session's fence is measured from.
 *
 *   1. the room has been surveyed        -> the room's point
 *   2. the lecturer's device is precise  -> the lecturer's position
 *   3. otherwise                         -> refuse; activate from a phone or switch the fence off
 *
 * The room wins even when the lecturer also sent a reading: the survey was
 * done deliberately, standing in the middle of the room, while a lecturer's
 * phone may be in a bag by the door.
 */
export function chooseCentre(
  room: RoomLocation | null,
  lecturer: AnchorReading | undefined,
  options: { maxAnchorAccuracyMetres?: number } = {},
): CentreChoice {
  const maxAccuracy = options.maxAnchorAccuracyMetres ?? env.GEOFENCE_MAX_ANCHOR_ACCURACY_METRES;

  if (room && room.latitude !== null && room.longitude !== null) {
    return {
      ok: true,
      mode: GeofenceMode.ROOM,
      latitude: room.latitude,
      longitude: room.longitude,
      anchorAccuracyMetres: room.surveyedAccuracyMetres,
    };
  }

  if (!lecturer || !isValidPoint(lecturer)) return { ok: false, reason: 'NO_READING' };

  if (!Number.isFinite(lecturer.accuracy) || lecturer.accuracy < 0 || lecturer.accuracy > maxAccuracy) {
    return { ok: false, reason: 'TOO_IMPRECISE', accuracyMetres: lecturer.accuracy };
  }

  return {
    ok: true,
    mode: GeofenceMode.LECTURER_DEVICE,
    latitude: lecturer.latitude,
    longitude: lecturer.longitude,
    anchorAccuracyMetres: lecturer.accuracy,
  };
}

function isValidPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * "About 140 m" rather than "139.62 m": the reading is only good to a few
 * metres, and false precision invites arguments.
 */
export function roundDistanceForDisplay(metres: number): number {
  if (metres < 50) return Math.max(1, Math.round(metres));
  return Math.round(metres / 10) * 10;
}

/** Human-readable reasons, safe to return to a scanning student. */
export function rejectionMessage(check: Extract<ReadingCheck, { accepted: false }>, roomCode?: string | null): string {
  switch (check.reason) {
    case 'LOCATION_REQUIRED':
      return 'This class checks your location. Allow location access for the app and scan again.';
    case 'LOCATION_MOCKED':
      return 'Your phone reports that its location is being faked. Turn off any location-changing app and scan again.';
    case 'LOCATION_STALE':
      return 'Your location reading is out of date. Wait a moment for a fresh reading and scan again.';
    case 'LOCATION_TOO_IMPRECISE':
      return 'Your location reading is not precise enough. Move near a window, wait a few seconds and scan again.';
    case 'OUTSIDE_GEOFENCE': {
      const place = roomCode ? roomCode : 'the classroom';
      return check.distanceMetres === undefined
        ? `You appear to be outside ${place}.`
        : `You appear to be about ${roundDistanceForDisplay(check.distanceMetres)} m from ${place}. Check-in only works from inside the room.`;
    }
  }
}

/** Why activation was refused, for the lecturer. */
export function centreRefusalMessage(choice: Extract<CentreChoice, { ok: false }>): string {
  const remedy = 'Activate from a phone, or switch the geofence off for this session.';
  if (choice.reason === 'TOO_IMPRECISE' && choice.accuracyMetres !== undefined) {
    return `This room has no surveyed location and your device's location is only accurate to about ${roundDistanceForDisplay(choice.accuracyMetres)} m. ${remedy}`;
  }
  return `This room has no surveyed location and your device did not share one. ${remedy}`;
}

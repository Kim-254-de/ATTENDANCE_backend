import { describe, expect, it } from 'vitest';
import {
  centreRefusalMessage,
  checkReading,
  chooseCentre,
  distanceMetres,
  isWithinFence,
  rejectionMessage,
  roundDistanceForDisplay,
  type GeoPoint,
  type StudentReading,
} from '../../src/modules/session/session.geofence.js';

/** A lecture hall (roughly Egerton University, Njoro). */
const LH1: GeoPoint = { latitude: -0.3703, longitude: 35.9322 };
const CENTRE = { ...LH1, radiusMetres: 20 };

const T0 = new Date('2026-09-28T09:00:00.000Z');
const opts = { maxAccuracyMetres: 50, maxFixAgeSeconds: 60 };

/** A point `metres` due north of `from`. Along a meridian the haversine distance is exact. */
function north(from: GeoPoint, metres: number): GeoPoint {
  return { latitude: from.latitude + (metres / 6_371_008.8) * (180 / Math.PI), longitude: from.longitude };
}

function reading(overrides: Partial<StudentReading> = {}): StudentReading {
  return { ...LH1, accuracy: 10, capturedAt: T0, ...overrides };
}

describe('distanceMetres', () => {
  it('is zero for the same point', () => {
    expect(distanceMetres(LH1, LH1)).toBe(0);
  });

  it('is symmetric', () => {
    const other = { latitude: -0.3712, longitude: 35.9351 };
    expect(distanceMetres(LH1, other)).toBeCloseTo(distanceMetres(other, LH1), 9);
  });

  it('measures one degree of latitude as ~111.2 km', () => {
    expect(distanceMetres({ latitude: 0, longitude: 36 }, { latitude: 1, longitude: 36 })).toBeCloseTo(111_195, 0);
  });

  it('measures one degree of longitude at the equator as ~111.2 km', () => {
    expect(distanceMetres({ latitude: 0, longitude: 36 }, { latitude: 0, longitude: 37 })).toBeCloseTo(111_195, 0);
  });

  it('shrinks longitude distances away from the equator (cos 60° = 0.5)', () => {
    expect(distanceMetres({ latitude: 60, longitude: 0 }, { latitude: 60, longitude: 1 })).toBeCloseTo(55_597, -1);
  });

  it('matches a published city distance: Nairobi to Mombasa ~440 km', () => {
    const nairobi = { latitude: -1.2864, longitude: 36.8172 };
    const mombasa = { latitude: -4.0435, longitude: 39.6682 };
    const km = distanceMetres(nairobi, mombasa) / 1000;
    expect(km).toBeGreaterThan(435);
    expect(km).toBeLessThan(445);
  });

  it('is accurate at classroom scale', () => {
    expect(distanceMetres(LH1, north(LH1, 20))).toBeCloseTo(20, 6);
    expect(distanceMetres(LH1, north(LH1, 140))).toBeCloseTo(140, 6);
  });

  it('handles antipodal points without NaN', () => {
    const d = distanceMetres({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(d).toBeCloseTo(Math.PI * 6_371_008.8, 0);
  });

  it('handles the antimeridian', () => {
    expect(distanceMetres({ latitude: 0, longitude: 179.9999 }, { latitude: 0, longitude: -179.9999 })).toBeCloseTo(22.2, 1);
  });
});

describe('isWithinFence', () => {
  it('accepts exactly on the radius', () => {
    expect(isWithinFence(20, 0, 20)).toBe(true);
  });

  it('rejects just past the radius', () => {
    expect(isWithinFence(20.01, 0, 20)).toBe(false);
  });

  it('counts accuracy in the student’s favour', () => {
    expect(isWithinFence(35, 15, 20)).toBe(true);
    expect(isWithinFence(35.01, 15, 20)).toBe(false);
  });
});

describe('checkReading', () => {
  it('accepts a precise reading at the centre', () => {
    const result = checkReading(CENTRE, reading(), T0, opts);
    expect(result).toEqual({ accepted: true, distanceMetres: 0, accuracyMetres: 10 });
  });

  it('accepts a reading inside the radius', () => {
    const result = checkReading(CENTRE, reading({ ...north(LH1, 15), accuracy: 5 }), T0, opts);
    expect(result.accepted).toBe(true);
    expect(result.distanceMetres).toBeCloseTo(15, 3);
  });

  it('accepts a reading outside the radius when its accuracy could put it inside', () => {
    expect(checkReading(CENTRE, reading({ ...north(LH1, 35), accuracy: 16 }), T0, opts).accepted).toBe(true);
  });

  it('rejects a reading whose accuracy cannot put it inside', () => {
    const result = checkReading(CENTRE, reading({ ...north(LH1, 35), accuracy: 14 }), T0, opts);
    expect(result).toMatchObject({ accepted: false, reason: 'OUTSIDE_GEOFENCE', accuracyMetres: 14 });
    expect(result.distanceMetres).toBeCloseTo(35, 3);
  });

  it('rejects a student at home', () => {
    const result = checkReading(CENTRE, reading({ ...north(LH1, 2_000), accuracy: 5 }), T0, opts);
    expect(result).toMatchObject({ accepted: false, reason: 'OUTSIDE_GEOFENCE' });
  });

  it('requires a reading', () => {
    expect(checkReading(CENTRE, undefined, T0, opts)).toEqual({ accepted: false, reason: 'LOCATION_REQUIRED' });
  });

  it('treats impossible coordinates as no reading', () => {
    expect(checkReading(CENTRE, reading({ latitude: 91 }), T0, opts)).toMatchObject({ reason: 'LOCATION_REQUIRED' });
    expect(checkReading(CENTRE, reading({ longitude: Number.NaN }), T0, opts)).toMatchObject({
      reason: 'LOCATION_REQUIRED',
    });
  });

  it('rejects a reading the OS marks as mocked, even at the centre', () => {
    expect(checkReading(CENTRE, reading({ isMocked: true }), T0, opts)).toEqual({
      accepted: false,
      reason: 'LOCATION_MOCKED',
    });
  });

  it('accepts isMocked: false', () => {
    expect(checkReading(CENTRE, reading({ isMocked: false }), T0, opts).accepted).toBe(true);
  });

  describe('fix age', () => {
    const takenAt = (secondsBeforeT0: number) => new Date(T0.getTime() - secondsBeforeT0 * 1000);

    it('accepts a fix exactly at the age limit', () => {
      expect(checkReading(CENTRE, reading({ capturedAt: takenAt(60) }), T0, opts).accepted).toBe(true);
    });

    it('rejects a fix just past the age limit', () => {
      expect(checkReading(CENTRE, reading({ capturedAt: takenAt(61) }), T0, opts)).toMatchObject({
        reason: 'LOCATION_STALE',
      });
    });

    it('tolerates a phone clock slightly ahead', () => {
      expect(checkReading(CENTRE, reading({ capturedAt: takenAt(-30) }), T0, opts).accepted).toBe(true);
    });

    it('rejects a fix from far in the future', () => {
      expect(checkReading(CENTRE, reading({ capturedAt: takenAt(-3600) }), T0, opts)).toMatchObject({
        reason: 'LOCATION_STALE',
      });
    });

    it('rejects an invalid date', () => {
      expect(checkReading(CENTRE, reading({ capturedAt: new Date('nope') }), T0, opts)).toMatchObject({
        reason: 'LOCATION_STALE',
      });
    });
  });

  describe('accuracy limit', () => {
    it('accepts accuracy exactly at the limit', () => {
      expect(checkReading(CENTRE, reading({ accuracy: 50 }), T0, opts).accepted).toBe(true);
    });

    it('rejects accuracy just past the limit, even at the centre', () => {
      const result = checkReading(CENTRE, reading({ accuracy: 50.1 }), T0, opts);
      expect(result).toEqual({
        accepted: false,
        reason: 'LOCATION_TOO_IMPRECISE',
        distanceMetres: 0,
        accuracyMetres: 50.1,
      });
    });

    it('stops a vague reading from far away sneaking in through the accuracy allowance', () => {
      // 300 - 400 <= 20 would pass step 5 alone.
      expect(checkReading(CENTRE, reading({ ...north(LH1, 300), accuracy: 400 }), T0, opts)).toMatchObject({
        reason: 'LOCATION_TOO_IMPRECISE',
      });
    });

    it('rejects a negative accuracy', () => {
      expect(checkReading(CENTRE, reading({ accuracy: -1 }), T0, opts)).toMatchObject({
        reason: 'LOCATION_TOO_IMPRECISE',
      });
    });
  });

  it('checks in the documented order: mocked before stale before imprecise', () => {
    const everythingWrong = reading({
      isMocked: true,
      capturedAt: new Date(T0.getTime() - 600_000),
      accuracy: 500,
      ...north(LH1, 5_000),
    });
    expect(checkReading(CENTRE, everythingWrong, T0, opts)).toMatchObject({ reason: 'LOCATION_MOCKED' });
    expect(checkReading(CENTRE, { ...everythingWrong, isMocked: false }, T0, opts)).toMatchObject({
      reason: 'LOCATION_STALE',
    });
    expect(checkReading(CENTRE, { ...everythingWrong, isMocked: false, capturedAt: T0 }, T0, opts)).toMatchObject({
      reason: 'LOCATION_TOO_IMPRECISE',
    });
  });

  it('uses the session’s radius', () => {
    const wide = { ...CENTRE, radiusMetres: 100 };
    expect(checkReading(wide, reading({ ...north(LH1, 90), accuracy: 5 }), T0, opts).accepted).toBe(true);
  });
});

describe('chooseCentre', () => {
  const surveyed = { latitude: LH1.latitude, longitude: LH1.longitude, surveyedAccuracyMetres: 4 };
  const unsurveyed = { latitude: null, longitude: null, surveyedAccuracyMetres: null };
  const lecturer = { ...north(LH1, 10), accuracy: 12 };
  const max = { maxAnchorAccuracyMetres: 30 };

  it('uses the surveyed room', () => {
    expect(chooseCentre(surveyed, undefined, max)).toEqual({
      ok: true,
      mode: 'ROOM',
      latitude: LH1.latitude,
      longitude: LH1.longitude,
      anchorAccuracyMetres: 4,
    });
  });

  it('prefers the surveyed room over the lecturer’s device', () => {
    expect(chooseCentre(surveyed, lecturer, max)).toMatchObject({ mode: 'ROOM', latitude: LH1.latitude });
  });

  it('falls back to the lecturer’s device for an unsurveyed room', () => {
    expect(chooseCentre(unsurveyed, lecturer, max)).toEqual({
      ok: true,
      mode: 'LECTURER_DEVICE',
      latitude: lecturer.latitude,
      longitude: lecturer.longitude,
      anchorAccuracyMetres: 12,
    });
  });

  it('falls back to the lecturer’s device when the class has no room', () => {
    expect(chooseCentre(null, lecturer, max)).toMatchObject({ mode: 'LECTURER_DEVICE' });
  });

  it('accepts a lecturer reading exactly at the anchor limit', () => {
    expect(chooseCentre(null, { ...lecturer, accuracy: 30 }, max).ok).toBe(true);
  });

  it('refuses a lecturer reading just past the anchor limit', () => {
    expect(chooseCentre(null, { ...lecturer, accuracy: 30.5 }, max)).toEqual({
      ok: false,
      reason: 'TOO_IMPRECISE',
      accuracyMetres: 30.5,
    });
  });

  it('refuses when there is neither a room nor a reading', () => {
    expect(chooseCentre(unsurveyed, undefined, max)).toEqual({ ok: false, reason: 'NO_READING' });
  });

  it('refuses impossible lecturer coordinates', () => {
    expect(chooseCentre(null, { latitude: 200, longitude: 0, accuracy: 5 }, max)).toEqual({
      ok: false,
      reason: 'NO_READING',
    });
  });
});

describe('messages', () => {
  it('rounds distances without false precision', () => {
    expect(roundDistanceForDisplay(0.2)).toBe(1);
    expect(roundDistanceForDisplay(23.4)).toBe(23);
    expect(roundDistanceForDisplay(139.6)).toBe(140);
    expect(roundDistanceForDisplay(1234)).toBe(1230);
  });

  it('tells a student outside the fence how far away they appear to be', () => {
    const message = rejectionMessage({ accepted: false, reason: 'OUTSIDE_GEOFENCE', distanceMetres: 139.6 }, 'LH1');
    expect(message).toContain('about 140 m from LH1');
  });

  it('falls back to "the classroom" when the room is unknown', () => {
    const message = rejectionMessage({ accepted: false, reason: 'OUTSIDE_GEOFENCE', distanceMetres: 80 }, null);
    expect(message).toContain('from the classroom');
  });

  it('tells a student with a vague reading to move near a window', () => {
    expect(rejectionMessage({ accepted: false, reason: 'LOCATION_TOO_IMPRECISE' })).toMatch(/window/);
  });

  it('tells the lecturer how to get past a refused activation', () => {
    expect(centreRefusalMessage({ ok: false, reason: 'TOO_IMPRECISE', accuracyMetres: 120 })).toMatch(
      /about 120 m.*phone.*geofence off/,
    );
    expect(centreRefusalMessage({ ok: false, reason: 'NO_READING' })).toMatch(/phone.*geofence off/);
  });
});

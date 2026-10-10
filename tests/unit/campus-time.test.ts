import { describe, expect, it } from 'vitest';
import { atCampusTime, campusClock, isValidTimeZone } from '../../src/common/utils/campus-time.js';

/**
 * Timetable slots are campus time; the server's clock is usually UTC. These
 * use fixed instants, so they hold whatever zone the test machine is in.
 */
describe('campus time', () => {
  const NAIROBI = 'Africa/Nairobi'; // EAT, UTC+3, no DST

  it('reads the campus weekday and time of day, not the server\'s', () => {
    // 09:33 UTC on Thursday 1 Oct 2026 is 12:33 in Nairobi.
    expect(campusClock(new Date('2026-10-01T09:33:00Z'), NAIROBI)).toEqual({ dayOfWeek: 4, timeOfDay: '12:33' });
    // 22:30 UTC Saturday is already 01:30 Sunday on campus.
    expect(campusClock(new Date('2026-10-03T22:30:00Z'), NAIROBI)).toEqual({ dayOfWeek: 0, timeOfDay: '01:30' });
  });

  it('turns a slot time into the instant it happens on campus that day', () => {
    expect(atCampusTime(new Date('2026-10-01T09:33:00Z'), '12:00', NAIROBI).toISOString()).toBe('2026-10-01T09:00:00.000Z');
    expect(atCampusTime(new Date('2026-10-01T09:33:00Z'), '14:00', NAIROBI).toISOString()).toBe('2026-10-01T11:00:00.000Z');
    // The campus day, not the UTC one: 22:30 UTC Saturday is Sunday on campus.
    expect(atCampusTime(new Date('2026-10-03T22:30:00Z'), '08:00', NAIROBI).toISOString()).toBe('2026-10-04T05:00:00.000Z');
  });

  it('handles a zone with daylight saving', () => {
    // London is UTC+1 in summer (BST), UTC+0 in winter.
    expect(atCampusTime(new Date('2026-07-01T12:00:00Z'), '09:00', 'Europe/London').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(atCampusTime(new Date('2026-12-01T12:00:00Z'), '09:00', 'Europe/London').toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });

  it('knows a real zone from a typo', () => {
    expect(isValidTimeZone(NAIROBI)).toBe(true);
    expect(isValidTimeZone('Africa/Nairob')).toBe(false);
  });
});

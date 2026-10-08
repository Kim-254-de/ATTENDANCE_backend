import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `resolveWindow` decides when a session closes, which room it is fenced to,
 * and — since db/migrations/021_departments.sql — what its meeting was *due*
 * to start, which is the whole basis of the department module's lecturer
 * punctuality figures. Getting `scheduledStartAt` wrong would silently mark
 * every lecturer late (or every lecturer punctual), so it is asserted against
 * fixed instants rather than inferred.
 *
 * Only the timetable lookup is stubbed; the campus-time arithmetic under test
 * is the real one.
 */
const findUnitSlots = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/unit/index.js', () => ({ findUnitSlots }));

const { resolveWindow } = await import('../../src/modules/session/session.service.js');

const UNIT = '11111111-1111-4111-8111-111111111111';

// Thursday 1 Oct 2026. Campus is Africa/Nairobi (UTC+3, no DST), so 06:10 UTC
// is 09:10 on campus — ten minutes into an 09:00–11:00 lecture.
const THURSDAY = 4;
const slot = (startTime: string, endTime: string, roomCode: string | null = 'LH1') => ({
  dayOfWeek: THURSDAY,
  startTime,
  endTime,
  roomCode,
});

afterEach(() => { findUnitSlots.mockReset(); });

describe('resolveWindow scheduledStartAt', () => {
  it('reports the matched slot\'s own start, not when the lecturer pressed activate', async () => {
    findUnitSlots.mockResolvedValue([slot('09:00', '11:00')]);

    const activatedAt = new Date('2026-10-01T06:10:00Z'); // 09:10 campus time
    const window = await resolveWindow(UNIT, activatedAt, undefined);

    expect(window.scheduledStartAt?.toISOString()).toBe('2026-10-01T06:00:00.000Z');
    expect(window.closesAt.toISOString()).toBe('2026-10-01T08:00:00.000Z');
    expect(window.roomCode).toBe('LH1');
    // Ten minutes late — the figure the department module derives from this.
    expect((activatedAt.getTime() - window.scheduledStartAt!.getTime()) / 60_000).toBe(10);
  });

  it('is exactly opensAt for a class activated on the minute, so lateMinutes is 0', async () => {
    findUnitSlots.mockResolvedValue([slot('14:00', '16:00')]);

    const activatedAt = new Date('2026-10-01T11:00:00Z'); // 14:00 campus time
    const window = await resolveWindow(UNIT, activatedAt, undefined);

    expect(window.scheduledStartAt?.getTime()).toBe(activatedAt.getTime());
  });

  it('picks the meeting actually happening now when the unit meets twice that day', async () => {
    findUnitSlots.mockResolvedValue([slot('08:00', '10:00', 'LH1'), slot('14:00', '16:00', 'LAB2')]);

    const window = await resolveWindow(UNIT, new Date('2026-10-01T11:30:00Z'), undefined); // 14:30 campus
    expect(window.scheduledStartAt?.toISOString()).toBe('2026-10-01T11:00:00.000Z');
    expect(window.roomCode).toBe('LAB2');
  });

  it('is null when the unit has no schedule at all — there is nothing to be late against', async () => {
    findUnitSlots.mockResolvedValue([]);

    const clientClosesAt = new Date('2026-10-01T08:00:00Z');
    const window = await resolveWindow(UNIT, new Date('2026-10-01T06:10:00Z'), clientClosesAt);

    expect(window.scheduledStartAt).toBeNull();
    expect(window.closesAt).toBe(clientClosesAt);
    expect(window.roomCode).toBeNull();
  });

  it('still refuses activation outside every slot, rather than reporting a start to be late against', async () => {
    findUnitSlots.mockResolvedValue([slot('08:00', '10:00')]);

    // 13:00 campus time on a day the unit does meet, but between meetings.
    await expect(resolveWindow(UNIT, new Date('2026-10-01T10:00:00Z'), undefined)).rejects.toThrow(
      /only activate this class during its scheduled time/,
    );
  });
});

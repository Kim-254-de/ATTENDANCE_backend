/**
 * Wall-clock time on campus.
 *
 * Timetable slots ("Monday 08:00-10:00") are campus time, but the server's
 * own clock is usually UTC (Render, Docker), and JS Date's getDay/getHours/
 * setHours use the server's zone. Reading the slot against those makes a
 * class at 12:00 EAT look like it starts at 09:00, so every time-of-day
 * decision goes through here with the campus zone (CAMPUS_TIMEZONE).
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=Sunday..6=Saturday, like unit_schedule.day_of_week. */
  dayOfWeek: number;
}

function wallClock(at: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    dayOfWeek: WEEKDAYS.indexOf(parts['weekday'] ?? ''),
  };
}

/** The campus weekday (0=Sunday) and "HH:MM" at an instant. */
export function campusClock(at: Date, timeZone: string): { dayOfWeek: number; timeOfDay: string } {
  const c = wallClock(at, timeZone);
  return { dayOfWeek: c.dayOfWeek, timeOfDay: `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}` };
}

/** The instant it is "HH:MM" on campus, on the campus calendar day of `date`. */
export function atCampusTime(date: Date, hhmm: string, timeZone: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  const { year, month, day } = wallClock(date, timeZone);
  // Read the wall time as if it were UTC, then shift by the zone's offset at
  // that moment. Twice, so a DST change between the guess and the answer
  // still lands on the right side (campus zones rarely have DST, but some do).
  const asUtc = Date.UTC(year, month - 1, day, hh ?? 0, mm ?? 0);
  let result = asUtc;
  for (let i = 0; i < 2; i++) {
    const c = wallClock(new Date(result), timeZone);
    const offset = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - result;
    result = asUtc - offset;
  }
  return new Date(result);
}

/** True when `timeZone` is a zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

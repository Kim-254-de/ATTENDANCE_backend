import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { smartttClient } from '../../integrations/smarttt/index.js';
import * as studentRepository from './student.repository.js';
import type { TimetableUnitRow } from './student.repository.js';
import type { AttendanceHistoryQuery } from './student.schema.js';

/**
 * What a signed-in student sees about their own classes. Read-only, and only
 * ever their own rows: every query is keyed on the caller's user id.
 */

/** Percentage to one decimal place; null before any session has been held. */
const rate = (attended: number, held: number): number | null =>
  held > 0 ? Math.round((attended / held) * 1000) / 10 : null;

export interface StudentUnitDto {
  /** The unit here; null for a unit known only from SMARTTT (onRoster false). */
  id: string | null;
  /** The class: "COSC 103 GR A", or "COSC 103" when the unit isn't split into groups. */
  code: string;
  name: string | null;
  baseCode: string | null;
  group: string | null;
  /** Null when SMARTTT names no lecturer for a unit not set up here yet. */
  lecturerName: string | null;
  /** The weekly slot, when the unit has exactly one. */
  schedule: { dayOfWeek: number; startTime: string; endTime: string } | null;
  sessionsHeld: number;
  sessionsAttended: number;
  /** 0–100, one decimal; null until a session has been held. */
  attendanceRate: number | null;
  /**
   * True when the student is on the unit's class list here, so can check in.
   * False for a unit SMARTTT has them registered for that their lecturer
   * hasn't set up here yet (or hasn't synced since they registered).
   */
  onRoster: boolean;
  /** A split unit they haven't picked a group for in SMARTTT: no group's class list will include them. */
  groupRequired: boolean;
}

/**
 * The student's units: those they're on the class list for here, with their
 * attendance in each, then any others SMARTTT has them registered for this
 * term (refreshed first, when SMARTTT is configured), matched by class code.
 */
export async function listMyUnits(studentUserId: string): Promise<StudentUnitDto[]> {
  await syncMyUnitsFromTimetable(studentUserId);
  const [rows, timetable] = await Promise.all([
    studentRepository.findUnitsForStudent(studentUserId),
    studentRepository.findTimetableUnits(studentUserId),
  ]);

  const onRoster = rows.map((r): StudentUnitDto => ({
    id: r.id,
    code: r.code,
    name: r.name,
    baseCode: r.base_code,
    group: r.class_group,
    lecturerName: r.lecturer_name,
    schedule:
      r.day_of_week === null || r.start_time === null || r.end_time === null
        ? null
        : { dayOfWeek: r.day_of_week, startTime: r.start_time.slice(0, 5), endTime: r.end_time.slice(0, 5) },
    sessionsHeld: r.sessions_held,
    sessionsAttended: r.sessions_attended,
    attendanceRate: rate(r.sessions_attended, r.sessions_held),
    onRoster: true,
    groupRequired: false,
  }));

  const listed = new Set(rows.map((r) => r.code));
  const notYetHere = timetable.filter((t) => !listed.has(t.code)).map(toTimetableUnitDto);
  return [...onRoster, ...notYetHere];
}

function toTimetableUnitDto(t: TimetableUnitRow): StudentUnitDto {
  const distinct = new Map(t.slots.map((s) => [`${s.dayOfWeek}|${s.startTime}|${s.endTime}`, s]));
  const [slot] = distinct.values();
  return {
    id: null,
    code: t.code,
    name: t.name,
    baseCode: t.base_code,
    group: t.class_group,
    lecturerName: t.lecturer_names.length > 0 ? t.lecturer_names.join(', ') : null,
    schedule: distinct.size === 1 && slot ? { dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime } : null,
    sessionsHeld: 0,
    sessionsAttended: 0,
    attendanceRate: null,
    onRoster: false,
    groupRequired: t.group_required,
  };
}

// ---------------------------------------------------------------------------
// Sync from SMARTTT
// ---------------------------------------------------------------------------

/** Per student: when the last sync was attempted, and any sync still running. */
const lastSyncAttempt = new Map<string, number>();
const syncInFlight = new Map<string, Promise<void>>();

/**
 * Pulls the classes SMARTTT has the student registered for this term and
 * replaces what is on file for them. Same rules as the lecturer's unit sync
 * (unit.service.ts syncUnitsFromTimetable): throttled per student
 * (SMARTTT_SYNC_INTERVAL_SECONDS, failed attempts included), and fails soft —
 * if SMARTTT is off, asleep or wrong, the student sees what was last synced.
 * Never throws.
 *
 * Display only: it never puts a student on a class list. Who can check in is
 * still decided by the roster the lecturer's sync brings from SMARTTT.
 */
export async function syncMyUnitsFromTimetable(studentUserId: string): Promise<void> {
  if (!smartttClient.enabled) return;

  const running = syncInFlight.get(studentUserId);
  if (running) return running;

  const last = lastSyncAttempt.get(studentUserId);
  if (last !== undefined && Date.now() - last < env.SMARTTT_SYNC_INTERVAL_SECONDS * 1000) return;
  lastSyncAttempt.set(studentUserId, Date.now());

  const sync = runTimetableSync(studentUserId)
    .catch((error: unknown) => {
      logger.error({ err: error, studentUserId }, 'smarttt student unit sync failed; showing units already on file');
    })
    .finally(() => syncInFlight.delete(studentUserId));
  syncInFlight.set(studentUserId, sync);
  return sync;
}

/** Test seam: forget throttling state between cases. */
export function resetStudentTimetableSyncState(): void {
  lastSyncAttempt.clear();
  syncInFlight.clear();
}

async function runTimetableSync(studentUserId: string): Promise<void> {
  const registrationNumber = await studentRepository.findRegistrationNumber(studentUserId);
  if (!registrationNumber) return;

  const result = await smartttClient.listStudentUnits(registrationNumber);
  if (result.status === 'NOT_FOUND') {
    // SMARTTT no longer lists the student: nothing to show from it.
    await studentRepository.replaceTimetableUnits(studentUserId, []);
    return;
  }
  if (result.status !== 'FOUND') {
    logger.warn({ studentUserId, status: result.status }, 'smarttt student unit sync skipped');
    return;
  }
  await studentRepository.replaceTimetableUnits(
    studentUserId,
    result.units.map((u) => ({
      code: u.code,
      baseCode: u.baseCode,
      group: u.group,
      name: u.name,
      groupRequired: u.groupRequired,
      lecturers: u.lecturers,
      slots: u.slots.map(({ dayOfWeek, startTime, endTime, room }) => ({ dayOfWeek, startTime, endTime, room })),
    })),
  );
}

/**
 * - PRESENT: the student checked in.
 * - OPEN: the class is still taking check-ins, so it isn't an absence yet.
 * - ABSENT: the class is over and there is no check-in.
 */
export type AttendanceMark = 'PRESENT' | 'OPEN' | 'ABSENT';

export interface AttendanceRecordDto {
  sessionId: string;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  title: string | null;
  opensAt: string;
  closesAt: string;
  mark: AttendanceMark;
  recordedAt: string | null;
}

export interface AttendanceHistoryDto {
  /** Over the sessions returned, so it matches the list shown. */
  summary: { sessionsHeld: number; attended: number; attendanceRate: number | null };
  records: AttendanceRecordDto[];
}

export async function listMyAttendance(
  studentUserId: string,
  options: AttendanceHistoryQuery,
): Promise<AttendanceHistoryDto> {
  const rows = await studentRepository.findAttendanceHistory(studentUserId, options);
  const now = Date.now();
  const records = rows.map((r): AttendanceRecordDto => {
    const stillOpen = r.status !== 'CLOSED' && r.closes_at.getTime() > now;
    return {
      sessionId: r.session_id,
      unitId: r.unit_id,
      unitCode: r.unit_code,
      unitName: r.unit_name,
      title: r.title,
      opensAt: r.opens_at.toISOString(),
      closesAt: r.closes_at.toISOString(),
      mark: r.recorded_at ? 'PRESENT' : stillOpen ? 'OPEN' : 'ABSENT',
      recordedAt: r.recorded_at?.toISOString() ?? null,
    };
  });

  // A class still taking check-ins doesn't count against the student yet.
  const counted = records.filter((r) => r.mark !== 'OPEN');
  const attended = counted.filter((r) => r.mark === 'PRESENT').length;
  return {
    summary: { sessionsHeld: counted.length, attended, attendanceRate: rate(attended, counted.length) },
    records,
  };
}

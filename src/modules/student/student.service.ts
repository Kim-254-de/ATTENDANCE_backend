import * as studentRepository from './student.repository.js';
import type { AttendanceHistoryQuery } from './student.schema.js';

/**
 * What a signed-in student sees about their own classes. Read-only, and only
 * ever their own rows: every query is keyed on the caller's user id.
 */

/** Percentage to one decimal place; null before any session has been held. */
const rate = (attended: number, held: number): number | null =>
  held > 0 ? Math.round((attended / held) * 1000) / 10 : null;

export interface StudentUnitDto {
  id: string;
  /** The class: "COSC 103 GR A", or "COSC 103" when the unit isn't split into groups. */
  code: string;
  name: string | null;
  baseCode: string | null;
  group: string | null;
  lecturerName: string;
  /** The weekly slot, when the unit has exactly one. */
  schedule: { dayOfWeek: number; startTime: string; endTime: string } | null;
  sessionsHeld: number;
  sessionsAttended: number;
  /** 0–100, one decimal; null until a session has been held. */
  attendanceRate: number | null;
}

export async function listMyUnits(studentUserId: string): Promise<StudentUnitDto[]> {
  const rows = await studentRepository.findUnitsForStudent(studentUserId);
  return rows.map((r) => ({
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
  }));
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

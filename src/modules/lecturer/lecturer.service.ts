import { getSummary, listStudents as findStudents } from './lecturer.repository.js';

export interface OverviewDto {
  totalStudents: number;
  unitsTaught: number;
  avgAttendance: number;
  sessionsHeld: number;
  periodLabel: string;
}

/**
 * Powers both the Dashboard's stat cards and the Profile page's teaching
 * summary — same four real numbers either place. `periodLabel` is honestly
 * "All time": there's no semester/academic-period concept anywhere in this
 * schema to scope it to.
 */
export async function getOverview(lecturerUserId: string): Promise<OverviewDto> {
  const summary = await getSummary(lecturerUserId);
  return {
    totalStudents: summary.totalStudents,
    unitsTaught: summary.unitsAllocated,
    avgAttendance: Math.round(summary.avgAttendance * 10) / 10,
    sessionsHeld: summary.sessionsHeld,
    periodLabel: 'All time',
  };
}

export interface LecturerStudentDto {
  id: string;
  registrationNumber: string | null;
  studentUserId: string | null;
  fullName: string | null;
  unitId: string;
  unitCode: string;
  unitName: string | null;
  sessionsHeld: number;
  sessionsAttended: number;
  /** 0–100, one decimal; null until a session has been held for this unit. */
  attendanceRate: number | null;
}

const rate = (attended: number, held: number): number | null =>
  held > 0 ? Math.round((attended / held) * 1000) / 10 : null;

/** The Students page: every active student across every unit this lecturer teaches, with their real per-unit attendance rate. */
export async function listStudents(lecturerUserId: string): Promise<LecturerStudentDto[]> {
  const rows = await findStudents(lecturerUserId);
  return rows.map((r) => ({
    id: r.id,
    registrationNumber: r.registration_number,
    studentUserId: r.student_user_id,
    fullName: r.full_name,
    unitId: r.unit_id,
    unitCode: r.unit_code,
    unitName: r.unit_name,
    sessionsHeld: r.sessions_held,
    sessionsAttended: r.sessions_attended,
    attendanceRate: rate(r.sessions_attended, r.sessions_held),
  }));
}

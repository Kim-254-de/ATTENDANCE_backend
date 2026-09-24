import { getSummary } from './lecturer.repository.js';

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

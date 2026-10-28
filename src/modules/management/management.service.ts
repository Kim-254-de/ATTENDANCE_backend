import { AppError } from '../../common/errors/index.js';
import * as managementRepository from './management.repository.js';

/**
 * University-wide attendance for management, read-only, in three levels:
 * departments -> a department's years -> one year's units with their
 * lecturer and students. Any MANAGEMENT account sees every department;
 * there is no scope to resolve.
 */

export interface UniversityDto {
  totals: { departmentCount: number; checkIns: number; sessionsHeld: number };
  departments: managementRepository.DepartmentRow[];
}

/** GET /management/departments */
export async function getUniversity(): Promise<UniversityDto> {
  const departments = await managementRepository.listDepartments();
  return {
    totals: {
      departmentCount: departments.length,
      checkIns: departments.reduce((sum, d) => sum + d.checkIns, 0),
      sessionsHeld: departments.reduce((sum, d) => sum + d.sessionsHeld, 0),
    },
    departments,
  };
}

async function requireDepartment(departmentId: string): Promise<managementRepository.DepartmentHeader> {
  const department = await managementRepository.findDepartment(departmentId);
  if (!department) throw AppError.notFound('Department not found.');
  return department;
}

export interface DepartmentYearsDto extends managementRepository.DepartmentHeader {
  years: managementRepository.YearRow[];
  /** Units whose code puts them in no year (postgraduate). */
  unitsWithoutYear: number;
}

/** GET /management/departments/:departmentId */
export async function getDepartment(departmentId: string): Promise<DepartmentYearsDto> {
  const department = await requireDepartment(departmentId);
  return { ...department, ...(await managementRepository.listYears(departmentId)) };
}

export interface YearStudentDto {
  studentUserId: string | null;
  registrationNumber: string | null;
  fullName: string | null;
  yearOfStudy: number | null;
  sessionsHeld: number;
  sessionsAttended: number;
  /** attended / held, 0–100. Null until one of the unit's classes has been held. */
  attendanceRate: number | null;
}

export interface YearUnitDto extends managementRepository.YearUnitRow {
  students: YearStudentDto[];
}

export interface YearDetailDto extends managementRepository.DepartmentHeader {
  year: number;
  units: YearUnitDto[];
}

/** GET /management/departments/:departmentId/years/:year */
export async function getYear(departmentId: string, year: number): Promise<YearDetailDto> {
  const department = await requireDepartment(departmentId);
  const units = await managementRepository.listYearUnits(departmentId, year);
  const students = await managementRepository.listUnitStudents(units.map((u) => u.unitId));
  const byUnit = new Map<string, YearStudentDto[]>();
  for (const { unitId, ...s } of students) {
    const list = byUnit.get(unitId) ?? [];
    list.push({ ...s, attendanceRate: s.sessionsHeld > 0 ? (s.sessionsAttended / s.sessionsHeld) * 100 : null });
    byUnit.set(unitId, list);
  }
  return { ...department, year, units: units.map((u) => ({ ...u, students: byUnit.get(u.unitId) ?? [] })) };
}

/**
 * What SMARTTT (the university timetable system) says a lecturer teaches this
 * term. Served by SMARTTT's GET /api/v1/integrations/attendance/lecturer-units/.
 */

export interface SmartttSlot {
  /** 0=Sunday..6=Saturday, matches JS Date#getDay() and unit_schedule.day_of_week. */
  dayOfWeek: number;
  startTime: string; // "HH:MM"
  endTime: string;
  /** Normalised like unit codes ("LH1"); matches rooms.code. Null when SMARTTT names no room. */
  room: string | null;
  classGroup: string;
}

/** A student SMARTTT has registered for a unit this term. */
export interface SmartttStudent {
  /** Uppercased, as unit_allocations stores it. */
  registrationNumber: string;
  fullName: string | null;
}

/**
 * One class the lecturer teaches: a unit, or one teaching group of a unit
 * that is split into groups (COSC 103 GR A, GR B ...) taught by different
 * lecturers. Each class becomes its own unit here.
 */
export interface SmartttUnit {
  /** The class, normalised like unit codes here: "COSC 103 GR A", or "COSC 103" when not split. */
  code: string;
  /** The unit itself: "COSC 103". */
  baseCode: string;
  /** "GR A"; null for a unit that isn't split. */
  group: string | null;
  name: string;
  /** Students registered for this class this term, per SMARTTT: the whole unit, or only this group. */
  registeredStudents: number;
  /** For a group: students registered for the unit who haven't picked a group yet, so are on no roster. */
  studentsWithoutGroup: number;
  /**
   * How SMARTTT tied the unit to this lecturer:
   * - ACCOUNT: a slot is linked to the lecturer's SMARTTT account (by staff number).
   * - NAME: only the department allocation's lecturer name matched. Weaker, so
   *   a unit created from it still needs an admin to verify it.
   */
  matchedBy: 'ACCOUNT' | 'NAME';
  slots: SmartttSlot[];
  /**
   * Who is registered, for the unit's roster. Can be shorter than
   * registeredStudents: SMARTTT leaves out students with no registration number.
   */
  students: SmartttStudent[];
}

export interface SmartttTerm {
  academicYear: string;
  semester: number;
}

/** A student as SMARTTT holds them, for checking a student registration. */
export interface SmartttStudentRecord {
  registrationNumber: string;
  fullName: string | null;
  /** Lower-cased. Null when SMARTTT has no email for them. */
  email: string | null;
  programme: string | null;
  yearOfStudy: number | null;
  /** False for graduated, withdrawn, suspended or disabled students. */
  isActive: boolean;
  raw: unknown;
}

/** A member of staff on SMARTTT's approved staff list, for checking a lecturer registration. */
export interface SmartttStaffRecord {
  staffNumber: string;
  /** From their SMARTTT account, else the name in the admin's staff-ID upload. */
  fullName: string | null;
  /** Lower-cased. Null until they have a SMARTTT account. */
  email: string | null;
  department: string | null;
  faculty: string | null;
  title: string | null;
  isActive: boolean;
  raw: unknown;
}

export type SmartttStaffLookupResult =
  | { status: 'FOUND'; record: SmartttStaffRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

export type SmartttStudentLookupResult =
  | { status: 'FOUND'; record: SmartttStudentRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

export type SmartttLecturerUnitsResult =
  | { status: 'FOUND'; term: SmartttTerm | null; units: SmartttUnit[] }
  /** SMARTTT has no lecturer with this staff number (and could not match the name). */
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string }
  /** SMARTTT_BASE_URL is not configured. */
  | { status: 'DISABLED' };

/**
 * One class a student is registered for this term, per SMARTTT's
 * GET /api/v1/integrations/attendance/student-units/. `code` is the same
 * section code the lecturer-units sync gives the unit here.
 */
export interface SmartttStudentUnit {
  /** "COSC 103 GR A", or "COSC 103" when not split; normalised like unit codes. */
  code: string;
  baseCode: string;
  group: string | null;
  name: string;
  /** A split unit the student hasn't picked a group for yet: on no group's roster. */
  groupRequired: boolean;
  lecturers: string[];
  slots: SmartttSlot[];
}

export type SmartttStudentUnitsResult =
  | { status: 'FOUND'; term: SmartttTerm | null; units: SmartttStudentUnit[] }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

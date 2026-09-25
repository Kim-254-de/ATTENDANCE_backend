/**
 * The shape the rest of the application works with. The real ERP payload is
 * translated into this in erp.mapper.ts and nowhere else, so swapping ERP
 * vendors or endpoint versions touches exactly one file.
 */

/** A staff record as the ERP knows it, normalised. */
export interface ErpStaffRecord {
  /** The ERP's own primary key for this person, kept for reconciliation. */
  erpStaffId: string;
  staffNumber: string;
  fullName: string;
  email: string | null;
  /** False for retired, suspended or otherwise non-serving staff. */
  isActive: boolean;
  department: string | null;
  faculty: string | null;
  title: string | null;
  /** Untouched ERP payload, stored as evidence against future disputes. */
  raw: unknown;
}

/** A student record as the ERP knows it, normalised. */
export interface ErpStudentRecord {
  registrationNumber: string;
  fullName: string;
  programme: string | null;
  yearOfStudy: number | null;
  /** False for deferred, graduated or discontinued students. */
  isActive: boolean;
  raw: unknown;
}

export type ErpStudentLookupResult =
  | { status: 'FOUND'; record: ErpStudentRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'INACTIVE'; record: ErpStudentRecord }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * A course record as the issued timetable knows it: the ground truth for a
 * unit's real name and weekly meeting slot, and who's assigned to teach it.
 */
export interface ErpCourseRecord {
  code: string;
  name: string;
  /** The staff number the timetable assigns to teach it, if any. */
  staffNumber: string | null;
  /** 0=Sunday..6=Saturday, matches JS Date#getDay(). */
  dayOfWeek: number;
  startTime: string; // "HH:MM"
  endTime: string;
  /** False for a retired/discontinued course. */
  isActive: boolean;
  raw: unknown;
}

export type ErpCourseLookupResult =
  | { status: 'FOUND'; record: ErpCourseRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Who the registrar's records enrol in a course — a unit's real roster.
 * FOUND with an empty array is a normal, valid answer (nobody enrolled yet);
 * NOT_FOUND means the course itself isn't on the timetable any more.
 */
export type ErpEnrollmentsResult =
  | { status: 'FOUND'; students: ErpStudentRecord[] }
  | { status: 'NOT_FOUND' }
  | { status: 'UNAVAILABLE'; reason: string };

/**
 * Why a lookup ended the way it did. Mirrors ErpVerificationOutcome in
 * src/db/types.ts so an outcome can be written straight to the audit log.
 */
export type ErpLookupStatus =
  | 'VERIFIED'
  | 'NOT_FOUND'
  | 'INACTIVE'
  | 'IDENTITY_MISMATCH'
  | 'UNAVAILABLE';

export type ErpLookupResult =
  | { status: 'VERIFIED'; record: ErpStaffRecord }
  | { status: 'NOT_FOUND' }
  | { status: 'INACTIVE'; record: ErpStaffRecord }
  | { status: 'IDENTITY_MISMATCH'; record: ErpStaffRecord; mismatchedFields: string[] }
  | { status: 'UNAVAILABLE'; reason: string };

/** What the caller claims, checked against what the ERP holds. */
export interface ClaimedIdentity {
  fullName: string;
  email: string;
}

export interface ErpProvider {
  /**
   * Looks a staff number up in the ERP.
   *
   * Never throws for a business outcome — a missing or inactive record is a
   * returned status, not an exception. It only rejects if something truly
   * unexpected happens, and even transport failures come back as UNAVAILABLE.
   */
  verifyStaffNumber(staffNumber: string, claimed: ClaimedIdentity): Promise<ErpLookupResult>;
}

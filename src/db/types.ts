/**
 * Domain types for the rows this service reads and writes.
 *
 * This service does NOT own or create the schema — it calls a database that
 * already exists. These types describe what the queries expect to find, and
 * are the contract to check against when the real database is introspected.
 * See `docs/expected-schema.md` for the columns each query touches.
 */

export const UserRole = {
  LECTURER: 'LECTURER',
  STUDENT: 'STUDENT',
  ADMIN: 'ADMIN',
  /** A department officer: read-only oversight of one department's teaching (db/migrations/020_departments.sql). */
  DEPARTMENT: 'DEPARTMENT',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const AccountStatus = {
  /** Created, but the email address has not been confirmed yet. */
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  /** Email confirmed; waiting for an administrator to approve (lecturers). */
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  /** Fully usable — only an ACTIVE account may authenticate. */
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DEACTIVATED: 'DEACTIVATED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

/** Mirrors the ERP lookup outcomes, so a verdict can be written straight to the audit trail. */
export const ErpVerificationOutcome = {
  VERIFIED: 'VERIFIED',
  NOT_FOUND: 'NOT_FOUND',
  INACTIVE: 'INACTIVE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;
export type ErpVerificationOutcome =
  (typeof ErpVerificationOutcome)[keyof typeof ErpVerificationOutcome];

/** Lifecycle of a class meeting. Only an OPEN session issues or accepts codes. */
export const AttendanceSessionStatus = {
  OPEN: 'OPEN',
  /** Temporarily not accepting scans; codes resume on OPEN. */
  PAUSED: 'PAUSED',
  /** Terminal — a closed session is never reopened. */
  CLOSED: 'CLOSED',
} as const;
export type AttendanceSessionStatus =
  (typeof AttendanceSessionStatus)[keyof typeof AttendanceSessionStatus];

/** Whether a student on a unit may check in. Only ACTIVE may. */
export const AllocationStatus = {
  ACTIVE: 'ACTIVE',
  /** A student asked to join; waits for the lecturer. */
  PENDING: 'PENDING',
  /** Removed by the lecturer. Kept, not deleted, so past attendance still has its context. */
  DROPPED: 'DROPPED',
} as const;
export type AllocationStatus = (typeof AllocationStatus)[keyof typeof AllocationStatus];

/** Where a session's geofence is centred, fixed at activation (db/migrations/012_geofence.sql). */
export const GeofenceMode = {
  /** The room's surveyed centre point. */
  ROOM: 'ROOM',
  /** The lecturer's device location at activation, for a room not yet surveyed. */
  LECTURER_DEVICE: 'LECTURER_DEVICE',
  /**
   * Activated with no reading (e.g. from a laptop) in an unsurveyed room. No centre yet:
   * scans are held until the lecturer sends one from their phone.
   */
  AWAITING_LOCATION: 'AWAITING_LOCATION',
  /** No location check; the lecturer switched it off. */
  OFF: 'OFF',
} as const;
export type GeofenceMode = (typeof GeofenceMode)[keyof typeof GeofenceMode];

/** How a student was recorded present (db/migrations/019_face_recognition.sql). */
export const CheckInMethod = {
  QR: 'QR',
  /** Recognised on the lecturer's terminal, and confirmed by the lecturer. */
  FACE: 'FACE',
} as const;
export type CheckInMethod = (typeof CheckInMethod)[keyof typeof CheckInMethod];

/** What a check-in's location proved. Rejected scans are never recorded, so there is no OUTSIDE. */
export const GeofenceResult = {
  INSIDE: 'INSIDE',
  /** The session's geofence was off. */
  NOT_CHECKED: 'NOT_CHECKED',
} as const;
export type GeofenceResult = (typeof GeofenceResult)[keyof typeof GeofenceResult];

export const AuditAction = {
  LECTURER_REGISTRATION_SUBMITTED: 'LECTURER_REGISTRATION_SUBMITTED',
  LECTURER_REGISTRATION_REVOKED: 'LECTURER_REGISTRATION_REVOKED',
  LECTURER_REGISTRATION_COMPLETED: 'LECTURER_REGISTRATION_COMPLETED',
  STUDENT_REGISTRATION_SUBMITTED: 'STUDENT_REGISTRATION_SUBMITTED',
  STUDENT_REGISTRATION_REVOKED: 'STUDENT_REGISTRATION_REVOKED',
  STUDENT_REGISTRATION_COMPLETED: 'STUDENT_REGISTRATION_COMPLETED',
  STUDENT_ROSTERS_LINKED: 'STUDENT_ROSTERS_LINKED',
  EMAIL_VERIFICATION_SENT: 'EMAIL_VERIFICATION_SENT',
  EMAIL_VERIFICATION_CONFIRMED: 'EMAIL_VERIFICATION_CONFIRMED',
  ACCOUNT_APPROVED: 'ACCOUNT_APPROVED',
  ACCOUNT_STATUS_CHANGED: 'ACCOUNT_STATUS_CHANGED',
  LECTURER_PROFILE_UPDATED: 'LECTURER_PROFILE_UPDATED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  SESSION_REFRESH_REUSE_DETECTED: 'SESSION_REFRESH_REUSE_DETECTED',
  ATTENDANCE_SESSION_OPENED: 'ATTENDANCE_SESSION_OPENED',
  ATTENDANCE_SESSION_STATUS_CHANGED: 'ATTENDANCE_SESSION_STATUS_CHANGED',
  ATTENDANCE_SESSION_CLOSED: 'ATTENDANCE_SESSION_CLOSED',
  ATTENDANCE_SESSION_GEOFENCE_CHANGED: 'ATTENDANCE_SESSION_GEOFENCE_CHANGED',
  /** A room's centre point was set or moved (scripts/dev-set-room.mjs until there is an admin interface). */
  ROOM_SURVEYED: 'ROOM_SURVEYED',
  ATTENDANCE_SCAN_ACCEPTED: 'ATTENDANCE_SCAN_ACCEPTED',
  ATTENDANCE_SCAN_REJECTED: 'ATTENDANCE_SCAN_REJECTED',
  UNIT_CREATED: 'UNIT_CREATED',
  UNIT_VERIFIED: 'UNIT_VERIFIED',
  ATTENDANCE_RECORDED: 'ATTENDANCE_RECORDED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  AVATAR_UPDATED: 'AVATAR_UPDATED',
  FACE_CONSENT_GIVEN: 'FACE_CONSENT_GIVEN',
  /** Also deletes the student's enrolled face. */
  FACE_CONSENT_WITHDRAWN: 'FACE_CONSENT_WITHDRAWN',
  FACE_ENROLLED: 'FACE_ENROLLED',
  FACE_ENROLLMENT_REJECTED: 'FACE_ENROLLMENT_REJECTED',
  FACE_ENROLLMENT_REMOVED: 'FACE_ENROLLMENT_REMOVED',
  /** A terminal frame matched nobody, or two students too closely to choose. */
  ATTENDANCE_FACE_NOT_MATCHED: 'ATTENDANCE_FACE_NOT_MATCHED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditOutcome = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;
export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** A row of `users`, in the snake_case the database returns. */
export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: AccountStatus;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

/** A row of `lecturer_profiles`. */
export interface LecturerProfileRow {
  id: string;
  user_id: string;
  staff_number: string;
  title: string | null;
  department: string | null;
  faculty: string | null;
  phone: string | null;
  erp_staff_id: string | null;
  erp_verified_at: Date;
  erp_snapshot: unknown;
  /**
   * The normalised department (`020_departments.sql`). `department` above stays
   * the ERP's free text; this is the key everything department-scoped joins on.
   */
  department_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row of `faculties`. The level above a department; a faculty role is not built yet. */
export interface FacultyRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** A row of `departments`. `faculty_id` is null for a department the ERP named no faculty for. */
export interface DepartmentRow {
  id: string;
  name: string;
  faculty_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A row of `department_profiles` — one department officer. Mirrors
 * `LecturerProfileRow` minus the ERP columns: officers are provisioned
 * directly, not verified against a staff record, so there is nothing to snapshot.
 */
export interface DepartmentProfileRow {
  id: string;
  user_id: string;
  department_id: string;
  title: string | null;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row of `email_verification_tokens`. */
export interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

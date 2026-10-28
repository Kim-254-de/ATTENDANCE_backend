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
  /** A department officer: read-only oversight of one department's teaching (db/migrations/021_departments.sql). */
  DEPARTMENT: 'DEPARTMENT',
  /** Management: read-only attendance across every department in the university (db/migrations/039_no_faculties.sql). */
  MANAGEMENT: 'MANAGEMENT',
  /** A quality-assurance officer: institution-wide audits, findings and corrective actions (db/migrations/027_qa_role.sql). */
  QA: 'QA',
  /** The timetabling office: invited here, signs in at the Timetable Generator only. */
  TIMETABLING: 'TIMETABLING',
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

/** What a check-in's location proved. Rejected scans are never recorded, so there is no OUTSIDE. */
export const GeofenceResult = {
  INSIDE: 'INSIDE',
  /** The session's geofence was off. */
  NOT_CHECKED: 'NOT_CHECKED',
} as const;
export type GeofenceResult = (typeof GeofenceResult)[keyof typeof GeofenceResult];

/**
 * How a student proves they are the one present. A lecturer ticks any
 * combination when activating a class (QR and FACE when none are chosen); a
 * check-in by a method the class did not enable is refused. All four are
 * built (a barcode ID card records as CARD). Stored per record in
 * attendance_records.verification_method.
 */
export const VerificationMethod = {
  QR: 'QR',
  CARD: 'CARD',
  FINGERPRINT: 'FINGERPRINT',
  FACE: 'FACE',
} as const;
export type VerificationMethod = (typeof VerificationMethod)[keyof typeof VerificationMethod];

/** The methods a check-in can actually arrive by today. */
export const IMPLEMENTED_VERIFICATION_METHODS: readonly VerificationMethod[] = [
  VerificationMethod.QR,
  VerificationMethod.FACE,
  VerificationMethod.CARD,
  VerificationMethod.FINGERPRINT,
];

export const CardStatus = {
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
} as const;
export type CardStatus = (typeof CardStatus)[keyof typeof CardStatus];

export const AuditAction = {
  LECTURER_REGISTRATION_SUBMITTED: 'LECTURER_REGISTRATION_SUBMITTED',
  LECTURER_REGISTRATION_REVOKED: 'LECTURER_REGISTRATION_REVOKED',
  LECTURER_REGISTRATION_COMPLETED: 'LECTURER_REGISTRATION_COMPLETED',
  STUDENT_REGISTRATION_SUBMITTED: 'STUDENT_REGISTRATION_SUBMITTED',
  STUDENT_REGISTRATION_REVOKED: 'STUDENT_REGISTRATION_REVOKED',
  STUDENT_REGISTRATION_COMPLETED: 'STUDENT_REGISTRATION_COMPLETED',
  STUDENT_ROSTERS_LINKED: 'STUDENT_ROSTERS_LINKED',
  /** First sign-in with a SMARTTT account: the attendance account was created for it. */
  SMARTTT_ACCOUNT_CREATED: 'SMARTTT_ACCOUNT_CREATED',
  /** First sign-in with a SMARTTT account: an existing attendance account was linked to it. */
  SMARTTT_ACCOUNT_LINKED: 'SMARTTT_ACCOUNT_LINKED',
  /** A SMARTTT sign-in was refused for something about the account, not the password. */
  SMARTTT_ACCOUNT_REFUSED: 'SMARTTT_ACCOUNT_REFUSED',
  EMAIL_VERIFICATION_SENT: 'EMAIL_VERIFICATION_SENT',
  EMAIL_VERIFICATION_CONFIRMED: 'EMAIL_VERIFICATION_CONFIRMED',
  ACCOUNT_APPROVED: 'ACCOUNT_APPROVED',
  ACCOUNT_STATUS_CHANGED: 'ACCOUNT_STATUS_CHANGED',
  /** A student or lecturer account was anonymised and closed (auth.deletion.ts), by its owner or an officer. */
  ACCOUNT_DELETED: 'ACCOUNT_DELETED',
  /** An administrator, member of management, department or QA officer was invited (auth.invitation.ts). */
  OFFICER_INVITED: 'OFFICER_INVITED',
  /** The invitation email was sent again, with a new link. */
  OFFICER_INVITATION_RESENT: 'OFFICER_INVITATION_RESENT',
  /** The invitee chose their password; the account is ACTIVE. */
  OFFICER_INVITATION_ACCEPTED: 'OFFICER_INVITATION_ACCEPTED',
  /** An officer's access was removed by whoever manages them. */
  OFFICER_DEACTIVATED: 'OFFICER_DEACTIVATED',
  /** An administrator created a department (in SMARTTT, then here). */
  DEPARTMENT_CREATED: 'DEPARTMENT_CREATED',
  /** An administrator corrected a department's name or code (in SMARTTT, then here). */
  DEPARTMENT_UPDATED: 'DEPARTMENT_UPDATED',
  /** An administrator placed a lecturer in a department, or moved them (lecturer.placement.ts). */
  LECTURER_DEPARTMENT_CHANGED: 'LECTURER_DEPARTMENT_CHANGED',
  /** An administrator folded a duplicate department into another; its name became an alias. */
  DEPARTMENTS_MERGED: 'DEPARTMENTS_MERGED',
  /** An administrator removed a learned department spelling. */
  DEPARTMENT_ALIAS_REMOVED: 'DEPARTMENT_ALIAS_REMOVED',
  /** The QA officer changed the minimum attendance to sit exams (attendance_policy). */
  ATTENDANCE_POLICY_UPDATED: 'ATTENDANCE_POLICY_UPDATED',
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
  /** A card was presented at a terminal and refused. Unknown cards are audited without a user id. */
  ATTENDANCE_CARD_REJECTED: 'ATTENDANCE_CARD_REJECTED',
  /** A card was bound to a student, or taken out of use (scripts/dev-enrol-card.mjs until there is an admin interface). */
  STUDENT_CARD_ENROLLED: 'STUDENT_CARD_ENROLLED',
  STUDENT_CARD_REVOKED: 'STUDENT_CARD_REVOKED',
  /** A finger was presented at a terminal and matched nobody. Audited without a user id. */
  ATTENDANCE_FINGERPRINT_REJECTED: 'ATTENDANCE_FINGERPRINT_REJECTED',
  /** A reader's enrolment slot was bound to a student, or taken out of use. */
  STUDENT_FINGERPRINT_ENROLLED: 'STUDENT_FINGERPRINT_ENROLLED',
  STUDENT_FINGERPRINT_REVOKED: 'STUDENT_FINGERPRINT_REVOKED',
  /** A department added a portable terminal, or issued it a fresh pairing code (which also cuts off its old key). */
  TERMINAL_CREATED: 'TERMINAL_CREATED',
  TERMINAL_PAIRING_ISSUED: 'TERMINAL_PAIRING_ISSUED',
  /** A device presented its pairing code and received its key. */
  TERMINAL_PAIRED: 'TERMINAL_PAIRED',
  /** Label or capabilities changed, or the device was marked lost or retired. */
  TERMINAL_UPDATED: 'TERMINAL_UPDATED',
  TERMINAL_STATUS_CHANGED: 'TERMINAL_STATUS_CHANGED',
  /** A terminal was linked to a class by scanning the lecturer's code, or let go of it. */
  TERMINAL_LINKED: 'TERMINAL_LINKED',
  TERMINAL_LINK_REFUSED: 'TERMINAL_LINK_REFUSED',
  TERMINAL_UNLINKED: 'TERMINAL_UNLINKED',
  /** A department queued a fingerprint enrolment for a terminal, or withdrew a queued command. */
  FINGERPRINT_ENROLMENT_REQUESTED: 'FINGERPRINT_ENROLMENT_REQUESTED',
  TERMINAL_COMMAND_CANCELLED: 'TERMINAL_COMMAND_CANCELLED',
  /** A terminal reported it could not carry out a queued command. */
  TERMINAL_COMMAND_FAILED: 'TERMINAL_COMMAND_FAILED',
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
  /** An administrator used one of SMARTTT's admin functions from the admin console (method, path, SMARTTT's answer). */
  SMARTTT_ADMIN_ACTION: 'SMARTTT_ADMIN_ACTION',
  /** Departments were brought in line with SMARTTT, which owns them. */
  DIRECTORY_SYNCED: 'DIRECTORY_SYNCED',
  /** A department officer changed the department's teaching (metadata: what, id, before, after). */
  TEACHING_CHANGED: 'TEACHING_CHANGED',
  /** A department officer published the department's teaching to the Director, or reopened it. */
  TEACHING_PUBLISHED: 'TEACHING_PUBLISHED',
  TEACHING_REOPENED: 'TEACHING_REOPENED',
  /** An invigilator opened an exam room (metadata: exam session, paper, room, fence). */
  EXAM_SESSION_OPENED: 'EXAM_SESSION_OPENED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditOutcome = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
} as const;
export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];

/** Internal-only for now (db/migrations/030_qa_audits.sql); room left for an 'EQA' value in a later phase. */
export const QaAuditType = {
  INTERNAL: 'INTERNAL',
} as const;
export type QaAuditType = (typeof QaAuditType)[keyof typeof QaAuditType];

/** Forward-only: PLANNED -> IN_PROGRESS -> COMPLETED. */
export const QaAuditStatus = {
  PLANNED: 'PLANNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
} as const;
export type QaAuditStatus = (typeof QaAuditStatus)[keyof typeof QaAuditStatus];

/** NOT_APPLICABLE findings are excluded from every KPI rollup, not counted as compliant or not. */
export const QaFindingRating = {
  COMPLIANT: 'COMPLIANT',
  PARTIAL: 'PARTIAL',
  NON_COMPLIANT: 'NON_COMPLIANT',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
export type QaFindingRating = (typeof QaFindingRating)[keyof typeof QaFindingRating];

/** Forward-only: OPEN -> IN_PROGRESS -> VERIFIED -> CLOSED. */
export const QaCorrectiveActionStatus = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  VERIFIED: 'VERIFIED',
  CLOSED: 'CLOSED',
} as const;
export type QaCorrectiveActionStatus = (typeof QaCorrectiveActionStatus)[keyof typeof QaCorrectiveActionStatus];

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
  phone: string | null;
  erp_staff_id: string | null;
  erp_verified_at: Date;
  erp_snapshot: unknown;
  /**
   * The normalised department (`021_departments.sql`). `department` above stays
   * the ERP's free text; this is the key everything department-scoped joins on.
   */
  department_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row of `departments`. Faculties play no part (039_no_faculties.sql). */
export interface DepartmentRow {
  id: string;
  name: string;
  /** Unique across the university; how the Timetable Allocator and Generator know it. */
  code: string | null;
  smarttt_department_id: number | null;
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

/**
 * A row of `qa_profiles` — one quality-assurance officer. Unlike
 * `DepartmentProfileRow` there is no department FK: a QA
 * officer's remit is the whole institution (db/migrations/027_qa_role.sql).
 */
export interface QaProfileRow {
  id: string;
  user_id: string;
  title: string | null;
  phone: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * A row of `course_offerings` — a course provided to a department, before any lecturer is attached (db/migrations/023_course_offerings.sql).
 * Becomes one or more `units` rows as the department allocates lecturers to it.
 */
export interface CourseOfferingRow {
  id: string;
  code: string;
  name: string | null;
  department_id: string;
  segments_planned: number;
  created_by_user_id: string | null;
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

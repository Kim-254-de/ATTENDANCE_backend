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

export const AuditAction = {
  LECTURER_REGISTRATION_SUBMITTED: 'LECTURER_REGISTRATION_SUBMITTED',
  LECTURER_REGISTRATION_REVOKED: 'LECTURER_REGISTRATION_REVOKED',
  LECTURER_REGISTRATION_COMPLETED: 'LECTURER_REGISTRATION_COMPLETED',
  EMAIL_VERIFICATION_SENT: 'EMAIL_VERIFICATION_SENT',
  EMAIL_VERIFICATION_CONFIRMED: 'EMAIL_VERIFICATION_CONFIRMED',
  ACCOUNT_APPROVED: 'ACCOUNT_APPROVED',
  ACCOUNT_STATUS_CHANGED: 'ACCOUNT_STATUS_CHANGED',
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
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

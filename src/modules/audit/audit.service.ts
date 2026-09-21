import type { PoolClient } from 'pg';
import { query } from '../../db/database.js';
import { logger } from '../../config/logger.js';
import type {
  AuditAction,
  AuditOutcome,
  ErpVerificationOutcome,
} from '../../db/types.js';

/**
 * Append-only audit trail (README section 3.3: "review audit logs and resolve
 * disputes").
 *
 * A revoked registration writes a row here even though no user row exists,
 * which is what lets an administrator later explain to a lecturer exactly why
 * their attempt was rejected.
 */

export interface AuditEntry {
  action: AuditAction;
  outcome: AuditOutcome;
  userId?: string | null;
  subjectEmail?: string | null;
  subjectStaffNumber?: string | null;
  erpOutcome?: ErpVerificationOutcome | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: unknown;
}

const INSERT_SQL = `
  INSERT INTO audit_logs
    (action, outcome, user_id, subject_email, subject_staff_number,
     erp_outcome, reason, ip_address, user_agent, request_id, metadata)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
`;

function toParams(entry: AuditEntry): unknown[] {
  return [
    entry.action,
    entry.outcome,
    entry.userId ?? null,
    entry.subjectEmail ?? null,
    entry.subjectStaffNumber ?? null,
    entry.erpOutcome ?? null,
    // The column is bounded; truncate here rather than let the insert fail and
    // lose the audit record entirely.
    entry.reason?.slice(0, 255) ?? null,
    entry.ipAddress ?? null,
    entry.userAgent ?? null,
    entry.requestId ?? null,
    entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
  ];
}

/**
 * Writes an audit row.
 *
 * Auditing must never be the reason a legitimate request fails, so a write
 * failure is logged loudly and swallowed. The exception is
 * `recordInTransaction` below, used where the audit row and the state change
 * must stand or fall together.
 */
export async function record(entry: AuditEntry): Promise<void> {
  try {
    await query(INSERT_SQL, toParams(entry));
  } catch (error) {
    logger.error({ err: error, action: entry.action }, 'failed to write audit log entry');
  }
}

/** Audit write that joins the caller's transaction and fails with it. */
export async function recordInTransaction(
  client: PoolClient,
  entry: AuditEntry,
): Promise<void> {
  await query(INSERT_SQL, toParams(entry), client);
}

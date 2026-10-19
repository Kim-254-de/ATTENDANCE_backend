import { query, queryOne } from '../../db/database.js';

/**
 * All SQL for portable terminals. Every query is parameterised.
 *
 * Keys and pairing codes are only ever looked up by their SHA-256; neither is
 * stored in the clear (db/migrations/027_terminals.sql).
 */

export type TerminalCapability = 'BARCODE' | 'CARD' | 'FINGERPRINT';
export type TerminalStatus = 'PENDING' | 'ACTIVE' | 'LOST' | 'RETIRED';
export type TerminalNetwork = 'WIFI' | 'CELLULAR';

export interface Terminal {
  id: string;
  code: string;
  departmentId: string;
  label: string | null;
  capabilities: TerminalCapability[];
  status: TerminalStatus;
  pairingExpiresAt: Date | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
  batteryPercent: number | null;
  network: TerminalNetwork | null;
  appVersion: string | null;
  linkedSessionId: string | null;
  linkedAt: Date | null;
  createdAt: Date;
  /** Of the linked session, for the devices page. Null when not linked. */
  linkedUnitCode: string | null;
}

interface TerminalRow {
  id: string;
  code: string;
  department_id: string;
  label: string | null;
  capabilities: TerminalCapability[];
  status: TerminalStatus;
  pairing_expires_at: Date | null;
  paired_at: Date | null;
  last_seen_at: Date | null;
  battery_percent: number | null;
  network: TerminalNetwork | null;
  app_version: string | null;
  linked_session_id: string | null;
  linked_at: Date | null;
  created_at: Date;
  linked_unit_code: string | null;
}

const SELECT = `
  SELECT t.id, t.code, t.department_id, t.label, t.capabilities, t.status,
         t.pairing_expires_at, t.paired_at, t.last_seen_at, t.battery_percent,
         t.network, t.app_version, t.linked_session_id, t.linked_at, t.created_at,
         u.code AS linked_unit_code
    FROM terminals t
    LEFT JOIN attendance_sessions s ON s.id = t.linked_session_id
    LEFT JOIN units u ON u.id = s.unit_id`;

function toTerminal(row: TerminalRow): Terminal {
  return {
    id: row.id,
    code: row.code,
    departmentId: row.department_id,
    label: row.label,
    capabilities: row.capabilities,
    status: row.status,
    pairingExpiresAt: row.pairing_expires_at,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    batteryPercent: row.battery_percent,
    network: row.network,
    appVersion: row.app_version,
    linkedSessionId: row.linked_session_id,
    linkedAt: row.linked_at,
    createdAt: row.created_at,
    linkedUnitCode: row.linked_unit_code,
  };
}

export async function listForDepartment(departmentId: string): Promise<Terminal[]> {
  const { rows } = await query<TerminalRow>(`${SELECT} WHERE t.department_id = $1 ORDER BY t.code`, [departmentId]);
  return rows.map(toTerminal);
}

/** Scoped to the department, so another department's terminal is simply not found. */
export async function findInDepartment(id: string, departmentId: string): Promise<Terminal | null> {
  const row = await queryOne<TerminalRow>(`${SELECT} WHERE t.id = $1 AND t.department_id = $2`, [id, departmentId]);
  return row ? toTerminal(row) : null;
}

/** The device presenting this key. Only ACTIVE terminals hold one (terminals_key_only_when_active). */
export async function findByKeyHash(keyHash: string): Promise<Terminal | null> {
  const row = await queryOne<TerminalRow>(`${SELECT} WHERE t.key_hash = $1 AND t.status = 'ACTIVE'`, [keyHash]);
  return row ? toTerminal(row) : null;
}

export async function create(args: {
  code: string;
  departmentId: string;
  label: string | null;
  capabilities: TerminalCapability[];
  pairingCodeHash: string;
  pairingExpiresAt: Date;
  createdByUserId: string;
}): Promise<string> {
  const { rows: [row] } = await query<{ id: string }>(
    `INSERT INTO terminals (code, department_id, label, capabilities, pairing_code_hash, pairing_expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7)
     RETURNING id`,
    [args.code, args.departmentId, args.label, args.capabilities, args.pairingCodeHash, args.pairingExpiresAt, args.createdByUserId],
  );
  return row!.id;
}

/**
 * A fresh pairing code. The old key stops working at once and the device
 * drops any class it was linked to: re-pairing is how a device is handed over.
 */
export async function issuePairing(id: string, pairingCodeHash: string, pairingExpiresAt: Date): Promise<void> {
  await query(
    `UPDATE terminals
        SET status = 'PENDING', key_hash = NULL, pairing_code_hash = $2, pairing_expires_at = $3,
            linked_session_id = NULL, linked_at = NULL
      WHERE id = $1`,
    [id, pairingCodeHash, pairingExpiresAt],
  );
}

/**
 * Trades a live pairing code for a key, in one statement so a code can only
 * be used once. Null when the code is unknown, used or expired.
 */
export async function completePairing(pairingCodeHash: string, keyHash: string): Promise<Terminal | null> {
  const row = await queryOne<{ id: string }>(
    `UPDATE terminals
        SET status = 'ACTIVE', key_hash = $2, pairing_code_hash = NULL, pairing_expires_at = NULL,
            paired_at = NOW(), last_seen_at = NOW()
      WHERE pairing_code_hash = $1 AND pairing_expires_at > NOW() AND status = 'PENDING'
      RETURNING id`,
    [pairingCodeHash, keyHash],
  );
  if (!row) return null;
  const terminal = await queryOne<TerminalRow>(`${SELECT} WHERE t.id = $1`, [row.id]);
  return terminal ? toTerminal(terminal) : null;
}

export async function update(id: string, changes: { label?: string | null; capabilities?: TerminalCapability[] }): Promise<void> {
  await query(
    `UPDATE terminals
        SET label = CASE WHEN $2 THEN $3 ELSE label END,
            capabilities = COALESCE($4::text[], capabilities)
      WHERE id = $1`,
    [id, changes.label !== undefined, changes.label ?? null, changes.capabilities ?? null],
  );
}

/** LOST or RETIRED: the key and any pairing code are cleared, so nothing from the device is accepted. */
export async function decommission(id: string, status: 'LOST' | 'RETIRED'): Promise<void> {
  await query(
    `UPDATE terminals
        SET status = $2, key_hash = NULL, pairing_code_hash = NULL, pairing_expires_at = NULL,
            linked_session_id = NULL, linked_at = NULL
      WHERE id = $1`,
    [id, status],
  );
}

export async function recordHeartbeat(
  id: string,
  report: { ipAddress: string | null; batteryPercent?: number; network?: TerminalNetwork; appVersion?: string },
): Promise<void> {
  await query(
    `UPDATE terminals
        SET last_seen_at = NOW(), last_ip = $2,
            battery_percent = COALESCE($3, battery_percent),
            network = COALESCE($4, network),
            app_version = COALESCE($5, app_version)
      WHERE id = $1`,
    [id, report.ipAddress, report.batteryPercent ?? null, report.network ?? null, report.appVersion ?? null],
  );
}

export async function setLinkedSession(id: string, sessionId: string | null): Promise<void> {
  await query(
    `UPDATE terminals
        SET linked_session_id = $2, linked_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE NOW() END
      WHERE id = $1`,
    [id, sessionId],
  );
}

/** The department a lecturer belongs to, for checking a terminal may serve their class. */
export async function lecturerDepartmentId(lecturerUserId: string): Promise<string | null> {
  const row = await queryOne<{ department_id: string | null }>(
    `SELECT department_id FROM lecturer_profiles WHERE user_id = $1`,
    [lecturerUserId],
  );
  return row?.department_id ?? null;
}

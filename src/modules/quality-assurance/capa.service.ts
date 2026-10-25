import { isForeignKeyViolation } from '../../db/database.js';
import { AppError } from '../../common/errors/index.js';
import * as capaRepository from './capa.repository.js';
import type { CreateCapaInput, ListCapaQuery, UpdateCapaInput } from './capa.schema.js';

/**
 * Corrective action plans (CAPA): raised against a NON_COMPLIANT/PARTIAL
 * finding, owned by whoever must fix it, tracked to verified closure.
 *
 * Status is forward-only (`OPEN -> IN_PROGRESS -> VERIFIED -> CLOSED`),
 * enforced by `canTransitionCapaStatus` below — a pure function so its 16
 * (from, to) pairs can be exhaustively unit-tested without a database.
 * Moving to VERIFIED/CLOSED stamps `verifiedByUserId`/`verifiedAt` from the
 * authenticated caller, matching `qa_corrective_actions`' CHECK constraint
 * that ties status to that pair (db/migrations/032_qa_corrective_actions.sql).
 */

const CAPA_FORWARD_TRANSITIONS: Record<string, readonly string[]> = {
  OPEN: ['IN_PROGRESS'],
  IN_PROGRESS: ['VERIFIED'],
  VERIFIED: ['CLOSED'],
  CLOSED: [],
};

export function canTransitionCapaStatus(from: string, to: string): boolean {
  if (from === to) return false;
  return CAPA_FORWARD_TRANSITIONS[from]?.includes(to) ?? false;
}

const VERIFIED_STATUSES = new Set(['VERIFIED', 'CLOSED']);

export interface CapaDto {
  id: string;
  findingId: string;
  description: string;
  ownerUserId: string;
  ownerName: string;
  dueDate: string;
  status: string;
  verifiedByUserId: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  isOverdue: boolean;
  auditId: string;
  auditTitle: string;
  rating: string;
  standardCode: string;
  standardTitle: string;
  targetDepartmentId: string;
  createdAt: string;
  updatedAt: string;
}

const toDate = (d: Date): string => d.toISOString().slice(0, 10);

const toDto = (row: capaRepository.CapaRow): CapaDto => ({
  id: row.id,
  findingId: row.finding_id,
  description: row.description,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  dueDate: toDate(row.due_date),
  status: row.status,
  verifiedByUserId: row.verified_by_user_id,
  verifiedByName: row.verified_by_name,
  verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
  isOverdue: row.due_date < new Date() && !VERIFIED_STATUSES.has(row.status),
  auditId: row.audit_id,
  auditTitle: row.audit_title,
  rating: row.rating,
  standardCode: row.standard_code,
  standardTitle: row.standard_title,
  targetDepartmentId: row.target_department_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** GET /quality-assurance/corrective-actions */
export async function list(filters: ListCapaQuery): Promise<CapaDto[]> {
  const rows = await capaRepository.list(filters);
  return rows.map(toDto);
}

async function requireCapa(id: string): Promise<capaRepository.CapaRow> {
  const row = await capaRepository.findById(id);
  if (!row) throw AppError.notFound('No such corrective action.');
  return row;
}

/** GET /quality-assurance/corrective-actions/:id */
export async function getById(id: string): Promise<CapaDto> {
  return toDto(await requireCapa(id));
}

/**
 * POST /quality-assurance/corrective-actions
 *
 * Refused unless the finding it targets is NON_COMPLIANT or PARTIAL — a
 * COMPLIANT or NOT_APPLICABLE finding has nothing to correct.
 */
export async function create(input: CreateCapaInput, createdByUserId: string): Promise<CapaDto> {
  const finding = await capaRepository.findFindingForCapa(input.findingId);
  if (!finding) throw AppError.badRequest('No such finding.');
  if (finding.rating !== 'NON_COMPLIANT' && finding.rating !== 'PARTIAL') {
    throw AppError.badRequest('A corrective action can only be raised against a non-compliant or partial finding.');
  }

  try {
    const row = await capaRepository.create({ ...input, createdByUserId });
    return toDto(row);
  } catch (error) {
    if (isForeignKeyViolation(error)) throw AppError.badRequest('The owner does not exist.');
    throw error;
  }
}

/** PATCH /quality-assurance/corrective-actions/:id */
export async function update(id: string, input: UpdateCapaInput, verifierUserId: string): Promise<CapaDto> {
  const capa = await requireCapa(id);

  const hasFieldUpdate = input.description !== undefined || input.ownerUserId !== undefined || input.dueDate !== undefined;
  if (hasFieldUpdate) {
    try {
      await capaRepository.updateFields(id, input);
    } catch (error) {
      if (isForeignKeyViolation(error)) throw AppError.badRequest('The owner does not exist.');
      throw error;
    }
  }

  if (input.status !== undefined && input.status !== capa.status) {
    if (!canTransitionCapaStatus(capa.status, input.status)) {
      throw AppError.badRequest(`A corrective action cannot move from ${capa.status} to ${input.status}.`);
    }
    // VERIFIED is the one transition that stamps a fresh verifier/time.
    // CLOSED is only reachable from VERIFIED (forward-only), so the existing
    // stamp is carried through rather than overwritten with whoever closes
    // it — the identity of the person who actually verified compliance must
    // not change just because someone else later closes the record.
    const verification =
      input.status === 'VERIFIED'
        ? { verifiedByUserId: verifierUserId, verifiedAt: new Date() }
        : input.status === 'CLOSED'
          ? { verifiedByUserId: capa.verified_by_user_id, verifiedAt: capa.verified_at }
          : { verifiedByUserId: null, verifiedAt: null };
    await capaRepository.updateStatus(id, input.status, verification);
  }

  return toDto(await requireCapa(id));
}

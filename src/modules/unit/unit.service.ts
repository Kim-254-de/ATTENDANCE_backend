import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { logger } from '../../config/logger.js';
import { erpClient } from '../../integrations/erp/index.js';
import { auditService } from '../audit/index.js';
import * as unitRepository from './unit.repository.js';
import type { Allocation, UnitOwner, UnitSummary } from './unit.repository.js';
import type { AddStudentsInput, CreateUnitInput, UpdateAllocationInput } from './unit.schema.js';

/**
 * Units and who is on them.
 *
 * Allocation is the check that makes a forwarded QR code near-useless: a
 * student who is not ACTIVE on the unit cannot check in, however current the
 * code they hold. So a student can never make themselves ACTIVE — a lecturer
 * adds them (verified against the ERP) or approves their request.
 */

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface UnitDto {
  id: string;
  code: string;
  name: string | null;
  studentCount: number;
  pendingCount: number;
  createdAt: string;
}

const toUnitDto = (unit: UnitSummary): UnitDto => ({
  ...unit,
  createdAt: unit.createdAt.toISOString(),
});

export interface AllocationDto extends Omit<Allocation, 'createdAt'> {
  createdAt: string;
}

const toAllocationDto = (a: Allocation): AllocationDto => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
});

export async function listUnits(lecturerUserId: string): Promise<UnitDto[]> {
  return (await unitRepository.findUnitsForLecturer(lecturerUserId)).map(toUnitDto);
}

/** A lecturer adds a unit they teach. Until units come from the ERP, this is how units exist at all. */
export async function createUnit(
  input: CreateUnitInput,
  lecturerUserId: string,
  context: RequestContext,
): Promise<UnitDto> {
  let unitId: string;
  try {
    unitId = await unitRepository.createUnit(input.code, input.name, lecturerUserId);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await unitRepository.findUnitByCode(input.code);
      throw AppError.conflict(
        existing?.lecturerUserId === lecturerUserId
          ? `You have already added ${input.code}.`
          : `${input.code} is already taught by another lecturer. Contact your department if this is wrong.`,
        ErrorCode.CONFLICT,
        { details: [{ field: 'code', message: 'This unit code is already in use.' }] },
      );
    }
    throw error;
  }

  await auditService.record({
    action: 'UNIT_CREATED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { unitId, unitCode: input.code },
  });

  const unit = await unitRepository.findUnitSummary(unitId);
  if (!unit) throw new Error('unit vanished immediately after insert');
  return toUnitDto(unit);
}

/** Only the lecturer who teaches a unit may see or change who is on it. */
async function requireOwnedUnit(unitId: string, lecturerUserId: string): Promise<UnitOwner> {
  const unit = await unitRepository.findUnitById(unitId);
  if (!unit) throw AppError.notFound('Unit not found.');
  if (unit.lecturerUserId !== lecturerUserId)
    throw AppError.forbidden('You do not teach this unit.');
  return unit;
}

export async function listStudents(
  unitId: string,
  lecturerUserId: string,
): Promise<AllocationDto[]> {
  await requireOwnedUnit(unitId, lecturerUserId);
  return (await unitRepository.listAllocations(unitId)).map(toAllocationDto);
}

export type AllocationResultStatus =
  'ADDED' | 'RESTORED' | 'ALREADY_ALLOCATED' | 'NOT_FOUND' | 'INACTIVE' | 'UNAVAILABLE';

export interface AllocationResult {
  registrationNumber: string;
  status: AllocationResultStatus;
  fullName: string | null;
}

/** ERP lookups in flight at once. Enough to keep a 100-student list quick without flooding the ERP. */
const ERP_CONCURRENCY = 5;

/**
 * Adds students by registration number. Each is checked against the ERP's
 * student records first, and the check fails CLOSED: if the ERP cannot be
 * reached, that number is reported UNAVAILABLE and not added.
 *
 * One bad number does not fail the batch — the lecturer gets a per-number
 * result and can fix the few that did not go through.
 */
export async function addStudents(
  unitId: string,
  input: AddStudentsInput,
  lecturerUserId: string,
  context: RequestContext,
): Promise<AllocationResult[]> {
  const unit = await requireOwnedUnit(unitId, lecturerUserId);

  const results: AllocationResult[] = [];
  const numbers = input.registrationNumbers;
  for (let i = 0; i < numbers.length; i += ERP_CONCURRENCY) {
    const batch = numbers.slice(i, i + ERP_CONCURRENCY);
    results.push(...(await Promise.all(batch.map((n) => allocateOne(unit.id, n, lecturerUserId)))));
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  await auditService.record({
    action: 'UNIT_STUDENTS_ALLOCATED',
    outcome: 'SUCCESS',
    userId: lecturerUserId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { unitId: unit.id, unitCode: unit.code, counts },
  });
  logger.info({ unitId: unit.id, counts }, 'students allocated to unit');

  return results;
}

async function allocateOne(
  unitId: string,
  registrationNumber: string,
  lecturerUserId: string,
): Promise<AllocationResult> {
  const lookup = await erpClient.lookupStudent(registrationNumber);
  if (lookup.status === 'NOT_FOUND' || lookup.status === 'UNAVAILABLE') {
    return { registrationNumber, status: lookup.status, fullName: null };
  }
  if (lookup.status === 'INACTIVE') {
    return { registrationNumber, status: 'INACTIVE', fullName: lookup.record.fullName };
  }

  const outcome = await unitRepository.allocateByRegistrationNumber({
    unitId,
    registrationNumber: lookup.record.registrationNumber,
    fullName: lookup.record.fullName,
    addedByUserId: lecturerUserId,
  });
  return {
    registrationNumber: lookup.record.registrationNumber,
    status: outcome,
    fullName: lookup.record.fullName,
  };
}

/** Approve a pending request, remove a student, or restore a removed one. */
export async function updateAllocation(
  unitId: string,
  allocationId: string,
  input: UpdateAllocationInput,
  lecturerUserId: string,
  context: RequestContext,
): Promise<AllocationDto> {
  const unit = await requireOwnedUnit(unitId, lecturerUserId);
  const allocation = await unitRepository.findAllocation(unit.id, allocationId);
  if (!allocation) throw AppError.notFound('That student is not on this unit.');

  if (allocation.status !== input.status) {
    await unitRepository.setAllocationStatus(allocation.id, input.status);
    await auditService.record({
      action: 'UNIT_ALLOCATION_STATUS_CHANGED',
      outcome: 'SUCCESS',
      userId: lecturerUserId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        unitId: unit.id,
        unitCode: unit.code,
        allocationId,
        from: allocation.status,
        to: input.status,
      },
    });
  }

  return toAllocationDto({ ...allocation, status: input.status });
}

export interface EnrolmentResult {
  unitId: string;
  unitCode: string;
  status: 'PENDING' | 'ACTIVE';
  message: string;
}

/**
 * A student asks to join a unit by its code. The request is PENDING until the
 * lecturer approves it — a student can never make themselves ACTIVE.
 */
export async function requestEnrolment(
  code: string,
  studentUserId: string,
  context: RequestContext,
): Promise<EnrolmentResult> {
  const unit = await unitRepository.findUnitByCode(code);
  if (!unit)
    throw AppError.notFound(
      `No unit with the code ${code} exists. Check the code with your lecturer.`,
    );

  const outcome = await unitRepository.requestEnrolment(unit.id, studentUserId);
  if (outcome === 'DROPPED') {
    throw AppError.forbidden(
      `Your lecturer removed you from ${unit.code}. Speak to them to be added back.`,
    );
  }
  if (outcome === 'ALREADY_ACTIVE') {
    return {
      unitId: unit.id,
      unitCode: unit.code,
      status: 'ACTIVE',
      message: `You are already registered for ${unit.code}.`,
    };
  }

  if (outcome === 'REQUESTED') {
    await auditService.record({
      action: 'UNIT_ENROLMENT_REQUESTED',
      outcome: 'SUCCESS',
      userId: studentUserId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { unitId: unit.id, unitCode: unit.code },
    });
  }

  return {
    unitId: unit.id,
    unitCode: unit.code,
    status: 'PENDING',
    message: `Request sent. You can check in to ${unit.code} once your lecturer approves it.`,
  };
}

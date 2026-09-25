import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { logger } from '../../config/logger.js';
import { erpClient } from '../../integrations/erp/index.js';
import { auditService } from '../audit/index.js';
import { notificationService } from '../notification/index.js';
import * as unitRepository from './unit.repository.js';
import type { Allocation, UnitOwner, UnitSummary } from './unit.repository.js';
import type { CreateUnitInput } from './unit.schema.js';

/**
 * Units and who is on them.
 *
 * Allocation is the check that makes a forwarded QR code near-useless: a
 * student who is not ACTIVE on the unit cannot check in, however current the
 * code they hold. A student's roster status is not the lecturer's or the
 * student's to set — it is synced from the ERP's own enrollment records
 * (listStudents / unitRepository.syncAllocationsFromErp), same as a unit's
 * name and schedule are.
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
  schedule: UnitSummary['schedule'];
  status: UnitSummary['status'];
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

/** The unit ActivateClass may open a session for right now, or null if nothing is scheduled. */
export async function getCurrentUnit(lecturerUserId: string): Promise<UnitDto | null> {
  const now = new Date();
  const timeOfDay = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const unit = await unitRepository.findCurrentUnitForLecturer(lecturerUserId, now.getDay(), timeOfDay);
  return unit ? toUnitDto(unit) : null;
}

/**
 * A lecturer adds a unit by code. The unit isn't taken on trust: the code is
 * looked up in the ERP's issued timetable, which is the source of both the
 * unit's real name/schedule (a lecturer never types these) and, separately,
 * whether *this* lecturer is the one the timetable assigns to teach it.
 *
 * - Unknown code, or the ERP unreachable → the request is refused outright.
 *   This check happens automatically; no admin is involved.
 * - The ERP already lists this lecturer's staff number against the course →
 *   the unit is VERIFIED immediately, no human involved either.
 * - The ERP lists someone else (or nobody) → the unit is created
 *   PENDING_VERIFICATION and every ADMIN is notified to confirm the
 *   lecturer-unit assignment by hand. It cannot be used to activate a class
 *   (session.service.ts) until then. There is no admin UI yet for this: it
 *   happens via `npm run dev:verify-unit`, the same stand-in
 *   dev-approve-lecturer.mjs is for lecturer account approval.
 */
export async function createUnit(
  input: CreateUnitInput,
  lecturerUserId: string,
  lecturer: { name: string; staffNumber: string | null },
  context: RequestContext,
): Promise<UnitDto> {
  const lookup = await erpClient.lookupCourse(input.code);
  if (lookup.status === 'NOT_FOUND') {
    throw AppError.notFound(
      `No course with the code ${input.code} exists on the issued timetable. Check the code with your department.`,
    );
  }
  if (lookup.status === 'UNAVAILABLE') {
    throw new AppError(
      503,
      ErrorCode.ERP_UNAVAILABLE,
      'This unit could not be verified right now because the timetable system is unreachable. Please try again shortly.',
      { retryAfterSeconds: 60 },
    );
  }
  const course = lookup.record;

  const assignedToThisLecturer =
    !!lecturer.staffNumber && course.staffNumber === lecturer.staffNumber.trim().toUpperCase();
  const status: unitRepository.UnitVerificationStatus = assignedToThisLecturer ? 'VERIFIED' : 'PENDING_VERIFICATION';

  let unitId: string;
  try {
    unitId = await unitRepository.createUnit(
      course.code,
      course.name,
      lecturerUserId,
      { dayOfWeek: course.dayOfWeek, startTime: course.startTime, endTime: course.endTime },
      status,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await unitRepository.findUnitByCode(course.code);
      throw AppError.conflict(
        existing?.lecturerUserId === lecturerUserId
          ? `You have already added ${course.code}.`
          : `${course.code} is already taught by another lecturer. Contact your department if this is wrong.`,
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
    metadata: { unitId, unitCode: course.code, status, erpStaffNumber: course.staffNumber },
  });

  const unit = await unitRepository.findUnitSummary(unitId);
  if (!unit) throw new Error('unit vanished immediately after insert');

  if (!assignedToThisLecturer) {
    // Fire-and-forget: a notification failure must not fail unit creation, and
    // the lecturer isn't the one waiting on it.
    void notifyAdminsOfPendingUnit(unit, lecturer.name).catch((error: unknown) => {
      logger.error({ err: error, unitId: unit.id }, 'unit verification notice failed to send');
    });
  }

  return toUnitDto(unit);
}

async function notifyAdminsOfPendingUnit(unit: UnitSummary, lecturerName: string): Promise<void> {
  if (!unit.schedule) throw new Error('unit has no schedule immediately after insert');
  const admins = await unitRepository.findAdminRecipients();
  if (admins.length === 0) {
    logger.warn({ unitId: unit.id }, 'unit pending verification but no ADMIN users exist to notify');
    return;
  }
  const schedule = unit.schedule;
  await Promise.all(
    admins.map((admin) =>
      notificationService.sendUnitVerificationRequest({
        to: admin.email,
        adminName: admin.fullName,
        unitCode: unit.code,
        unitName: unit.name ?? unit.code,
        lecturerName,
        dayOfWeek: schedule.dayOfWeek,
        startTime: schedule.startTime,
        endTime: schedule.endTime,
      }),
    ),
  );
}

/** Only the lecturer who teaches a unit may see or change who is on it. */
async function requireOwnedUnit(unitId: string, lecturerUserId: string): Promise<UnitOwner> {
  const unit = await unitRepository.findUnitById(unitId);
  if (!unit) throw AppError.notFound('Unit not found.');
  if (unit.lecturerUserId !== lecturerUserId)
    throw AppError.forbidden('You do not teach this unit.');
  return unit;
}

/**
 * A unit's roster, refreshed from the ERP's enrollment records before it's
 * returned. Read-only from here: a lecturer cannot add, approve or remove a
 * student — that would mean trusting a claim about enrollment the ERP itself
 * disagrees with.
 */
export async function listStudents(
  unitId: string,
  lecturerUserId: string,
): Promise<AllocationDto[]> {
  const unit = await requireOwnedUnit(unitId, lecturerUserId);
  await syncRosterFromErp(unit);
  return (await unitRepository.listAllocations(unitId)).map(toAllocationDto);
}

/**
 * Best-effort: a sync failure must not stop the lecturer seeing whatever
 * roster is already on file, so this only logs and returns rather than
 * throwing. Unlike unit creation, viewing a roster is not granting trust on
 * faith — it is refreshing a display — so there is no case for failing closed.
 */
async function syncRosterFromErp(unit: UnitOwner): Promise<void> {
  const enrollments = await erpClient.listCourseEnrollments(unit.code);
  if (enrollments.status !== 'FOUND') {
    logger.warn(
      { unitId: unit.id, unitCode: unit.code, status: enrollments.status },
      'roster sync skipped: ERP enrollment lookup did not succeed',
    );
    return;
  }
  await unitRepository.syncAllocationsFromErp(
    unit.id,
    enrollments.students.map((s) => ({ registrationNumber: s.registrationNumber, fullName: s.fullName })),
  );
}

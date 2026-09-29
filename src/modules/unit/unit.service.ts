import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { erpClient } from '../../integrations/erp/index.js';
import { smartttClient } from '../../integrations/smarttt/index.js';
import type { SmartttUnit } from '../../integrations/smarttt/index.js';
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
 * student's to set — it is synced from SMARTTT's registrations (or, when
 * SMARTTT is not configured, the ERP's enrollment records) via
 * unitRepository.syncRosterAllocations, same as a unit's name and schedule are.
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
  /** The unit this class belongs to ("COSC 103" for "COSC 103 GR A"); null for units only added by code. */
  baseCode: string | null;
  /** The teaching group ("GR A") when the unit is split into groups; null otherwise. */
  group: string | null;
  /** Students registered for this class this term, per SMARTTT; null if SMARTTT has never reported it. */
  registeredStudents: number | null;
  /** For a group: registered students who haven't picked a group in SMARTTT yet, so are on no roster. */
  studentsWithoutGroup: number | null;
  /** When SMARTTT last confirmed the unit; null for units only ever added by code. */
  timetableSyncedAt: string | null;
  /** The slot's room and whether it has been surveyed for the geofence; null when the timetable names none. */
  room: UnitSummary['room'];
}

const toUnitDto = (unit: UnitSummary): UnitDto => ({
  ...unit,
  createdAt: unit.createdAt.toISOString(),
  timetableSyncedAt: unit.timetableSyncedAt?.toISOString() ?? null,
});

export interface AllocationDto extends Omit<Allocation, 'createdAt'> {
  createdAt: string;
}

const toAllocationDto = (a: Allocation): AllocationDto => ({
  ...a,
  createdAt: a.createdAt.toISOString(),
});

/** Who is asking, as far as the SMARTTT sync needs to know. */
export interface LecturerIdentity {
  name: string;
  staffNumber: string | null;
}

/**
 * The lecturer's units. Refreshed from SMARTTT first (when configured), so
 * units they are timetabled to teach appear without being added by hand, each
 * with SMARTTT's registered-student count.
 */
export async function listUnits(lecturerUserId: string, lecturer?: LecturerIdentity): Promise<UnitDto[]> {
  if (lecturer) await syncUnitsFromTimetable(lecturerUserId, lecturer);
  return (await unitRepository.findUnitsForLecturer(lecturerUserId)).map(toUnitDto);
}

// ---------------------------------------------------------------------------
// Sync from SMARTTT
// ---------------------------------------------------------------------------

/** Per lecturer: when the last sync was attempted, and any sync still running. */
const lastSyncAttempt = new Map<string, number>();
const syncInFlight = new Map<string, Promise<void>>();

/**
 * Pulls the classes SMARTTT says this lecturer teaches this term and upserts
 * them here with their registered-student counts, and replaces each one's
 * roster with the students SMARTTT has registered for it (registration
 * number and name).
 *
 * A class is a unit, or one teaching group of a unit split into groups
 * taught by different lecturers ("COSC 103 GR A"). Each group is its own
 * unit here, owned by its own lecturer, with only that group's students.
 *
 * Fails soft, like the roster sync: if SMARTTT is off, asleep or wrong, the
 * lecturer sees the units already on file. Nothing here ever throws.
 *
 * - A unit SMARTTT links to the lecturer's account is VERIFIED straight away:
 *   the timetable itself assigns it to them (same rule as createUnit).
 * - A unit SMARTTT only matches by the lecturer's name is created
 *   PENDING_VERIFICATION and admins are notified, as for a lecturer-added unit
 *   the timetable doesn't assign to them.
 * - Units that drop off SMARTTT are kept: their attendance history stays.
 *
 * Throttled per lecturer (SMARTTT_SYNC_INTERVAL_SECONDS), counting failed
 * attempts too, so a sleeping SMARTTT delays at most one page load per
 * interval rather than every one.
 */
export async function syncUnitsFromTimetable(lecturerUserId: string, lecturer: LecturerIdentity): Promise<void> {
  if (!smartttClient.enabled || !lecturer.staffNumber) return;

  const running = syncInFlight.get(lecturerUserId);
  if (running) return running;

  const last = lastSyncAttempt.get(lecturerUserId);
  if (last !== undefined && Date.now() - last < env.SMARTTT_SYNC_INTERVAL_SECONDS * 1000) return;
  lastSyncAttempt.set(lecturerUserId, Date.now());

  const sync = runTimetableSync(lecturerUserId, lecturer.staffNumber, lecturer.name)
    .catch((error: unknown) => {
      logger.error({ err: error, lecturerUserId }, 'smarttt unit sync failed; showing units already on file');
    })
    .finally(() => syncInFlight.delete(lecturerUserId));
  syncInFlight.set(lecturerUserId, sync);
  return sync;
}

/** Test seam: forget throttling state between cases. */
export function resetTimetableSyncState(): void {
  lastSyncAttempt.clear();
  syncInFlight.clear();
}

/**
 * unit_schedule holds one slot per unit, so only a unit with exactly one
 * distinct weekly slot gets one.
 *
 * That slot can still come back as several entries (one per class group
 * SMARTTT lists), and each names its room. The room is kept only when they
 * agree: a class the timetable puts in two rooms at once has no one room to
 * fence it to, and the session falls back to the lecturer's location.
 */
function singleSlot(unit: SmartttUnit): Pick<unitRepository.TimetableUnit, 'schedule' | 'roomCode'> {
  const distinct = new Map(unit.slots.map((s) => [`${s.dayOfWeek}|${s.startTime}|${s.endTime}`, s]));
  const [slot] = distinct.values();
  if (distinct.size !== 1 || !slot) return { schedule: null, roomCode: null };

  const rooms = new Set(unit.slots.map((s) => s.room));
  return {
    schedule: { dayOfWeek: slot.dayOfWeek, startTime: slot.startTime, endTime: slot.endTime },
    roomCode: rooms.size === 1 ? slot.room : null,
  };
}

async function runTimetableSync(lecturerUserId: string, staffNumber: string, name: string): Promise<void> {
  const result = await smartttClient.listLecturerUnits(staffNumber, name);
  if (result.status !== 'FOUND') {
    logger.warn({ lecturerUserId, status: result.status }, 'smarttt unit sync skipped');
    return;
  }

  for (const unit of result.units) {
    const status: unitRepository.UnitVerificationStatus =
      unit.matchedBy === 'ACCOUNT' ? 'VERIFIED' : 'PENDING_VERIFICATION';
    const upserted = await unitRepository.upsertUnitFromTimetable(lecturerUserId, {
      code: unit.code,
      baseCode: unit.baseCode,
      group: unit.group,
      name: unit.name,
      registeredStudents: unit.registeredStudents,
      studentsWithoutGroup: unit.studentsWithoutGroup,
      status,
      ...singleSlot(unit),
    });

    if (!upserted) {
      logger.warn(
        { lecturerUserId, unitCode: unit.code },
        'smarttt lists this unit for the lecturer, but another lecturer already holds it here; left unchanged',
      );
      continue;
    }

    await unitRepository.syncRosterAllocations(upserted.id, unit.students, 'SMARTTT');

    const metadata = {
      unitId: upserted.id,
      unitCode: unit.code,
      group: unit.group,
      source: 'SMARTTT',
      matchedBy: unit.matchedBy,
      slots: unit.slots.length,
      term: result.term,
    };
    if (upserted.inserted) {
      await auditService.record({ action: 'UNIT_CREATED', outcome: 'SUCCESS', userId: lecturerUserId, metadata: { ...metadata, status } });
      if (upserted.status === 'PENDING_VERIFICATION') await notifyAdminsIfScheduled(upserted.id, name);
    } else if (upserted.previousStatus === 'PENDING_VERIFICATION' && upserted.status === 'VERIFIED') {
      await auditService.record({ action: 'UNIT_VERIFIED', outcome: 'SUCCESS', userId: lecturerUserId, metadata });
    }
  }
}

/** The admin email names the unit's slot, so it's only sent for a unit that has one. */
async function notifyAdminsIfScheduled(unitId: string, lecturerName: string): Promise<void> {
  const unit = await unitRepository.findUnitSummary(unitId);
  if (!unit) return;
  if (!unit.schedule) {
    logger.warn(
      { unitId, unitCode: unit.code },
      'unit synced from smarttt is pending verification but has no single slot to put in the admin notice',
    );
    return;
  }
  void notifyAdminsOfPendingUnit(unit, lecturerName).catch((error: unknown) => {
    logger.error({ err: error, unitId }, 'unit verification notice failed to send');
  });
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
 *   happens via `npm run dev:verify-unit`.
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
 * A unit's roster, refreshed before it's returned: from SMARTTT's
 * registrations when SMARTTT is configured (one sync covers all of the
 * lecturer's units, throttled like the units page), otherwise from the ERP's
 * enrollment records. Read-only from here: a lecturer cannot add, approve or
 * remove a student — that would mean trusting a claim about enrollment the
 * source system itself disagrees with.
 */
export async function listStudents(
  unitId: string,
  lecturerUserId: string,
  lecturer?: LecturerIdentity,
): Promise<AllocationDto[]> {
  const unit = await requireOwnedUnit(unitId, lecturerUserId);
  if (smartttClient.enabled) {
    if (lecturer) await syncUnitsFromTimetable(lecturerUserId, lecturer);
  } else {
    await syncRosterFromErp(unit);
  }
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
  await unitRepository.syncRosterAllocations(
    unit.id,
    enrollments.students.map((s) => ({ registrationNumber: s.registrationNumber, fullName: s.fullName })),
    'ERP',
  );
}

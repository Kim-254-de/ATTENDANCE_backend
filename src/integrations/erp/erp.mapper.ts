import { z } from 'zod';
import type { ErpCourseRecord, ErpStaffRecord, ErpStudentRecord } from './erp.types.js';

/**
 * ============================================================================
 *  THE ONLY FILE THAT KNOWS THE REAL ERP PAYLOAD SHAPE
 * ============================================================================
 *
 * Everything else in the codebase consumes `ErpStaffRecord`. When the real ERP
 * contract is known, adjust `erpStaffResponseSchema` and `toStaffRecord` below
 * and nothing outside this file needs to change.
 *
 * The schema is intentionally permissive about field NAMES (it accepts several
 * common spellings) and strict about field TYPES. Anything unrecognised is
 * kept in `raw` rather than dropped.
 */

/**
 * Accepts the usual ways an ERP spells these fields. Add the real names here
 * once the contract is confirmed, and delete the alternatives.
 */
const erpStaffPayloadSchema = z
  .object({
    // --- identifier ---
    id: z.union([z.string(), z.number()]).optional(),
    staffId: z.union([z.string(), z.number()]).optional(),
    staff_id: z.union([z.string(), z.number()]).optional(),

    // --- staff number ---
    staffNumber: z.string().optional(),
    staff_number: z.string().optional(),
    staffNo: z.string().optional(),
    payrollNumber: z.string().optional(),

    // --- name ---
    fullName: z.string().optional(),
    full_name: z.string().optional(),
    name: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    surname: z.string().optional(),
    otherNames: z.string().optional(),

    // --- contact ---
    email: z.string().optional().nullable(),
    emailAddress: z.string().optional().nullable(),
    workEmail: z.string().optional().nullable(),

    // --- employment state ---
    isActive: z.boolean().optional(),
    active: z.boolean().optional(),
    status: z.string().optional(),
    employmentStatus: z.string().optional(),

    // --- placement ---
    department: z.string().optional().nullable(),
    departmentName: z.string().optional().nullable(),
    faculty: z.string().optional().nullable(),
    school: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    designation: z.string().optional().nullable(),
  })
  .passthrough();

/**
 * Many ERPs wrap the record in an envelope. Unwrap the common ones, then parse.
 */
const erpResponseEnvelopeSchema = z.union([
  z.object({ data: erpStaffPayloadSchema }),
  z.object({ result: erpStaffPayloadSchema }),
  z.object({ staff: erpStaffPayloadSchema }),
  erpStaffPayloadSchema,
]);

type ErpStaffPayload = z.infer<typeof erpStaffPayloadSchema>;

function unwrap(body: unknown): ErpStaffPayload | null {
  const parsed = erpResponseEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;

  const value = parsed.data as Record<string, unknown>;
  if ('data' in value && value.data) return value.data as ErpStaffPayload;
  if ('result' in value && value.result) return value.result as ErpStaffPayload;
  if ('staff' in value && value.staff) return value.staff as ErpStaffPayload;
  return value;
}

const first = <T>(...values: Array<T | null | undefined>): T | null => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

/** Strings an ERP uses to mean "no longer serving". */
const INACTIVE_STATUSES = new Set([
  'inactive',
  'terminated',
  'retired',
  'resigned',
  'suspended',
  'deceased',
  'dismissed',
  'exited',
  'left',
  'discontinued',
]);

function deriveIsActive(payload: ErpStaffPayload): boolean {
  if (typeof payload.isActive === 'boolean') return payload.isActive;
  if (typeof payload.active === 'boolean') return payload.active;

  const status = first(payload.status, payload.employmentStatus)?.toLowerCase().trim();
  if (!status) {
    // No signal either way. Treat as active: the ERP returned the record at
    // all, and a missing status field should not block a serving lecturer.
    return true;
  }
  return !INACTIVE_STATUSES.has(status);
}

function deriveFullName(payload: ErpStaffPayload): string | null {
  const direct = first(payload.fullName, payload.full_name, payload.name);
  if (direct) return direct.trim();

  const composed = [payload.firstName, payload.otherNames, payload.lastName ?? payload.surname]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' ')
    .trim();

  return composed || null;
}

/**
 * Translates an ERP response body into the internal record.
 * Returns null when the body cannot be understood, which the client reports as
 * UNAVAILABLE rather than NOT_FOUND — an unparseable response is an
 * integration fault, not evidence that the lecturer does not exist.
 */
export function toStaffRecord(body: unknown, requestedStaffNumber: string): ErpStaffRecord | null {
  const payload = unwrap(body);
  if (!payload) return null;

  const fullName = deriveFullName(payload);
  const erpStaffId = first(payload.id, payload.staffId, payload.staff_id);
  const staffNumber = first(
    payload.staffNumber,
    payload.staff_number,
    payload.staffNo,
    payload.payrollNumber,
  );

  // Without a name there is nothing to verify an identity against.
  if (!fullName) return null;

  return {
    erpStaffId: erpStaffId !== null ? String(erpStaffId) : (staffNumber ?? requestedStaffNumber),
    staffNumber: staffNumber ?? requestedStaffNumber,
    fullName,
    email: first(payload.email, payload.emailAddress, payload.workEmail)?.toLowerCase().trim() ?? null,
    isActive: deriveIsActive(payload),
    department: first(payload.department, payload.departmentName),
    faculty: first(payload.faculty, payload.school),
    title: first(payload.title, payload.designation),
    raw: body,
  };
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

const erpStudentPayloadSchema = z
  .object({
    registrationNumber: z.string().optional(),
    reg_number: z.string().optional(),
    regNo: z.string().optional(),
    fullName: z.string().optional(),
    full_name: z.string().optional(),
    name: z.string().optional(),
    programme: z.string().optional().nullable(),
    program: z.string().optional().nullable(),
    course: z.string().optional().nullable(),
    yearOfStudy: z.coerce.number().int().optional().nullable(),
    year_of_study: z.coerce.number().int().optional().nullable(),
    isActive: z.boolean().optional(),
    active: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const erpStudentEnvelopeSchema = z.union([
  z.object({ data: erpStudentPayloadSchema }),
  z.object({ result: erpStudentPayloadSchema }),
  z.object({ student: erpStudentPayloadSchema }),
  erpStudentPayloadSchema,
]);

/** A student who is not currently studying may not be put on a unit. */
const INACTIVE_STUDENT_STATUSES = new Set([...INACTIVE_STATUSES, 'deferred', 'graduated', 'withdrawn', 'expelled']);

/** Translates an ERP student response into the internal record; null when it cannot be understood. */
export function toStudentRecord(body: unknown, requestedRegNumber: string): ErpStudentRecord | null {
  const parsed = erpStudentEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  const value = parsed.data as Record<string, unknown>;
  const payload = (value.data ?? value.result ?? value.student ?? value) as z.infer<typeof erpStudentPayloadSchema>;

  const fullName = first(payload.fullName, payload.full_name, payload.name)?.trim();
  if (!fullName) return null;

  const status = payload.status?.toLowerCase().trim();
  const isActive =
    payload.isActive ?? payload.active ?? (status ? !INACTIVE_STUDENT_STATUSES.has(status) : true);

  return {
    registrationNumber: (
      first(payload.registrationNumber, payload.reg_number, payload.regNo) ?? requestedRegNumber
    ).toUpperCase(),
    fullName,
    programme: first(payload.programme, payload.program, payload.course),
    yearOfStudy: first(payload.yearOfStudy, payload.year_of_study),
    isActive,
    raw: body,
  };
}

/**
 * Many ERPs wrap a list in an envelope ({ results: [...] }, { data: [...] },
 * or a bare array). Each item is mapped with the same per-student schema as a
 * single lookup; an item with no name (unmappable) is dropped rather than
 * failing the whole roster — one bad row should not hide everyone else's.
 */
const erpStudentListEnvelopeSchema = z.union([
  z.object({ results: z.array(z.unknown()) }),
  z.object({ data: z.array(z.unknown()) }),
  z.array(z.unknown()),
]);

/** Translates an ERP enrollment-list response into internal student records. */
export function toEnrollmentRecords(body: unknown): ErpStudentRecord[] {
  const parsed = erpStudentListEnvelopeSchema.safeParse(body);
  if (!parsed.success) return [];
  const value = parsed.data as Record<string, unknown>;
  const items = Array.isArray(value) ? value : ((value.results ?? value.data ?? []) as unknown[]);
  const records: ErpStudentRecord[] = [];
  for (const item of items) {
    const record = toStudentRecord(item, '');
    if (record) records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Courses (the issued timetable)
// ---------------------------------------------------------------------------

const erpCoursePayloadSchema = z
  .object({
    code: z.string().optional(),
    courseCode: z.string().optional(),
    course_code: z.string().optional(),
    name: z.string().optional(),
    courseName: z.string().optional(),
    course_name: z.string().optional(),
    staffNumber: z.string().optional().nullable(),
    staff_number: z.string().optional().nullable(),
    lecturerStaffNumber: z.string().optional().nullable(),
    dayOfWeek: z.coerce.number().int().optional(),
    day_of_week: z.coerce.number().int().optional(),
    startTime: z.string().optional(),
    start_time: z.string().optional(),
    endTime: z.string().optional(),
    end_time: z.string().optional(),
    isActive: z.boolean().optional(),
    active: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const erpCourseEnvelopeSchema = z.union([
  z.object({ data: erpCoursePayloadSchema }),
  z.object({ result: erpCoursePayloadSchema }),
  z.object({ course: erpCoursePayloadSchema }),
  erpCoursePayloadSchema,
]);

const INACTIVE_COURSE_STATUSES = new Set([...INACTIVE_STATUSES, 'discontinued', 'archived']);

/** HH:MM, dropping any seconds a TIME column-backed ERP might include. */
const toHhMm = (value: string): string => value.slice(0, 5);

/** Translates an ERP course response into the internal record; null when it cannot be understood. */
export function toCourseRecord(body: unknown, requestedCode: string): ErpCourseRecord | null {
  const parsed = erpCourseEnvelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  const value = parsed.data as Record<string, unknown>;
  const payload = (value.data ?? value.result ?? value.course ?? value) as z.infer<typeof erpCoursePayloadSchema>;

  const name = first(payload.name, payload.courseName, payload.course_name)?.trim();
  const dayOfWeek = first(payload.dayOfWeek, payload.day_of_week);
  const startTime = first(payload.startTime, payload.start_time);
  const endTime = first(payload.endTime, payload.end_time);
  // Without a name or a complete schedule there is nothing to issue a unit from.
  if (!name || dayOfWeek === null || dayOfWeek < 0 || dayOfWeek > 6 || !startTime || !endTime) return null;

  const status = payload.status?.toLowerCase().trim();
  const isActive = payload.isActive ?? payload.active ?? (status ? !INACTIVE_COURSE_STATUSES.has(status) : true);

  return {
    code: (first(payload.code, payload.courseCode, payload.course_code) ?? requestedCode).toUpperCase(),
    name,
    staffNumber: first(payload.staffNumber, payload.staff_number, payload.lecturerStaffNumber)?.toUpperCase() ?? null,
    dayOfWeek,
    startTime: toHhMm(startTime),
    endTime: toHhMm(endTime),
    isActive,
    raw: body,
  };
}

import { z } from 'zod';
import type {
  SmartttSlot,
  SmartttStaffRecord,
  SmartttStudent,
  SmartttStudentRecord,
  SmartttStudentUnit,
  SmartttTerm,
  SmartttUnit,
} from './smarttt.types.js';

/** SMARTTT's response, exactly as its view serialises it (snake_case). */
const slotSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}/),
  end_time: z.string().regex(/^\d{2}:\d{2}/),
  room: z.string().nullable().optional(),
  class_group: z.string().nullable().optional(),
});

const studentSchema = z.object({
  registration_number: z.string().min(1),
  full_name: z.string().nullable().optional(),
});

const unitSchema = z.object({
  code: z.string().min(1),
  unit_code: z.string().min(1).optional(),
  group: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  registered_students: z.number().int().min(0),
  students_without_group: z.number().int().min(0).optional().default(0),
  matched_by: z.enum(['account', 'name']),
  slots: z.array(slotSchema),
  // Optional so an older SMARTTT that only sends counts still parses.
  students: z.array(studentSchema).optional().default([]),
});

const responseSchema = z.object({
  term: z.object({ academic_year: z.string(), semester: z.number().int() }).nullable(),
  units: z.array(unitSchema),
});

/** Same normalisation as unit.schema.ts applies to a typed-in code. */
export const normaliseUnitCode = (code: string): string => code.trim().replace(/\s+/g, ' ').toUpperCase();

/** "lh 1 " -> "LH 1", so a room is one rooms.code however SMARTTT spells it. Null when blank. */
export const normaliseRoomCode = (room: string | null | undefined): string | null =>
  room?.trim() ? normaliseUnitCode(room) : null;

/** Uppercased and de-duplicated, the way unit_allocations keys a roster. */
function toStudents(students: z.infer<typeof studentSchema>[]): SmartttStudent[] {
  const byNumber = new Map<string, SmartttStudent>();
  for (const student of students) {
    const registrationNumber = student.registration_number.trim().toUpperCase();
    if (!registrationNumber || byNumber.has(registrationNumber)) continue;
    byNumber.set(registrationNumber, { registrationNumber, fullName: student.full_name?.trim() || null });
  }
  return [...byNumber.values()];
}

const toSlot = (slot: z.infer<typeof slotSchema>): SmartttSlot => ({
  dayOfWeek: slot.day_of_week,
  startTime: slot.start_time.slice(0, 5),
  endTime: slot.end_time.slice(0, 5),
  room: normaliseRoomCode(slot.room),
  classGroup: slot.class_group ?? '',
});

const toTerm = (term: { academic_year: string; semester: number } | null): SmartttTerm | null =>
  term ? { academicYear: term.academic_year, semester: term.semester } : null;

/** Translates SMARTTT's payload; null when it cannot be understood. */
export function toLecturerUnits(body: unknown): { term: SmartttTerm | null; units: SmartttUnit[] } | null {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) return null;

  // SMARTTT keys units by its own id, so two departments' units could share a
  // code. Codes (one per class) are unique here, so the first one wins.
  const byCode = new Map<string, SmartttUnit>();
  for (const unit of parsed.data.units) {
    const code = normaliseUnitCode(unit.code);
    if (byCode.has(code)) continue;
    const group = unit.group?.trim() ? normaliseUnitCode(unit.group) : null;
    byCode.set(code, {
      code,
      baseCode: normaliseUnitCode(unit.unit_code ?? unit.code),
      group,
      name: unit.name?.trim() || code,
      registeredStudents: unit.registered_students,
      studentsWithoutGroup: group ? unit.students_without_group : 0,
      matchedBy: unit.matched_by === 'account' ? 'ACCOUNT' : 'NAME',
      slots: unit.slots.map(toSlot),
      students: toStudents(unit.students),
    });
  }

  return { term: toTerm(parsed.data.term), units: [...byCode.values()] };
}

const studentRecordSchema = z.object({
  registration_number: z.string().min(1),
  full_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  programme: z.string().nullable().optional(),
  year_of_study: z.number().int().nullable().optional(),
  is_active: z.boolean(),
});

/** Translates SMARTTT's student lookup; null when it cannot be understood. */
export function toStudentRecord(body: unknown): SmartttStudentRecord | null {
  const parsed = studentRecordSchema.safeParse(body);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    registrationNumber: v.registration_number.trim().toUpperCase(),
    fullName: v.full_name?.trim() || null,
    email: v.email?.trim().toLowerCase() || null,
    programme: v.programme?.trim() || null,
    yearOfStudy: v.year_of_study ?? null,
    isActive: v.is_active,
    raw: body,
  };
}

const staffRecordSchema = z.object({
  staff_number: z.string().min(1),
  full_name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  faculty: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  is_active: z.boolean(),
});

/** Translates SMARTTT's staff lookup; null when it cannot be understood. */
export function toStaffRecord(body: unknown): SmartttStaffRecord | null {
  const parsed = staffRecordSchema.safeParse(body);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    staffNumber: v.staff_number.trim().toUpperCase(),
    fullName: v.full_name?.trim() || null,
    email: v.email?.trim().toLowerCase() || null,
    department: v.department?.trim() || null,
    faculty: v.faculty?.trim() || null,
    title: v.title?.trim() || null,
    isActive: v.is_active,
    raw: body,
  };
}

const studentUnitsSchema = z.object({
  term: z.object({ academic_year: z.string(), semester: z.number().int() }).nullable(),
  units: z.array(
    z.object({
      code: z.string().min(1),
      unit_code: z.string().min(1).optional(),
      group: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      group_required: z.boolean().optional().default(false),
      lecturers: z.array(z.string()).optional().default([]),
      slots: z.array(slotSchema),
    }),
  ),
});

/** Translates SMARTTT's student-units payload; null when it cannot be understood. */
export function toStudentUnits(body: unknown): { term: SmartttTerm | null; units: SmartttStudentUnit[] } | null {
  const parsed = studentUnitsSchema.safeParse(body);
  if (!parsed.success) return null;

  const byCode = new Map<string, SmartttStudentUnit>();
  for (const unit of parsed.data.units) {
    const code = normaliseUnitCode(unit.code);
    if (byCode.has(code)) continue;
    byCode.set(code, {
      code,
      baseCode: normaliseUnitCode(unit.unit_code ?? unit.code),
      group: unit.group?.trim() ? normaliseUnitCode(unit.group) : null,
      name: unit.name?.trim() || code,
      groupRequired: unit.group_required,
      lecturers: unit.lecturers.map((n) => n.trim()).filter(Boolean),
      slots: unit.slots.map(toSlot),
    });
  }
  return { term: toTerm(parsed.data.term), units: [...byCode.values()] };
}

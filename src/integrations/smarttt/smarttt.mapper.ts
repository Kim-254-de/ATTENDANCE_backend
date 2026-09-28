import { z } from 'zod';
import type { SmartttStudent, SmartttStudentRecord, SmartttTerm, SmartttUnit } from './smarttt.types.js';

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
      slots: unit.slots.map((slot) => ({
        dayOfWeek: slot.day_of_week,
        startTime: slot.start_time.slice(0, 5),
        endTime: slot.end_time.slice(0, 5),
        room: slot.room ?? null,
        classGroup: slot.class_group ?? '',
      })),
      students: toStudents(unit.students),
    });
  }

  const term = parsed.data.term;
  return {
    term: term ? { academicYear: term.academic_year, semester: term.semester } : null,
    units: [...byCode.values()],
  };
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

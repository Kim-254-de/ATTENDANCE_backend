import { z } from 'zod';

/**
 * Request contracts for the unit module. Codes and registration numbers are
 * normalised here (trimmed, upper-cased, inner whitespace collapsed) so
 * "cosc  100" and "COSC 100" can never become two units.
 */

const uuid = z.string().uuid('Not a valid identifier.');

const normaliseCode = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();

export const unitCodeSchema = z
  .string()
  .transform(normaliseCode)
  .pipe(
    z
      .string()
      .min(2, 'Enter the unit code, e.g. COSC 100.')
      .max(32, 'Unit codes are at most 32 characters.')
      .regex(
        /^[A-Z0-9][A-Z0-9 ./-]*$/,
        'Use letters, numbers, spaces, dots, slashes or dashes only.',
      ),
  );

const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM, e.g. 09:00.');

export const createUnitSchema = z
  .object({
    code: unitCodeSchema,
    name: z.string().trim().min(2, 'Enter the unit name.').max(200),
    /** The unit's issued weekly meeting slot. 0=Sunday..6=Saturday, matches JS Date#getDay(). */
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
  })
  .strict()
  .refine((value) => value.endTime > value.startTime, {
    message: 'End time must be after start time.',
    path: ['endTime'],
  });
export type CreateUnitInput = z.infer<typeof createUnitSchema>;

export const unitIdParamSchema = z.object({ unitId: uuid }).strict();
export type UnitIdParam = z.infer<typeof unitIdParamSchema>;

export const allocationParamSchema = z.object({ unitId: uuid, allocationId: uuid }).strict();
export type AllocationParam = z.infer<typeof allocationParamSchema>;

const registrationNumberSchema = z
  .string()
  .transform(normaliseCode)
  .pipe(z.string().min(3, 'Registration numbers are at least 3 characters.').max(64));

/**
 * A class list is pasted in one go. 300 covers the largest lecture hall; each
 * number is an ERP lookup, so an unbounded list would be a way to hammer it.
 */
export const addStudentsSchema = z
  .object({
    registrationNumbers: z
      .array(registrationNumberSchema)
      .min(1, 'Add at least one registration number.')
      .max(300, 'Add at most 300 students at a time.')
      .transform((numbers) => [...new Set(numbers)]),
  })
  .strict();
export type AddStudentsInput = z.infer<typeof addStudentsSchema>;

/** A lecturer approves a pending request (ACTIVE), removes a student (DROPPED), or restores one. */
export const updateAllocationSchema = z.object({ status: z.enum(['ACTIVE', 'DROPPED']) }).strict();
export type UpdateAllocationInput = z.infer<typeof updateAllocationSchema>;

export const enrolSchema = z.object({ code: unitCodeSchema }).strict();
export type EnrolInput = z.infer<typeof enrolSchema>;

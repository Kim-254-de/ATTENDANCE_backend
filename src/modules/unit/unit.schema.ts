import { z } from 'zod';

/**
 * Request contracts for the unit module. A code is normalised here (trimmed,
 * upper-cased, inner whitespace collapsed) so "cosc  100" and "COSC 100" can
 * never become two units.
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

/**
 * A lecturer only supplies the code. The name and schedule are not taken on
 * trust: they come from the ERP's course lookup in unit.service.ts, the same
 * way a unit's roster comes from the ERP's enrollment records rather than a
 * form.
 */
export const createUnitSchema = z
  .object({
    code: unitCodeSchema,
  })
  .strict();
export type CreateUnitInput = z.infer<typeof createUnitSchema>;

export const unitIdParamSchema = z.object({ unitId: uuid }).strict();
export type UnitIdParam = z.infer<typeof unitIdParamSchema>;

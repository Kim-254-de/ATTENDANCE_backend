import { z } from 'zod';

/** Request contracts for the department module. */

export const lecturerUserIdParamSchema = z
  .object({ lecturerUserId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type LecturerUserIdParam = z.infer<typeof lecturerUserIdParamSchema>;

/**
 * The timekeeping log's filters. `limit` is capped: this is a session-level
 * log over a whole department, which for a large one is thousands of rows.
 */
export const timekeepingQuerySchema = z
  .object({
    lecturerUserId: z.string().uuid('Not a valid identifier.').optional(),
    unitId: z.string().uuid('Not a valid identifier.').optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type TimekeepingQuery = z.infer<typeof timekeepingQuerySchema>;

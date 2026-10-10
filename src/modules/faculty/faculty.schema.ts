import { z } from 'zod';

/** Request contracts for the faculty module. */

export const lecturerUserIdParamSchema = z
  .object({ lecturerUserId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type LecturerUserIdParam = z.infer<typeof lecturerUserIdParamSchema>;

export const departmentIdParamSchema = z
  .object({ departmentId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type DepartmentIdParam = z.infer<typeof departmentIdParamSchema>;

/**
 * The timekeeping log's filters. `limit` is capped: this is a session-level
 * log over a whole faculty, which for a large one is thousands of rows.
 */
export const timekeepingQuerySchema = z
  .object({
    lecturerUserId: z.string().uuid('Not a valid identifier.').optional(),
    unitId: z.string().uuid('Not a valid identifier.').optional(),
    departmentId: z.string().uuid('Not a valid identifier.').optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export type TimekeepingQuery = z.infer<typeof timekeepingQuerySchema>;

import { z } from 'zod';
import { unitCodeSchema } from '../unit/index.js';

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

/** POST /faculties/departments */
export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter the department name.').max(160),
  })
  .strict();
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

/**
 * POST /faculties/departments/:departmentId/courses
 *
 * The code follows the same rules a lecturer-added unit's code does
 * (trimmed, upper-cased, inner whitespace collapsed) since it becomes one.
 * The name is free text here rather than ERP-sourced — faculty is the
 * authority for a course provisioned this way.
 */
export const provideCourseSchema = z
  .object({
    code: unitCodeSchema,
    name: z.string().trim().min(2).max(200).optional(),
  })
  .strict();
export type ProvideCourseInput = z.infer<typeof provideCourseSchema>;

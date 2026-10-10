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

export const offeringIdParamSchema = z
  .object({ offeringId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type OfferingIdParam = z.infer<typeof offeringIdParamSchema>;

/** PATCH /departments/courses/:offeringId — the GR A..Z cap matches course_offerings.segments_planned's CHECK constraint. */
export const setSegmentCountSchema = z
  .object({
    segmentsPlanned: z.coerce.number().int().min(1).max(26),
  })
  .strict();
export type SetSegmentCountInput = z.infer<typeof setSegmentCountSchema>;

/** POST /departments/courses/:offeringId/segments */
export const allocateLecturerSchema = z
  .object({
    lecturerUserId: z.string().uuid('Not a valid identifier.'),
  })
  .strict();
export type AllocateLecturerInput = z.infer<typeof allocateLecturerSchema>;

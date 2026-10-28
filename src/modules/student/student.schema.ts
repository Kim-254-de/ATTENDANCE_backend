import { z } from 'zod';

/** GET /students/me/attendance — optionally one unit, newest first, a page at a time. */
export const attendanceHistoryQuerySchema = z
  .object({
    unitId: z.string().uuid('Not a valid identifier.').optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type AttendanceHistoryQuery = z.infer<typeof attendanceHistoryQuerySchema>;

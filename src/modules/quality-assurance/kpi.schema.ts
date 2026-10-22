import { z } from 'zod';

/** Request contract for the KPI dashboard. */

export const dashboardQuerySchema = z
  .object({
    targetDepartmentId: z.string().uuid('Not a valid identifier.').optional(),
    targetFacultyId: z.string().uuid('Not a valid identifier.').optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    groupBy: z.enum(['week', 'month']).default('month'),
  })
  .strict();
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

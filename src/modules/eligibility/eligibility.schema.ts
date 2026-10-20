import { z } from 'zod';

/** Request contracts for the attendance policy and eligibility reports. */

/** PUT /quality-assurance/attendance-policy — bounds match attendance_policy's CHECK constraints. */
export const updatePolicySchema = z
  .object({
    minAttendancePercent: z.coerce.number().min(1).max(100).optional(),
    atRiskMarginPercent: z.coerce.number().min(0).max(50).optional(),
  })
  .strict()
  .refine((v) => v.minAttendancePercent !== undefined || v.atRiskMarginPercent !== undefined, {
    message: 'Nothing to change.',
  });
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

/** `?all=true` includes eligible and not-yet-measured rows too. */
const includeAll = z.enum(['true', 'false']).transform((v) => v === 'true').optional();

export const eligibilityQuerySchema = z.object({ all: includeAll }).strict();
export type EligibilityQuery = z.infer<typeof eligibilityQuerySchema>;

/** Faculty: may narrow to one of its departments. */
export const facultyEligibilityQuerySchema = z
  .object({ all: includeAll, departmentId: z.string().uuid('Not a valid identifier.').optional() })
  .strict();
export type FacultyEligibilityQuery = z.infer<typeof facultyEligibilityQuerySchema>;

/** QA: institution-wide, optionally narrowed to a department or a faculty. */
export const qaEligibilityQuerySchema = z
  .object({
    all: includeAll,
    departmentId: z.string().uuid('Not a valid identifier.').optional(),
    facultyId: z.string().uuid('Not a valid identifier.').optional(),
  })
  .strict();
export type QaEligibilityQuery = z.infer<typeof qaEligibilityQuerySchema>;

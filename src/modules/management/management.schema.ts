import { z } from 'zod';

export const departmentParamSchema = z
  .object({ departmentId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type DepartmentParam = z.infer<typeof departmentParamSchema>;

export const yearParamSchema = z
  .object({
    departmentId: z.string().uuid('Not a valid identifier.'),
    year: z.coerce.number().int().min(1, 'Year 1 to 4.').max(4, 'Year 1 to 4.'),
  })
  .strict();
export type YearParam = z.infer<typeof yearParamSchema>;

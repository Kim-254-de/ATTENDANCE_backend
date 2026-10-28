import { z } from 'zod';

/** Request contracts for the QA standards catalog. */

/** Matches the CHECK constraint on qa_standards.category (db/migrations/028_qa_standards.sql). */
export const QA_STANDARD_CATEGORIES = [
  'GOVERNANCE',
  'ACADEMIC_PROGRAMS',
  'STAFF',
  'STUDENTS',
  'FACILITIES',
  'FINANCE',
  'RESEARCH',
  'COMMUNITY_ENGAGEMENT',
] as const;
export const qaStandardCategorySchema = z.enum(QA_STANDARD_CATEGORIES);

export const standardIdParamSchema = z.object({ id: z.string().uuid('Not a valid identifier.') }).strict();
export type StandardIdParam = z.infer<typeof standardIdParamSchema>;

export const listStandardsQuerySchema = z
  .object({
    category: qaStandardCategorySchema.optional(),
    active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .strict();
export type ListStandardsQuery = z.infer<typeof listStandardsQuerySchema>;

export const createStandardSchema = z
  .object({
    code: z.string().trim().min(1).max(32),
    category: qaStandardCategorySchema,
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
  })
  .strict();
export type CreateStandardInput = z.infer<typeof createStandardSchema>;

export const updateStandardSchema = z
  .object({
    code: z.string().trim().min(1).max(32).optional(),
    category: qaStandardCategorySchema.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    displayOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateStandardInput = z.infer<typeof updateStandardSchema>;

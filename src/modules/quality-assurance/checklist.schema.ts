import { z } from 'zod';

/** Request contracts for checklist templates and their items. */

export const templateIdParamSchema = z.object({ id: z.string().uuid('Not a valid identifier.') }).strict();
export type TemplateIdParam = z.infer<typeof templateIdParamSchema>;

export const templateItemParamsSchema = z
  .object({
    id: z.string().uuid('Not a valid identifier.'),
    itemId: z.string().uuid('Not a valid identifier.'),
  })
  .strict();
export type TemplateItemParams = z.infer<typeof templateItemParamsSchema>;

export const listTemplatesQuerySchema = z
  .object({ active: z.enum(['true', 'false']).transform((v) => v === 'true').optional() })
  .strict();
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;

export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(5000).optional(),
  })
  .strict();
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

export const createItemSchema = z
  .object({
    standardId: z.string().uuid('Not a valid identifier.'),
    prompt: z.string().trim().min(1).max(2000),
    guidance: z.string().trim().max(2000).optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
  })
  .strict();
export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z
  .object({
    standardId: z.string().uuid('Not a valid identifier.').optional(),
    prompt: z.string().trim().min(1).max(2000).optional(),
    guidance: z.string().trim().max(2000).nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
  })
  .strict();
export type UpdateItemInput = z.infer<typeof updateItemSchema>;

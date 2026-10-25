import { z } from 'zod';

/** Request contracts for corrective action plans (CAPA). */

export const capaIdParamSchema = z.object({ id: z.string().uuid('Not a valid identifier.') }).strict();
export type CapaIdParam = z.infer<typeof capaIdParamSchema>;

export const CAPA_STATUSES = ['OPEN', 'IN_PROGRESS', 'VERIFIED', 'CLOSED'] as const;
export const capaStatusSchema = z.enum(CAPA_STATUSES);

export const listCapaQuerySchema = z
  .object({
    status: capaStatusSchema.optional(),
    ownerUserId: z.string().uuid('Not a valid identifier.').optional(),
    targetDepartmentId: z.string().uuid('Not a valid identifier.').optional(),
    overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .strict();
export type ListCapaQuery = z.infer<typeof listCapaQuerySchema>;

export const createCapaSchema = z
  .object({
    findingId: z.string().uuid('Not a valid identifier.'),
    description: z.string().trim().min(1).max(5000),
    ownerUserId: z.string().uuid('Not a valid identifier.'),
    dueDate: z.string().date(),
  })
  .strict();
export type CreateCapaInput = z.infer<typeof createCapaSchema>;

export const updateCapaSchema = z
  .object({
    description: z.string().trim().min(1).max(5000).optional(),
    ownerUserId: z.string().uuid('Not a valid identifier.').optional(),
    dueDate: z.string().date().optional(),
    status: capaStatusSchema.optional(),
    // Accepted but never read: capa.service.ts always stamps the authenticated
    // caller's own id on a VERIFIED transition, never one supplied here.
    verifiedByUserId: z.string().optional(),
  })
  .strict();
export type UpdateCapaInput = z.infer<typeof updateCapaSchema>;

import { z } from 'zod';

/** Request contracts for audits and their findings. */

export const auditIdParamSchema = z.object({ id: z.string().uuid('Not a valid identifier.') }).strict();
export type AuditIdParam = z.infer<typeof auditIdParamSchema>;

export const auditFindingParamsSchema = z
  .object({
    id: z.string().uuid('Not a valid identifier.'),
    checklistItemId: z.string().uuid('Not a valid identifier.'),
  })
  .strict();
export type AuditFindingParams = z.infer<typeof auditFindingParamsSchema>;

export const AUDIT_STATUSES = ['PLANNED', 'IN_PROGRESS', 'COMPLETED'] as const;
export const auditStatusSchema = z.enum(AUDIT_STATUSES);

export const listAuditsQuerySchema = z
  .object({
    status: auditStatusSchema.optional(),
    targetDepartmentId: z.string().uuid('Not a valid identifier.').optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .strict();
export type ListAuditsQuery = z.infer<typeof listAuditsQuerySchema>;

export const createAuditSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    targetDepartmentId: z.string().uuid('Choose the department to audit.'),
    checklistTemplateId: z.string().uuid('Not a valid identifier.'),
    leadAuditorUserId: z.string().uuid('Not a valid identifier.'),
    scheduledDate: z.string().date(),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict();
export type CreateAuditInput = z.infer<typeof createAuditSchema>;

export const updateAuditSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    leadAuditorUserId: z.string().uuid('Not a valid identifier.').optional(),
    scheduledDate: z.string().date().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: auditStatusSchema.optional(),
  })
  .strict();
export type UpdateAuditInput = z.infer<typeof updateAuditSchema>;

export const QA_FINDING_RATINGS = ['COMPLIANT', 'PARTIAL', 'NON_COMPLIANT', 'NOT_APPLICABLE'] as const;
export const qaFindingRatingSchema = z.enum(QA_FINDING_RATINGS);

export const upsertFindingSchema = z
  .object({
    rating: qaFindingRatingSchema,
    score: z.coerce.number().min(0).max(100).optional(),
    evidenceNotes: z.string().trim().max(5000).optional(),
  })
  .strict();
export type UpsertFindingInput = z.infer<typeof upsertFindingSchema>;

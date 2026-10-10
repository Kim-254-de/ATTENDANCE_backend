import { z } from 'zod';

/** Request contracts for the reporting module. */

export const listSessionReportsQuerySchema = z
  .object({
    unitId: z.string().uuid('Not a valid identifier.').optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();
export type ListSessionReportsQuery = z.infer<typeof listSessionReportsQuerySchema>;

export const sessionIdParamSchema = z.object({ sessionId: z.string().uuid('Not a valid identifier.') }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

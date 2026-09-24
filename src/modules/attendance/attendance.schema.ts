import { z } from 'zod';

const uuid = z.string().uuid('Not a valid identifier.');

/**
 * A scanned code, submitted by a student. Capped well above a real token:
 * anything longer is not a mis-scan but someone probing the endpoint.
 */
export const checkInSchema = z
  .object({
    payload: z.string().trim().min(8, 'Not a valid attendance code.').max(512),
  })
  .strict();
export type CheckInInput = z.infer<typeof checkInSchema>;

export const sessionIdParamSchema = z.object({ sessionId: uuid }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

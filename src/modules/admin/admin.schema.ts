import { z } from 'zod';
import { inviteeSchema } from '../auth/auth.schema.js';

/** Request contracts for the admin module. */

export const createFacultySchema = z
  .object({ name: z.string().trim().min(3, 'Faculty name is too short.').max(160, 'Faculty name is too long.') })
  .strict();
export type CreateFacultyInput = z.infer<typeof createFacultySchema>;

/** An administrator invites another administrator, or a faculty officer for one faculty. */
export const adminInvitationSchema = z.discriminatedUnion('role', [
  inviteeSchema.extend({ role: z.literal('admin') }).strict(),
  inviteeSchema.extend({ role: z.literal('faculty'), facultyId: z.string().uuid('Choose a faculty.') }).strict(),
]);
export type AdminInvitationInput = z.infer<typeof adminInvitationSchema>;

export const officerUserIdParamSchema = z
  .object({ userId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type OfficerUserIdParam = z.infer<typeof officerUserIdParamSchema>;

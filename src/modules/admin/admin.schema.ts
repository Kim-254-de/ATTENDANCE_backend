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

/** GET /admin/lecturers */
export const lecturerListQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    unassigned: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .strict();
export type LecturerListQuery = z.infer<typeof lecturerListQuerySchema>;

export const lecturerUserIdParamSchema = z
  .object({ lecturerUserId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type LecturerUserIdParam = z.infer<typeof lecturerUserIdParamSchema>;

/** PATCH /admin/lecturers/:lecturerUserId/department */
export const moveLecturerSchema = z
  .object({ departmentId: z.string().uuid('Choose a department.') })
  .strict();
export type MoveLecturerInput = z.infer<typeof moveLecturerSchema>;

export const aliasIdParamSchema = z.object({ aliasId: z.string().uuid('Not a valid identifier.') }).strict();
export type AliasIdParam = z.infer<typeof aliasIdParamSchema>;

export const departmentIdParamSchema = z.object({ departmentId: z.string().uuid('Not a valid identifier.') }).strict();
export type DepartmentIdParam = z.infer<typeof departmentIdParamSchema>;

/** POST /admin/departments/:departmentId/merge — :departmentId is the duplicate, folded into `intoDepartmentId`. */
export const mergeDepartmentSchema = z.object({ intoDepartmentId: z.string().uuid('Choose the department to keep.') }).strict();
export type MergeDepartmentInput = z.infer<typeof mergeDepartmentSchema>;

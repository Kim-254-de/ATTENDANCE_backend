import { z } from 'zod';
import { inviteeSchema } from '../auth/auth.schema.js';

/** Request contracts for the admin module. */

/**
 * A department, as an administrator creates it: its name and its code
 * ("DCOMP"), unique across the university. The Timetable Allocator and
 * Generator know a department by its code.
 */
export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(3, 'Department name is too short.').max(160, 'Department name is too long.'),
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9 ./&-]{0,31}$/, 'A code is up to 32 letters or digits, e.g. DCOMP.'),
  })
  .strict();
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;

/**
 * An administrator invites another administrator, a QA officer, a member of
 * management (university-wide), a member of the timetabling office (who signs
 * in at the Timetable Generator) or the officer for one department.
 */
export const adminInvitationSchema = z.discriminatedUnion('role', [
  inviteeSchema.extend({ role: z.literal('admin') }).strict(),
  inviteeSchema.extend({ role: z.literal('qa') }).strict(),
  inviteeSchema.extend({ role: z.literal('management') }).strict(),
  // The Directorate of Examinations and Timetabling: they sign in at the Timetable Generator.
  inviteeSchema.extend({ role: z.literal('timetabling') }).strict(),
  inviteeSchema.extend({ role: z.literal('department'), departmentId: z.string().uuid('Choose a department.') }).strict(),
]);
export type AdminInvitationInput = z.infer<typeof adminInvitationSchema>;

export const officerUserIdParamSchema = z
  .object({ userId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type OfficerUserIdParam = z.infer<typeof officerUserIdParamSchema>;

export const unitIdParamSchema = z
  .object({ unitId: z.string().uuid('Not a valid identifier.') })
  .strict();
export type UnitIdParam = z.infer<typeof unitIdParamSchema>;

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

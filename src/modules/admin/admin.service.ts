import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import * as invitationService from '../auth/auth.invitation.js';
import type { RegistrationContext } from '../auth/auth.service.js';
import { listOfficers, type InvitedRole } from '../auth/auth.invitation.repository.js';
import type { AdminInvitationInput } from './admin.schema.js';
import * as adminRepository from './admin.repository.js';
import * as placement from '../lecturer/lecturer.placement.js';

/**
 * The administrator's console: the top of the invitation chain
 * (auth.invitation.ts). An administrator creates faculties, invites
 * administrators and faculty officers, and can remove anyone's officer access.
 * Department officers are invited by their faculty officer, not here.
 */

export interface Actor {
  userId: string;
  fullName: string;
}

/** GET /admin/faculties */
export async function listFaculties(): Promise<adminRepository.FacultyRow[]> {
  return adminRepository.listFaculties();
}

/** POST /admin/faculties */
export async function createFaculty(name: string, actor: Actor, context: RegistrationContext): Promise<{ facultyId: string; name: string }> {
  try {
    const faculty = await adminRepository.createFaculty(name);
    await auditService.record({
      action: 'FACULTY_CREATED',
      outcome: 'SUCCESS',
      userId: actor.userId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { facultyId: faculty.id, name: faculty.name },
    });
    return { facultyId: faculty.id, name: faculty.name };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw AppError.conflict(`A faculty named "${name}" already exists.`, ErrorCode.CONFLICT, {
        details: [{ field: 'name', message: 'This faculty name is already in use.' }],
      });
    }
    throw error;
  }
}

/** Every role an administrator manages; QA officers sit outside faculties, so only the admin console lists them. */
const OFFICER_ROLES: InvitedRole[] = ['ADMIN', 'FACULTY', 'DEPARTMENT', 'QA'];

/** GET /admin/officers — every administrator, faculty, department and QA officer. */
export async function listAllOfficers(): Promise<invitationService.OfficerDto[]> {
  return (await listOfficers({ roles: OFFICER_ROLES })).map(invitationService.officerDto);
}

/** POST /admin/invitations */
export async function invite(
  input: AdminInvitationInput,
  actor: Actor,
  context: RegistrationContext,
): Promise<invitationService.InvitationResult> {
  const inviter = { userId: actor.userId, fullName: actor.fullName };
  if (input.role === 'admin' || input.role === 'qa') {
    const scope = input.role === 'admin' ? { role: 'ADMIN' as const } : { role: 'QA' as const };
    return invitationService.invite({ email: input.email, fullName: input.fullName, scope, scopeName: null }, inviter, context);
  }
  const facultyName = await adminRepository.findFacultyName(input.facultyId);
  if (!facultyName) throw AppError.badRequest('That faculty does not exist.');
  return invitationService.invite(
    { email: input.email, fullName: input.fullName, scope: { role: 'FACULTY', facultyId: input.facultyId }, scopeName: facultyName },
    inviter,
    context,
  );
}

async function requireOfficer(userId: string) {
  const [officer] = await listOfficers({ roles: OFFICER_ROLES, userId });
  if (!officer) throw AppError.notFound('No such officer or administrator.');
  return officer;
}

/** POST /admin/officers/:userId/resend */
export async function resendInvitation(userId: string, actor: Actor, context: RegistrationContext): Promise<invitationService.InvitationResult> {
  return invitationService.resend(await requireOfficer(userId), { userId: actor.userId, fullName: actor.fullName }, context);
}

/**
 * POST /admin/officers/:userId/deactivate — any administrator or officer. An
 * administrator cannot remove themselves, so at least one always remains.
 */
export async function deactivate(userId: string, actor: Actor, context: RegistrationContext): Promise<void> {
  await invitationService.deactivate(await requireOfficer(userId), actor.userId, context);
}

/** GET /admin/departments */
export async function listDepartments(): Promise<adminRepository.DepartmentRow[]> {
  return adminRepository.listDepartments();
}

/** Most lecturers the placement list returns at once. */
const PLACEMENT_LIMIT = 100;

/** GET /admin/lecturers — unassigned lecturers first, then everyone, optionally searched. */
export async function listLecturers(options: { search?: string; unassignedOnly?: boolean } = {}): Promise<placement.PlacementLecturerRow[]> {
  return placement.listLecturers({
    unassignedOnly: options.unassignedOnly,
    search: options.search?.trim() || null,
    limit: PLACEMENT_LIMIT,
  });
}

/** PATCH /admin/lecturers/:lecturerUserId/department — any lecturer, any department, across faculties too. */
export async function moveLecturer(
  lecturerUserId: string,
  departmentId: string,
  actor: Actor,
  context: RegistrationContext,
): Promise<placement.MoveResult> {
  const lecturer = await placement.findLecturer(lecturerUserId);
  if (!lecturer) throw AppError.notFound('No such lecturer.');
  const department = await placement.findDepartment(departmentId);
  if (!department) throw AppError.badRequest('That department does not exist.');
  if (lecturer.departmentId === department.id) return { ...lecturer, learnedSpelling: null, alsoPlaced: 0 };
  return placement.moveLecturer(lecturer, department, { userId: actor.userId, kind: 'ADMIN' }, context);
}

/** GET /admin/department-aliases */
export async function listDepartmentAliases(): Promise<adminRepository.DepartmentAliasRow[]> {
  return adminRepository.listDepartmentAliases();
}

/**
 * DELETE /admin/department-aliases/:aliasId — for a spelling learned wrongly.
 * Lecturers already placed through it stay where they are; only future
 * sign-ins stop matching it.
 */
export async function deleteDepartmentAlias(aliasId: string, actor: Actor, context: RegistrationContext): Promise<void> {
  const removed = await adminRepository.deleteDepartmentAlias(aliasId);
  if (!removed) throw AppError.notFound('No such spelling.');
  await auditService.record({
    action: 'DEPARTMENT_ALIAS_REMOVED', outcome: 'SUCCESS', userId: actor.userId,
    requestId: context.requestId, ipAddress: context.ipAddress, userAgent: context.userAgent,
    metadata: removed,
  });
}

/** GET /admin/department-duplicates */
export async function listDuplicateDepartments(): Promise<adminRepository.DuplicateDepartmentRow[][]> {
  return adminRepository.listDuplicateDepartments();
}

/**
 * POST /admin/departments/:departmentId/merge
 *
 * Folds the duplicate into the department kept: its lecturers, officers,
 * courses, units, audits and evaluation results all move across, and its name
 * becomes a spelling of the one kept, so SMARTTT's use of it still matches.
 * Cannot be undone, so it is audited with both names and every count.
 */
export async function mergeDepartment(
  duplicateId: string,
  intoDepartmentId: string,
  actor: Actor,
  context: RegistrationContext,
): Promise<{ departmentId: string; name: string }> {
  if (duplicateId === intoDepartmentId) throw AppError.badRequest('Choose a different department to keep.');
  const [duplicate, keep] = await Promise.all([placement.findDepartment(duplicateId), placement.findDepartment(intoDepartmentId)]);
  if (!duplicate) throw AppError.notFound('No such department.');
  if (!keep) throw AppError.badRequest('The department to keep does not exist.');
  await adminRepository.mergeDepartments(duplicate.id, keep.id, actor.userId);
  await auditService.record({
    action: 'DEPARTMENTS_MERGED', outcome: 'SUCCESS', userId: actor.userId,
    requestId: context.requestId, ipAddress: context.ipAddress, userAgent: context.userAgent,
    metadata: { mergedDepartmentId: duplicate.id, mergedName: duplicate.name, keptDepartmentId: keep.id, keptName: keep.name },
  });
  return { departmentId: keep.id, name: keep.name };
}

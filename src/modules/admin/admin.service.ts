import { AppError } from '../../common/errors/index.js';
import { auditService } from '../audit/index.js';
import { directoryService } from '../directory/index.js';
import * as invitationService from '../auth/auth.invitation.js';
import type { RegistrationContext } from '../auth/auth.service.js';
import { listOfficers, type InvitedRole } from '../auth/auth.invitation.repository.js';
import type { AdminInvitationInput } from './admin.schema.js';
import * as adminRepository from './admin.repository.js';
import * as placement from '../lecturer/lecturer.placement.js';

/**
 * The administrator's console: the top of the invitation chain
 * (auth.invitation.ts). An administrator creates departments, invites
 * administrators, management, department and QA officers, and can remove
 * anyone's officer access.
 */

export interface Actor {
  userId: string;
  fullName: string;
}

/**
 * POST /admin/departments — created in SMARTTT, which owns departments, then
 * linked here; the Allocator and Generator read it from here.
 */
export async function createDepartment(
  input: { name: string; code: string },
  actor: Actor,
  context: RegistrationContext,
): Promise<{ departmentId: string; name: string; code: string }> {
  const department = await directoryService.createDepartment(input.name, input.code);
  await auditService.record({
    action: 'DEPARTMENT_CREATED',
    outcome: 'SUCCESS',
    userId: actor.userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { departmentId: department.id, name: department.name, code: department.code },
  });
  return { departmentId: department.id, name: department.name, code: department.code };
}

/** GET /admin/directory — whether SMARTTT is connected, and what only exists here. */
export async function directoryStatus(): Promise<{ smartttConnected: boolean; onlyHere: { departments: number } }> {
  return { smartttConnected: directoryService.smartttDirectoryEnabled(), onlyHere: await directoryService.unlinkedCounts() };
}

/**
 * POST /admin/directory/sync — reads SMARTTT's departments now,
 * then sends the ones that only exist here to SMARTTT.
 */
export async function syncDirectory(actor: Actor, context: RegistrationContext): Promise<{
  fromSmarttt: directoryService.SyncReport | null;
  toSmarttt: directoryService.SendReport;
}> {
  const toSmarttt = await directoryService.sendLocalToSmarttt();
  const fromSmarttt = await directoryService.syncFromSmarttt({ force: true });
  await auditService.record({
    action: 'DIRECTORY_SYNCED',
    outcome: 'SUCCESS',
    userId: actor.userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { fromSmarttt, toSmarttt },
  });
  return { fromSmarttt, toSmarttt };
}

/** Every role an administrator manages. */
const OFFICER_ROLES: InvitedRole[] = ['ADMIN', 'MANAGEMENT', 'DEPARTMENT', 'QA'];

/** GET /admin/officers — every administrator, management, department and QA officer. */
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
  if (input.role !== 'department') {
    const scope = { role: input.role.toUpperCase() as 'ADMIN' | 'QA' | 'MANAGEMENT' };
    return invitationService.invite({ email: input.email, fullName: input.fullName, scope, scopeName: null }, inviter, context);
  }
  const departmentName = await adminRepository.findDepartmentName(input.departmentId);
  if (!departmentName) throw AppError.badRequest('That department does not exist.');
  return invitationService.invite(
    { email: input.email, fullName: input.fullName, scope: { role: 'DEPARTMENT', departmentId: input.departmentId }, scopeName: departmentName },
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

/** GET /admin/units/pending — lecturer-unit assignments the timetable could not confirm. */
export async function listPendingUnits(): Promise<adminRepository.PendingUnitRow[]> {
  return adminRepository.listPendingUnits();
}

/**
 * POST /admin/units/:unitId/verify — confirms the lecturer is allocated to the
 * unit, so they can activate classes for it. 409 when it is already verified.
 */
export async function verifyUnit(unitId: string, actor: Actor, context: RegistrationContext): Promise<{ unitId: string; code: string; status: 'VERIFIED' }> {
  const result = await adminRepository.verifyUnit(unitId);
  if (!result) throw AppError.notFound('No such unit.');
  if (!result.verified) throw AppError.conflict(`${result.code} is already verified.`);
  await auditService.record({
    action: 'UNIT_VERIFIED',
    outcome: 'SUCCESS',
    userId: actor.userId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { unitId, unitCode: result.code, lecturerUserId: result.lecturerUserId },
  });
  return { unitId, code: result.code, status: 'VERIFIED' };
}

/** GET /admin/departments — SMARTTT's departments (read into the copy here first), plus any only here. */
export async function listDepartments(): Promise<adminRepository.DepartmentRow[]> {
  await directoryService.syncFromSmarttt();
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

/** PATCH /admin/lecturers/:lecturerUserId/department — any lecturer, any department. */
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

import { AppError, ErrorCode } from '../../common/errors/index.js';
import { isUniqueViolation } from '../../db/database.js';
import { auditService } from '../audit/index.js';
import * as invitationService from '../auth/auth.invitation.js';
import type { RegistrationContext } from '../auth/auth.service.js';
import { listOfficers } from '../auth/auth.invitation.repository.js';
import type { AdminInvitationInput } from './admin.schema.js';
import * as adminRepository from './admin.repository.js';

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

/** GET /admin/officers — every administrator, faculty officer and department officer. */
export async function listAllOfficers(): Promise<invitationService.OfficerDto[]> {
  return (await listOfficers({ roles: ['ADMIN', 'FACULTY', 'DEPARTMENT'] })).map(invitationService.officerDto);
}

/** POST /admin/invitations */
export async function invite(
  input: AdminInvitationInput,
  actor: Actor,
  context: RegistrationContext,
): Promise<invitationService.InvitationResult> {
  const inviter = { userId: actor.userId, fullName: actor.fullName };
  if (input.role === 'admin') {
    return invitationService.invite({ email: input.email, fullName: input.fullName, scope: { role: 'ADMIN' }, scopeName: null }, inviter, context);
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
  const [officer] = await listOfficers({ roles: ['ADMIN', 'FACULTY', 'DEPARTMENT'], userId });
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

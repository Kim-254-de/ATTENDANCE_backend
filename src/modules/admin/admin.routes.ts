import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as adminController from './admin.controller.js';
import { adminSmartttRouter } from './admin.smarttt.js';
import { adminInvitationSchema, aliasIdParamSchema, createFacultySchema, departmentIdParamSchema, lecturerListQuerySchema, lecturerUserIdParamSchema, mergeDepartmentSchema, moveLecturerSchema, officerUserIdParamSchema, unitIdParamSchema } from './admin.schema.js';

/** Every route is gated to the ADMIN role. */
export const adminRouter: Router = Router();

/** Every faculty, with its department and officer counts. */
adminRouter.get('/faculties', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.faculties));

/** Creates a faculty. 409 when the name is taken. */
adminRouter.post(
  '/faculties',
  asyncHandler(requireAuth('ADMIN')),
  validate({ body: createFacultySchema }),
  asyncHandler(adminController.createFaculty),
);

/** Every administrator, faculty officer and department officer, with invitation status. */
adminRouter.get('/officers', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.officers));

/**
 * Invites an administrator, or a faculty officer for one faculty (auth.invitation.ts).
 *
 * 201 - { userId, emailSent }; emailSent false means re-send it
 * 400 - invalid input, unknown faculty, or an email outside OFFICER_EMAIL_DOMAINS
 * 409 - someone already has an account with that email
 */
adminRouter.post(
  '/invitations',
  asyncHandler(requireAuth('ADMIN')),
  validate({ body: adminInvitationSchema }),
  asyncHandler(adminController.invite),
);

/** Sends a pending invitation again with a new link. 409 once accepted or deactivated. */
adminRouter.post(
  '/officers/:userId/resend',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: officerUserIdParamSchema }),
  asyncHandler(adminController.resend),
);

/** Removes an officer's or administrator's access: signed out, invitation withdrawn. Not oneself. */
adminRouter.post(
  '/officers/:userId/deactivate',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: officerUserIdParamSchema }),
  asyncHandler(adminController.deactivate),
);

/** Units still PENDING_VERIFICATION (the timetable doesn't list their lecturer), oldest first. */
adminRouter.get('/units/pending', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.pendingUnits));

/**
 * Confirms the lecturer is allocated to teach the unit: PENDING_VERIFICATION -> VERIFIED.
 *
 * 200 - { unitId, code, status: 'VERIFIED' }
 * 404 - no such unit
 * 409 - already verified
 */
adminRouter.post(
  '/units/:unitId/verify',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: unitIdParamSchema }),
  asyncHandler(adminController.verifyUnit),
);

/** Every department with its faculty, for placing a lecturer. */
adminRouter.get('/departments', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.departments));

/** Lecturers, unassigned ones first. `?q=&unassigned=true` */
adminRouter.get(
  '/lecturers',
  asyncHandler(requireAuth('ADMIN')),
  validate({ query: lecturerListQuerySchema }),
  asyncHandler(adminController.lecturers),
);

/** Places or moves a lecturer in any department, across faculties too. Units stay with their owners. */
adminRouter.patch(
  '/lecturers/:lecturerUserId/department',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: lecturerUserIdParamSchema, body: moveLecturerSchema }),
  asyncHandler(adminController.moveLecturer),
);

/** Department spellings learned from placements and merges (db/migrations/036_department_spelling.sql). */
adminRouter.get('/department-aliases', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.departmentAliases));

/** Removes a wrongly learned spelling. Lecturers already placed stay where they are. */
adminRouter.delete(
  '/department-aliases/:aliasId',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: aliasIdParamSchema }),
  asyncHandler(adminController.deleteDepartmentAlias),
);

/** Groups of departments whose names mean the same thing, for merging. */
adminRouter.get('/department-duplicates', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.duplicateDepartments));

/** Folds :departmentId into `intoDepartmentId`; its name becomes a spelling of the one kept. Cannot be undone. */
adminRouter.post(
  '/departments/:departmentId/merge',
  asyncHandler(requireAuth('ADMIN')),
  validate({ params: departmentIdParamSchema, body: mergeDepartmentSchema }),
  asyncHandler(adminController.mergeDepartment),
);

/**
 * Faculties and departments belong to SMARTTT (src/modules/directory): whether
 * it is connected, and how many exist only here.
 */
adminRouter.get('/directory', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.directoryStatus));

/** Reads SMARTTT's faculties and departments now and sends the ones only here to SMARTTT. 503 when SMARTTT can't be reached. */
adminRouter.post('/directory/sync', asyncHandler(requireAuth('ADMIN')), asyncHandler(adminController.syncDirectory));

/** SMARTTT's admin functions, for the signed-in administrator (admin.smarttt.ts). */
adminRouter.use('/smarttt', adminSmartttRouter);

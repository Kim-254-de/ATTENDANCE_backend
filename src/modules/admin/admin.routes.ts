import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as adminController from './admin.controller.js';
import { adminInvitationSchema, createFacultySchema, officerUserIdParamSchema } from './admin.schema.js';

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

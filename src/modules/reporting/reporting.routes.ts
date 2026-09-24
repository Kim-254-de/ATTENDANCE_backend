import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as reportingController from './reporting.controller.js';
import { listSessionReportsQuerySchema, sessionIdParamSchema } from './reporting.schema.js';

export const reportingRouter: Router = Router();

/** Session-by-session attendance history: the Dashboard's "Recent Sessions" and the Attendance page's full log. */
reportingRouter.get(
  '/sessions',
  asyncHandler(requireAuth('LECTURER')),
  validate({ query: listSessionReportsQuerySchema }),
  asyncHandler(reportingController.listSessionReports),
);

/** CSV of one session's attendee list (present/absent). */
reportingRouter.get(
  '/sessions/:sessionId/export',
  asyncHandler(requireAuth('LECTURER')),
  validate({ params: sessionIdParamSchema }),
  asyncHandler(reportingController.exportSessionCsv),
);

import { Router, type Request, type Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as eligibilityService from './eligibility.service.js';

/**
 * GET /attendance-policy — the minimum attendance to sit exams, for every
 * signed-in role: students and lecturers see their standing against it, and
 * the oversight portals show who falls short. Editing it is QA's
 * (quality-assurance/attendance-policy); the reports live in each portal's
 * own module so each resolves its own scope.
 */
export const attendancePolicyRouter: Router = Router();

attendancePolicyRouter.get(
  '/',
  asyncHandler(requireAuth()),
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await eligibilityService.getPolicy());
  }),
);

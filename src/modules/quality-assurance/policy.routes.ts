import { Router, type Request, type Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import { validate } from '../../middleware/validate.js';
import { eligibilityService } from '../eligibility/index.js';
import {
  qaEligibilityQuerySchema,
  updatePolicySchema,
  type QaEligibilityQuery,
  type UpdatePolicyInput,
} from '../eligibility/eligibility.schema.js';

/**
 * The exam-eligibility rule, QA's to set (the Senate decides it; the QA
 * directorate keeps the system in line with it), and the institution-wide
 * report of who falls short. Every route is gated to the QA role.
 */
export const policyRouter: Router = Router();

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

policyRouter.get(
  '/attendance-policy',
  asyncHandler(requireAuth('QA')),
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await eligibilityService.getPolicy());
  }),
);

policyRouter.put(
  '/attendance-policy',
  asyncHandler(requireAuth('QA')),
  validate({ body: updatePolicySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = req.body as UpdatePolicyInput;
    sendSuccess(res, await eligibilityService.updatePolicy(input, userId(req), { ...clientFingerprint(req), requestId: req.requestId }));
  }),
);

/** `?departmentId=&all=true` — institution-wide unless narrowed. */
policyRouter.get(
  '/eligibility',
  asyncHandler(requireAuth('QA')),
  validate({ query: qaEligibilityQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { all, departmentId } = req.query as unknown as QaEligibilityQuery;
    sendSuccess(res, await eligibilityService.buildReport({ departmentId }, { includeAll: all }));
  }),
);

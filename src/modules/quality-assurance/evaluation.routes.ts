import { Router, type Request, type Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as evaluationService from './evaluation.service.js';
import {
  createRoundSchema,
  resultsQuerySchema,
  roundIdParamSchema,
  updateRoundSchema,
  type CreateRoundInput,
  type ResultsQuery,
  type RoundIdParam,
  type UpdateRoundInput,
} from './evaluation.schema.js';

/**
 * Student course evaluation rounds, QA's side. Every route is gated to the QA
 * role. Students answer through /students/me/evaluations; department
 * officers read their own results under /departments.
 *
 * GET    /                list rounds
 * POST   /                create a round with its questions
 * GET    /:id             one round with its questions
 * PATCH  /:id             change details; questions only until someone answers (409)
 * POST   /:id/close       end it now
 * DELETE /:id             only before anyone answers (409)
 * GET    /:id/results     `?departmentId=`
 */
export const evaluationRouter: Router = Router();

function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

const roundId = (req: Request): string => (req.params as unknown as RoundIdParam).id;

evaluationRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  asyncHandler(async (_req: Request, res: Response) => sendSuccess(res, await evaluationService.listRounds())),
);

evaluationRouter.post(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ body: createRoundSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    sendCreated(res, await evaluationService.createRound(req.body as CreateRoundInput, userId(req)))),
);

evaluationRouter.get(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: roundIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await evaluationService.getRound(roundId(req)))),
);

evaluationRouter.patch(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: roundIdParamSchema, body: updateRoundSchema }),
  asyncHandler(async (req: Request, res: Response) =>
    sendSuccess(res, await evaluationService.updateRound(roundId(req), req.body as UpdateRoundInput))),
);

evaluationRouter.post(
  '/:id/close',
  asyncHandler(requireAuth('QA')),
  validate({ params: roundIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => sendSuccess(res, await evaluationService.closeRound(roundId(req)))),
);

evaluationRouter.delete(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: roundIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await evaluationService.deleteRound(roundId(req));
    res.status(204).end();
  }),
);

evaluationRouter.get(
  '/:id/results',
  asyncHandler(requireAuth('QA')),
  validate({ params: roundIdParamSchema, query: resultsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { departmentId } = req.query as unknown as ResultsQuery;
    sendSuccess(res, await evaluationService.getResults(roundId(req), { departmentId }, { allowUnstarted: true }));
  }),
);

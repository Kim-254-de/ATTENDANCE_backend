import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as standardsController from './standards.controller.js';
import {
  createStandardSchema,
  listStandardsQuerySchema,
  standardIdParamSchema,
  updateStandardSchema,
} from './standards.schema.js';

/** The quality-standards catalog. Every route is gated to the QA role. */
export const standardsRouter: Router = Router();

standardsRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ query: listStandardsQuerySchema }),
  asyncHandler(standardsController.list),
);

standardsRouter.post(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ body: createStandardSchema }),
  asyncHandler(standardsController.create),
);

standardsRouter.get(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: standardIdParamSchema }),
  asyncHandler(standardsController.getById),
);

standardsRouter.patch(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: standardIdParamSchema, body: updateStandardSchema }),
  asyncHandler(standardsController.update),
);

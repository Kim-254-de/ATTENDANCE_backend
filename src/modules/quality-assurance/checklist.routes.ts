import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as checklistController from './checklist.controller.js';
import {
  createItemSchema,
  createTemplateSchema,
  listTemplatesQuerySchema,
  templateIdParamSchema,
  templateItemParamsSchema,
  updateItemSchema,
  updateTemplateSchema,
} from './checklist.schema.js';

/** Checklist templates and their items. Every route is gated to the QA role. */
export const checklistRouter: Router = Router();

checklistRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ query: listTemplatesQuerySchema }),
  asyncHandler(checklistController.listTemplates),
);

checklistRouter.post(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ body: createTemplateSchema }),
  asyncHandler(checklistController.createTemplate),
);

checklistRouter.get(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: templateIdParamSchema }),
  asyncHandler(checklistController.getTemplateDetail),
);

checklistRouter.patch(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: templateIdParamSchema, body: updateTemplateSchema }),
  asyncHandler(checklistController.updateTemplate),
);

checklistRouter.post(
  '/:id/items',
  asyncHandler(requireAuth('QA')),
  validate({ params: templateIdParamSchema, body: createItemSchema }),
  asyncHandler(checklistController.createItem),
);

checklistRouter.patch(
  '/:id/items/:itemId',
  asyncHandler(requireAuth('QA')),
  validate({ params: templateItemParamsSchema, body: updateItemSchema }),
  asyncHandler(checklistController.updateItem),
);

checklistRouter.delete(
  '/:id/items/:itemId',
  asyncHandler(requireAuth('QA')),
  validate({ params: templateItemParamsSchema }),
  asyncHandler(checklistController.deleteItem),
);

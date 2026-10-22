import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as capaController from './capa.controller.js';
import * as exportController from './export.controller.js';
import { capaIdParamSchema, createCapaSchema, listCapaQuerySchema, updateCapaSchema } from './capa.schema.js';

/** Corrective action plans (CAPA). Every route is gated to the QA role. */
export const capaRouter: Router = Router();

/** Static paths before `/:id` so "export.csv"/"export.pdf" are never parsed as a CAPA id. */
capaRouter.get(
  '/export.csv',
  asyncHandler(requireAuth('QA')),
  validate({ query: listCapaQuerySchema }),
  asyncHandler(exportController.exportCapaCsv),
);
capaRouter.get(
  '/export.pdf',
  asyncHandler(requireAuth('QA')),
  validate({ query: listCapaQuerySchema }),
  asyncHandler(exportController.exportCapaPdf),
);

capaRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ query: listCapaQuerySchema }),
  asyncHandler(capaController.list),
);

capaRouter.post(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ body: createCapaSchema }),
  asyncHandler(capaController.create),
);

capaRouter.get(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: capaIdParamSchema }),
  asyncHandler(capaController.getById),
);

capaRouter.patch(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: capaIdParamSchema, body: updateCapaSchema }),
  asyncHandler(capaController.update),
);

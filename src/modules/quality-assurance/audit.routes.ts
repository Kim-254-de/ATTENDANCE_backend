import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as auditController from './audit.controller.js';
import * as exportController from './export.controller.js';
import {
  auditFindingParamsSchema,
  auditIdParamSchema,
  createAuditSchema,
  listAuditsQuerySchema,
  updateAuditSchema,
  upsertFindingSchema,
} from './audit.schema.js';

/** Audits and their findings. Every route is gated to the QA role. */
export const auditRouter: Router = Router();

/** Static paths before `/:id` so "export.csv"/"export.pdf" are never parsed as an audit id. */
auditRouter.get(
  '/export.csv',
  asyncHandler(requireAuth('QA')),
  validate({ query: listAuditsQuerySchema }),
  asyncHandler(exportController.exportAuditsCsv),
);
auditRouter.get(
  '/export.pdf',
  asyncHandler(requireAuth('QA')),
  validate({ query: listAuditsQuerySchema }),
  asyncHandler(exportController.exportAuditsPdf),
);

auditRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ query: listAuditsQuerySchema }),
  asyncHandler(auditController.list),
);

auditRouter.post(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ body: createAuditSchema }),
  asyncHandler(auditController.create),
);

auditRouter.get(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema }),
  asyncHandler(auditController.getById),
);

auditRouter.patch(
  '/:id',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema, body: updateAuditSchema }),
  asyncHandler(auditController.update),
);

auditRouter.get(
  '/:id/checklist',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema }),
  asyncHandler(auditController.getChecklistView),
);

auditRouter.get(
  '/:id/findings',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema }),
  asyncHandler(auditController.listFindings),
);

auditRouter.put(
  '/:id/findings/:checklistItemId',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditFindingParamsSchema, body: upsertFindingSchema }),
  asyncHandler(auditController.upsertFinding),
);

auditRouter.get(
  '/:id/export.csv',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema }),
  asyncHandler(exportController.exportAuditDetailCsv),
);

auditRouter.get(
  '/:id/export.pdf',
  asyncHandler(requireAuth('QA')),
  validate({ params: auditIdParamSchema }),
  asyncHandler(exportController.exportAuditDetailPdf),
);

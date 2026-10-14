import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as exportController from './export.controller.js';
import * as kpiController from './kpi.controller.js';
import { dashboardQuerySchema } from './kpi.schema.js';

/** The KPI dashboard. Every route is gated to the QA role. */
export const kpiRouter: Router = Router();

kpiRouter.get(
  '/',
  asyncHandler(requireAuth('QA')),
  validate({ query: dashboardQuerySchema }),
  asyncHandler(kpiController.getDashboard),
);

kpiRouter.get(
  '/export.csv',
  asyncHandler(requireAuth('QA')),
  validate({ query: dashboardQuerySchema }),
  asyncHandler(exportController.exportDashboardCsv),
);

kpiRouter.get(
  '/export.pdf',
  asyncHandler(requireAuth('QA')),
  validate({ query: dashboardQuerySchema }),
  asyncHandler(exportController.exportDashboardPdf),
);

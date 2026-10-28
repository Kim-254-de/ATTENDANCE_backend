import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as managementController from './management.controller.js';
import { departmentParamSchema, yearParamSchema } from './management.schema.js';

/**
 * University-wide attendance, read-only. Gated to the MANAGEMENT role.
 */
export const managementRouter: Router = Router();

/** Every department in the university with its check-ins and attendance rate. */
managementRouter.get(
  '/departments',
  asyncHandler(requireAuth('MANAGEMENT')),
  asyncHandler(managementController.departments),
);

/** One department's attendance for Years 1–4. 404 when it doesn't exist. */
managementRouter.get(
  '/departments/:departmentId',
  asyncHandler(requireAuth('MANAGEMENT')),
  validate({ params: departmentParamSchema }),
  asyncHandler(managementController.department),
);

/** One year of a department: its units, each with its lecturer and students. */
managementRouter.get(
  '/departments/:departmentId/years/:year',
  asyncHandler(requireAuth('MANAGEMENT')),
  validate({ params: yearParamSchema }),
  asyncHandler(managementController.year),
);

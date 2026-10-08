import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as departmentController from './department.controller.js';
import { lecturerUserIdParamSchema, timekeepingQuerySchema } from './department.schema.js';

/**
 * Every route is gated to the DEPARTMENT role, and every handler resolves the
 * caller's own department server-side. A lecturer or student holding a valid
 * token gets a 403 here, not a filtered view.
 */
export const departmentRouter: Router = Router();

/** The signed-in officer's department, and the faculty it sits under. */
departmentRouter.get(
  '/me',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.me),
);

/** The department's stat cards: head counts, average attendance, punctuality. */
departmentRouter.get(
  '/overview',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.overview),
);

/** One row per lecturer in the department, with their attendance and timekeeping figures. */
departmentRouter.get(
  '/lecturers',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.lecturers),
);

/** One lecturer's units and recent sessions. 404 unless that lecturer is in the caller's department. */
departmentRouter.get(
  '/lecturers/:lecturerUserId',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: lecturerUserIdParamSchema }),
  asyncHandler(departmentController.lecturerDetail),
);

/** Every active student across the department's units, one row per (student, unit). */
departmentRouter.get(
  '/students',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.students),
);

/** The department's units, with each one's attendance rate and owning lecturer. */
departmentRouter.get(
  '/units',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.units),
);

/** Session-level punctuality log. `?lecturerUserId=&unitId=&limit=` */
departmentRouter.get(
  '/timekeeping',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ query: timekeepingQuerySchema }),
  asyncHandler(departmentController.timekeeping),
);

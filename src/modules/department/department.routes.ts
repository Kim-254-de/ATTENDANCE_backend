import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as departmentController from './department.controller.js';
import { allocateLecturerSchema, lecturerUserIdParamSchema, offeringIdParamSchema, setSegmentCountSchema, timekeepingQuerySchema } from './department.schema.js';

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

/** Courses faculty has provided to the department, with how many of their planned segments are filled. */
departmentRouter.get(
  '/courses',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.courses),
);

/** How many lecturer-taught sections a course needs. 404 unless the course is in the caller's department. */
departmentRouter.patch(
  '/courses/:offeringId',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: offeringIdParamSchema, body: setSegmentCountSchema }),
  asyncHandler(departmentController.setSegmentCount),
);

/** Allocates one of the department's own lecturers to the next open segment — immediate, creates a real unit. */
departmentRouter.post(
  '/courses/:offeringId/segments',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: offeringIdParamSchema, body: allocateLecturerSchema }),
  asyncHandler(departmentController.allocateLecturer),
);

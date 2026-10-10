import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as facultyController from './faculty.controller.js';
import { createDepartmentSchema, departmentIdParamSchema, lecturerUserIdParamSchema, provideCourseSchema, timekeepingQuerySchema } from './faculty.schema.js';

/**
 * Every route is gated to the FACULTY role, and every handler resolves the
 * caller's own faculty server-side. A department officer or lecturer holding
 * a valid token gets a 403 here, not a filtered view.
 */
export const facultyRouter: Router = Router();

/** The signed-in officer's faculty. */
facultyRouter.get(
  '/me',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.me),
);

/** The faculty's stat cards: department/lecturer/student counts, average attendance, punctuality. */
facultyRouter.get(
  '/overview',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.overview),
);

/** One row per department in the faculty — comparing departments against each other. */
facultyRouter.get(
  '/departments',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.departments),
);

/** One department's lecturers and units. 404 unless that department is in the caller's faculty. */
facultyRouter.get(
  '/departments/:departmentId',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: departmentIdParamSchema }),
  asyncHandler(facultyController.departmentDetail),
);

/** Every lecturer in the faculty, across every department. */
facultyRouter.get(
  '/lecturers',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.lecturers),
);

/** One lecturer's units and recent sessions. 404 unless that lecturer is in the caller's faculty. */
facultyRouter.get(
  '/lecturers/:lecturerUserId',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: lecturerUserIdParamSchema }),
  asyncHandler(facultyController.lecturerDetail),
);

/** Every active student across the faculty's units, one row per (student, unit). */
facultyRouter.get(
  '/students',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.students),
);

/** The faculty's units, with each one's attendance rate, owning lecturer and department. */
facultyRouter.get(
  '/units',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.units),
);

/** Session-level punctuality log. `?lecturerUserId=&unitId=&departmentId=&limit=` */
facultyRouter.get(
  '/timekeeping',
  asyncHandler(requireAuth('FACULTY')),
  validate({ query: timekeepingQuerySchema }),
  asyncHandler(facultyController.timekeeping),
);

/** Creates a department in the caller's own faculty. */
facultyRouter.post(
  '/departments',
  asyncHandler(requireAuth('FACULTY')),
  validate({ body: createDepartmentSchema }),
  asyncHandler(facultyController.createDepartment),
);

/** Provides a course to one of the caller's own departments — no lecturer yet. */
facultyRouter.post(
  '/departments/:departmentId/courses',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: departmentIdParamSchema, body: provideCourseSchema }),
  asyncHandler(facultyController.provideCourse),
);

/** Every course offering across every department in the faculty, with department named. */
facultyRouter.get(
  '/courses',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.courses),
);

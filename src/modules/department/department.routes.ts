import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as departmentController from './department.controller.js';
import { eligibilityQuerySchema } from '../eligibility/eligibility.schema.js';
import { roundIdParamSchema } from '../quality-assurance/evaluation.schema.js';
import { allocateLecturerSchema, lecturerSearchQuerySchema, lecturerUserIdParamSchema, offeringIdParamSchema, setSegmentCountSchema, studentUserIdParamSchema, timekeepingQuerySchema } from './department.schema.js';

/**
 * Every route is gated to the DEPARTMENT role, and every handler resolves the
 * caller's own department server-side. A lecturer or student holding a valid
 * token gets a 403 here, not a filtered view.
 */
export const departmentRouter: Router = Router();

/** The signed-in officer's department, with its code. */
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

/** One lecturer's units and recent sessions in this department. 404 unless they are its staff or teach one of its units. */
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

/** Courses provided to the department, with how many of their planned segments are filled. */
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

/** Lecturers anywhere in the institution, own staff first, for the allocation picker. `?q=` searches name or staff number. */
departmentRouter.get(
  '/lecturer-directory',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ query: lecturerSearchQuerySchema }),
  asyncHandler(departmentController.lecturerDirectory),
);

/** Allocates a lecturer (own staff or borrowed) to the next open segment — immediate, creates a real unit owned by this department. */
departmentRouter.post(
  '/courses/:offeringId/segments',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: offeringIdParamSchema, body: allocateLecturerSchema }),
  asyncHandler(departmentController.allocateLecturer),
);

/**
 * Deletes a lecturer's account: anonymised and signed out, their units and
 * sessions kept in the figures (auth.deletion.ts). 404 unless the lecturer
 * is in the caller's department.
 */
departmentRouter.delete(
  '/lecturers/:lecturerUserId',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: lecturerUserIdParamSchema }),
  asyncHandler(departmentController.deleteLecturer),
);

/** Deletes a student's account, the same way. 404 unless the student is on a roster of one of the department's units. */
departmentRouter.delete(
  '/students/:studentUserId',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: studentUserIdParamSchema }),
  asyncHandler(departmentController.deleteStudent),
);

/** Exam eligibility on the department's units: at-risk and not-eligible students, worst first. `?all=true` for everyone. */
departmentRouter.get(
  '/eligibility',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ query: eligibilityQuerySchema }),
  asyncHandler(departmentController.eligibility),
);

/** Student course evaluation rounds that have opened. */
departmentRouter.get(
  '/evaluations',
  asyncHandler(requireAuth('DEPARTMENT')),
  asyncHandler(departmentController.evaluations),
);

/** One round's results for the department's units. Units under the round's minimum responses show counts only. */
departmentRouter.get(
  '/evaluations/:id',
  asyncHandler(requireAuth('DEPARTMENT')),
  validate({ params: roundIdParamSchema }),
  asyncHandler(departmentController.evaluationResults),
);

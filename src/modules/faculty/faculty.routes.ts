import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as facultyController from './faculty.controller.js';
import { facultyEligibilityQuerySchema } from '../eligibility/eligibility.schema.js';
import { facultyResultsQuerySchema, roundIdParamSchema } from '../quality-assurance/evaluation.schema.js';
import { createDepartmentSchema, departmentIdParamSchema, inviteDepartmentOfficerSchema, lecturerUserIdParamSchema, officerUserIdParamSchema, provideCourseSchema, studentUserIdParamSchema, timekeepingQuerySchema, moveLecturerSchema, placementQuerySchema } from './faculty.schema.js';

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

/**
 * Deletes a lecturer's account: anonymised and signed out, their units and
 * sessions kept in the figures (auth.deletion.ts). 404 unless the lecturer
 * is in the caller's faculty.
 */
facultyRouter.delete(
  '/lecturers/:lecturerUserId',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: lecturerUserIdParamSchema }),
  asyncHandler(facultyController.deleteLecturer),
);

/** Deletes a student's account, the same way. 404 unless the student is on a roster of one of the faculty's units. */
facultyRouter.delete(
  '/students/:studentUserId',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: studentUserIdParamSchema }),
  asyncHandler(facultyController.deleteStudent),
);

/** The department officers of the faculty's departments, with invitation status. */
facultyRouter.get(
  '/officers',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.officers),
);

/**
 * Invites the officer for one of the faculty's departments (auth.invitation.ts).
 *
 * 201 - { userId, emailSent }; emailSent false means re-send it
 * 404 - the department is not in the caller's faculty
 * 409 - someone already has an account with that email
 */
facultyRouter.post(
  '/departments/:departmentId/officers',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: departmentIdParamSchema, body: inviteDepartmentOfficerSchema }),
  asyncHandler(facultyController.inviteDepartmentOfficer),
);

/** Sends a department officer's pending invitation again. 404 outside the faculty. */
facultyRouter.post(
  '/officers/:userId/resend',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: officerUserIdParamSchema }),
  asyncHandler(facultyController.resendOfficerInvitation),
);

/** Removes a department officer's access. 404 outside the faculty. */
facultyRouter.post(
  '/officers/:userId/deactivate',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: officerUserIdParamSchema }),
  asyncHandler(facultyController.deactivateOfficer),
);

/**
 * Lecturers to place in a department: every unassigned lecturer (no SMARTTT
 * department name matched), then the faculty's own staff. `?q=&unassigned=true`
 */
facultyRouter.get(
  '/lecturer-placement',
  asyncHandler(requireAuth('FACULTY')),
  validate({ query: placementQuerySchema }),
  asyncHandler(facultyController.placementLecturers),
);

/**
 * Places a lecturer in one of the faculty's departments, or moves them between
 * its departments. 404 unless the lecturer is unassigned or in the faculty;
 * 400 unless the department is the faculty's. Units stay with their owners.
 */
facultyRouter.patch(
  '/lecturers/:lecturerUserId/department',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: lecturerUserIdParamSchema, body: moveLecturerSchema }),
  asyncHandler(facultyController.moveLecturer),
);

/** Exam eligibility across the faculty's units. `?departmentId=&all=true` */
facultyRouter.get(
  '/eligibility',
  asyncHandler(requireAuth('FACULTY')),
  validate({ query: facultyEligibilityQuerySchema }),
  asyncHandler(facultyController.eligibility),
);

/** Student course evaluation rounds that have opened. */
facultyRouter.get(
  '/evaluations',
  asyncHandler(requireAuth('FACULTY')),
  asyncHandler(facultyController.evaluations),
);

/** One round's results across the faculty's units. `?departmentId=` */
facultyRouter.get(
  '/evaluations/:id',
  asyncHandler(requireAuth('FACULTY')),
  validate({ params: roundIdParamSchema, query: facultyResultsQuerySchema }),
  asyncHandler(facultyController.evaluationResults),
);

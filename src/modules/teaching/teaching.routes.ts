import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as c from './teaching.controller.js';
import {
  bulkSchema,
  coursePatchSchema,
  courseSchema,
  formatParamSchema,
  groupPatchSchema,
  groupsSchema,
  idParamSchema,
  lecturerPatchSchema,
  lecturerSchema,
  spreadsheetSchema,
  termQuerySchema,
  unitPatchSchema,
  unitSchema,
} from './teaching.schema.js';

/**
 * A department's teaching for a term of the Timetable Generator: courses,
 * units, groups and the department's lecturers, published to the Director.
 * Mounted at /departments/teaching, gated to department officers; every
 * route acts on the officer's own department only.
 */
export const teachingRouter: Router = Router();

const officer = asyncHandler(requireAuth('DEPARTMENT'));
const term = validate({ query: termQuerySchema });
const byId = validate({ params: idParamSchema });

teachingRouter.get('/terms', officer, asyncHandler(c.terms));
teachingRouter.get('/', officer, term, asyncHandler(c.board));

teachingRouter.post('/courses', officer, term, validate({ body: courseSchema }), asyncHandler(c.createCourse));
teachingRouter.post('/courses/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkCourses));
teachingRouter.patch('/courses/:id', officer, term, byId, validate({ body: coursePatchSchema }), asyncHandler(c.updateCourse));
teachingRouter.delete('/courses/:id', officer, term, byId, asyncHandler(c.deleteCourse));

teachingRouter.post('/units', officer, term, validate({ body: unitSchema }), asyncHandler(c.createUnit));
teachingRouter.post('/units/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkUnits));
teachingRouter.patch('/units/:id', officer, term, byId, validate({ body: unitPatchSchema }), asyncHandler(c.updateUnit));
teachingRouter.delete('/units/:id', officer, term, byId, asyncHandler(c.deleteUnit));
/** The unit's groups, all at once: one whole class, or groups A, B, C... */
teachingRouter.put('/units/:id/groups', officer, term, byId, validate({ body: groupsSchema }), asyncHandler(c.setGroups));

teachingRouter.post('/groups/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkGroups));
teachingRouter.patch('/groups/:id', officer, term, byId, validate({ body: groupPatchSchema }), asyncHandler(c.updateGroup));

/** Sends the department's list to the Director and locks it; reopen unlocks it. */
teachingRouter.post('/publish', officer, term, asyncHandler(c.publish));
teachingRouter.post('/reopen', officer, term, asyncHandler(c.reopen));

teachingRouter.get('/export/:format', officer, term, validate({ params: formatParamSchema }), asyncHandler(c.exportForm));

teachingRouter.get('/lecturers', officer, asyncHandler(c.listLecturers));
teachingRouter.post('/lecturers', officer, term, validate({ body: lecturerSchema }), asyncHandler(c.createLecturer));
teachingRouter.post('/lecturers/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkLecturers));
teachingRouter.patch('/lecturers/:id', officer, term, byId, validate({ body: lecturerPatchSchema }), asyncHandler(c.updateLecturer));
teachingRouter.delete('/lecturers/:id', officer, term, byId, asyncHandler(c.deleteLecturer));

teachingRouter.post('/spreadsheet', officer, validate({ body: spreadsheetSchema }), asyncHandler(c.spreadsheet));

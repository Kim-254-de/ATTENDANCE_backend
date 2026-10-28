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
  invigilatorSchema,
  letterParamSchema,
  letterQuerySchema,
  lecturerPatchSchema,
  lecturerSchema,
  noWrittenExamSchema,
  paperPatchSchema,
  paperSchema,
  practicalSchema,
  spreadsheetSchema,
  termQuerySchema,
  unitPatchSchema,
  unitSchema,
  examListFileSchema,
  examListSaveSchema,
  paperRowsSchema,
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

// -- exams: papers, practicals, the moderation letter, invigilators --------------------------------
// Exam papers and invigilators are each published to the Director on their own, locking only their list.

teachingRouter.get('/exams', officer, term, asyncHandler(c.examBoard));
teachingRouter.post('/exam-papers', officer, term, validate({ body: paperSchema }), asyncHandler(c.createPaper));
/** A paper per unit not on one yet, titled as the unit. */
teachingRouter.post('/exam-papers/from-units', officer, term, asyncHandler(c.papersFromUnits));
teachingRouter.post('/exam-papers/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkPapers));
// The department's exam list uploaded as its Word document, sized by who synced the units in SMARTTT.
teachingRouter.post('/exam-list/read', officer, term, validate({ body: examListFileSchema }), asyncHandler(c.readExamList));
teachingRouter.post('/exam-list', officer, term, validate({ body: examListSaveSchema }), asyncHandler(c.saveExamList));
teachingRouter.delete('/exam-list', officer, term, asyncHandler(c.deleteExamList));
teachingRouter.post('/exam-papers/recount', officer, term, asyncHandler(c.recountPapers));
teachingRouter.put('/exam-papers/:id/rows', officer, term, byId, validate({ body: paperRowsSchema }), asyncHandler(c.setPaperRows));
teachingRouter.patch('/exam-papers/:id', officer, term, byId, validate({ body: paperPatchSchema }), asyncHandler(c.updatePaper));
teachingRouter.delete('/exam-papers/:id', officer, term, byId, asyncHandler(c.deletePaper));
teachingRouter.put('/units/:id/no-written-exam', officer, term, byId, validate({ body: noWrittenExamSchema }), asyncHandler(c.noWrittenExam));

teachingRouter.post('/practicals', officer, term, validate({ body: practicalSchema }), asyncHandler(c.createPractical));
teachingRouter.post('/practicals/bulk', officer, term, validate({ body: bulkSchema }), asyncHandler(c.bulkPracticals));
teachingRouter.put('/practicals/:id', officer, term, byId, validate({ body: practicalSchema }), asyncHandler(c.updatePractical));
teachingRouter.delete('/practicals/:id', officer, term, byId, asyncHandler(c.deletePractical));

teachingRouter.post('/exams/publish', officer, term, asyncHandler(c.publishExams));
teachingRouter.post('/exams/reopen', officer, term, asyncHandler(c.reopenExams));
teachingRouter.get(
  '/moderation-letter/:format',
  officer,
  validate({ params: letterParamSchema, query: letterQuerySchema }),
  asyncHandler(c.moderationLetter),
);

/** Once the Director shares an exam draft: who invigilates each of the department's papers. */
teachingRouter.get('/invigilators', officer, term, asyncHandler(c.invigilatorBoard));
teachingRouter.put('/invigilators/:id', officer, term, byId, validate({ body: invigilatorSchema }), asyncHandler(c.setInvigilator));
teachingRouter.post('/invigilators/publish', officer, term, asyncHandler(c.publishInvigilators));
teachingRouter.post('/invigilators/reopen', officer, term, asyncHandler(c.reopenInvigilators));

import type { Request, Response } from 'express';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { sendCreated, sendSuccess } from '../../common/http/index.js';
import * as examList from './exam-list.service.js';
import * as exams from './exams.service.js';
import type { PaperInput, PracticalInput } from './exams.service.js';
import * as invigilation from './invigilation.service.js';
import { LETTER_BUILDERS, LETTER_MEDIA, type LetterFormat } from './moderation-letter.js';
import * as bulk from './teaching.import.js';
import { BUILDERS, layout, MEDIA, readWorkbook, WorkbookError } from './teaching.export.js';
import * as teaching from './teaching.service.js';
import type {
  BulkInput, ExamListFileInput, ExamListSaveInput, FormatParam, IdParam, LetterQuery, ManyPaperRowsInput, PaperRowsInput, SpreadsheetInput, TermQuery,
} from './teaching.schema.js';
import type { CourseInput, GroupInput, GroupPatch, LecturerInput, UnitInput } from './teaching.service.js';

/**
 * HTTP in and out only. The department is never read from the request: the
 * service resolves it from the signed-in officer, as everywhere in the
 * department portal. `?term=` picks the Generator's term (default: the newest).
 */
function userId(req: Request): string {
  const id = req.auth?.userId;
  if (!id) throw AppError.unauthenticated('Please sign in.');
  return id;
}

const ctx = (req: Request) => teaching.context(userId(req), (req.query as TermQuery).term);
const param = (req: Request) => (req.params as unknown as IdParam).id;
const rows = (req: Request) => (req.body as BulkInput).rows;

/** GET /departments/teaching/terms */
export async function terms(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.terms());
}

/** GET /departments/teaching */
export async function board(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.board(await ctx(req)));
}

export async function createCourse(req: Request, res: Response): Promise<void> {
  sendCreated(res, await teaching.createCourse(await ctx(req), req.body as CourseInput));
}
export async function updateCourse(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.updateCourse(await ctx(req), param(req), req.body as CourseInput));
}
export async function deleteCourse(req: Request, res: Response): Promise<void> {
  await teaching.deleteCourse(await ctx(req), param(req));
  sendSuccess(res, null);
}
export async function bulkCourses(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkCourses(await ctx(req), rows(req)));
}

export async function createUnit(req: Request, res: Response): Promise<void> {
  sendCreated(res, await teaching.createUnit(await ctx(req), req.body as UnitInput));
}
export async function updateUnit(req: Request, res: Response): Promise<void> {
  await teaching.updateUnit(await ctx(req), param(req), req.body as UnitInput);
  sendSuccess(res, null);
}
export async function deleteUnit(req: Request, res: Response): Promise<void> {
  await teaching.deleteUnit(await ctx(req), param(req));
  sendSuccess(res, null);
}
export async function bulkUnits(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkUnits(await ctx(req), rows(req)));
}

export async function setGroups(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.setGroups(await ctx(req), param(req), (req.body as { groups: GroupInput[] }).groups));
}
export async function updateGroup(req: Request, res: Response): Promise<void> {
  await teaching.updateGroup(await ctx(req), param(req), req.body as GroupPatch);
  sendSuccess(res, null);
}
export async function bulkGroups(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkGroups(await ctx(req), rows(req)));
}

export async function publish(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.publish(await ctx(req)));
}
export async function reopen(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.reopen(await ctx(req)));
}

/** GET /departments/teaching/export/:format — the allocation form. */
export async function exportForm(req: Request, res: Response): Promise<void> {
  const context = await ctx(req);
  const { format } = req.params as unknown as FormatParam;
  const data = await teaching.board(context);
  const content = await BUILDERS[format](layout(data, data.publication?.publishedBy ?? context.actor));
  const term = data.term.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'term';
  res
    .status(200)
    .type(MEDIA[format])
    .setHeader('Content-Disposition', `attachment; filename="allocation-${context.department.code}-${term}.${format}"`)
    .send(content);
}

export async function listLecturers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.listLecturers(userId(req)));
}
export async function createLecturer(req: Request, res: Response): Promise<void> {
  sendCreated(res, await teaching.createLecturer(await ctx(req), req.body as LecturerInput));
}
export async function updateLecturer(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await teaching.updateLecturer(await ctx(req), param(req), req.body as LecturerInput));
}
export async function deleteLecturer(req: Request, res: Response): Promise<void> {
  await teaching.deleteLecturer(await ctx(req), param(req));
  sendSuccess(res, null);
}
export async function bulkLecturers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkLecturers(await ctx(req), rows(req)));
}

/** POST /departments/teaching/spreadsheet — a .xlsx read back as cells, for the paste dialog. Nothing is stored. */
export async function spreadsheet(req: Request, res: Response): Promise<void> {
  const content = Buffer.from((req.body as SpreadsheetInput).file, 'base64');
  if (content.length > 5 * 1024 * 1024) {
    throw new AppError(413, ErrorCode.VALIDATION_FAILED, 'The workbook is larger than 5 MB. Keep only the sheet you need.');
  }
  try {
    sendSuccess(res, { sheets: await readWorkbook(content) });
  } catch (error) {
    if (error instanceof WorkbookError) throw new AppError(422, ErrorCode.VALIDATION_FAILED, error.message);
    throw error;
  }
}

// -- exams -----------------------------------------------------------------------------------------

export async function examBoard(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await exams.board(await ctx(req)));
}

/** POST /departments/teaching/exam-list/read: the uploaded .docx read and checked against SMARTTT. Nothing is stored. */
export async function readExamList(req: Request, res: Response): Promise<void> {
  const file = Buffer.from((req.body as ExamListFileInput).file, 'base64');
  sendSuccess(res, await examList.review(await ctx(req), file));
}

/** POST /departments/teaching/exam-list: the reviewed papers saved, sized from SMARTTT. */
export async function saveExamList(req: Request, res: Response): Promise<void> {
  const c = await ctx(req);
  const result = await examList.save(c, (req.body as ExamListSaveInput).papers);
  sendSuccess(res, { ...result, board: await exams.board(c) });
}

/** DELETE /departments/teaching/exam-list: every listed paper of the department's removed at once. */
export async function deleteExamList(req: Request, res: Response): Promise<void> {
  const c = await ctx(req);
  const result = await examList.removeList(c);
  sendSuccess(res, { ...result, board: await exams.board(c) });
}

/** PUT /departments/teaching/exam-papers/:id/rows: the department's numbers for a listed paper. */
export async function setPaperRows(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await examList.setRows(await ctx(req), param(req), (req.body as PaperRowsInput).rows));
}

/** PUT /departments/teaching/exam-papers/rows: many listed papers' numbers at once. */
export async function setManyPaperRows(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await examList.setManyRows(await ctx(req), (req.body as ManyPaperRowsInput).papers));
}

/** POST /departments/teaching/exam-papers/recount: listed papers' numbers read from SMARTTT again. */
export async function recountPapers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await examList.recount(await ctx(req)));
}
export async function createPaper(req: Request, res: Response): Promise<void> {
  sendCreated(res, await exams.createPaper(await ctx(req), req.body as PaperInput));
}
export async function papersFromUnits(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await exams.startFromUnits(await ctx(req)));
}
export async function bulkPapers(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkPapers(await ctx(req), rows(req)));
}
export async function updatePaper(req: Request, res: Response): Promise<void> {
  await exams.updatePaper(await ctx(req), param(req), req.body as PaperInput);
  sendSuccess(res, null);
}
export async function deletePaper(req: Request, res: Response): Promise<void> {
  await exams.deletePaper(await ctx(req), param(req));
  sendSuccess(res, null);
}
export async function noWrittenExam(req: Request, res: Response): Promise<void> {
  await exams.setNoWrittenExam(await ctx(req), param(req), (req.body as { noWrittenExam: boolean }).noWrittenExam);
  sendSuccess(res, null);
}
export async function createPractical(req: Request, res: Response): Promise<void> {
  sendCreated(res, await exams.savePractical(await ctx(req), null, req.body as PracticalInput));
}
export async function bulkPracticals(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await bulk.bulkPracticals(await ctx(req), rows(req)));
}
export async function updatePractical(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await exams.savePractical(await ctx(req), param(req), req.body as PracticalInput));
}
export async function deletePractical(req: Request, res: Response): Promise<void> {
  await exams.deletePractical(await ctx(req), param(req));
  sendSuccess(res, null);
}
export async function publishExams(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await exams.publish(await ctx(req)));
}
export async function reopenExams(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await exams.reopen(await ctx(req)));
}

/** GET /departments/teaching/moderation-letter/:format — the letter sent with the exam drafts. */
export async function moderationLetter(req: Request, res: Response): Promise<void> {
  const q = req.query as unknown as LetterQuery;
  const context = await teaching.context(userId(req), q.term);
  const { format } = req.params as unknown as { format: LetterFormat };
  const data = await exams.board(context);
  const content = await LETTER_BUILDERS[format]({
    department: context.department.name,
    term: context.term.name,
    date: q.date || new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    moderator: q.moderator.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    papers: data.papers.map((p) => [p.sitting === 'odel' ? `${p.codes} (ODEL)` : p.codes, p.title]),
    signedBy: data.publication?.publishedBy ?? context.actor,
  });
  res
    .status(200)
    .type(LETTER_MEDIA[format])
    .setHeader('Content-Disposition', `attachment; filename="moderation-letter-${context.department.code}.${format}"`)
    .send(content);
}

export async function invigilatorBoard(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await invigilation.board(await ctx(req)));
}
export async function setInvigilator(req: Request, res: Response): Promise<void> {
  const { lecturerId, room } = req.body as { lecturerId: string | null; room: string };
  await invigilation.setInvigilator(await ctx(req), param(req), lecturerId, room);
  sendSuccess(res, null);
}
export async function publishInvigilators(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await invigilation.publish(await ctx(req)));
}
export async function reopenInvigilators(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await invigilation.reopen(await ctx(req)));
}

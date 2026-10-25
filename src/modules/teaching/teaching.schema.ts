import { z } from 'zod';

const id = z.string().uuid('Not a valid identifier.');
const hours = z.number().min(0).max(500).nullable();

export const termQuerySchema = z.object({ term: z.string().trim().min(1).max(64).optional() }).strict();
export type TermQuery = z.infer<typeof termQuerySchema>;

export const idParamSchema = z.object({ id }).strict();
export type IdParam = z.infer<typeof idParamSchema>;

export const formatParamSchema = z.object({ format: z.enum(['pdf', 'docx', 'xlsx']) }).strict();
export type FormatParam = z.infer<typeof formatParamSchema>;

/** A cohort: 'BSC.CS', year 1, semester 1, 120 students (sub-class optional). */
const course = {
  programme: z.string().trim().min(1).max(64),
  year: z.number().int().min(1).max(7),
  semester: z.number().int().min(1).max(3),
  subClass: z.string().trim().max(10),
  students: z.number().int().min(1).max(5000),
};
export const courseSchema = z.object({ ...course, subClass: course.subClass.default('') }).strict();
export const coursePatchSchema = z.object(course).partial().strict();

const roomType = z.enum(['lecture_hall', 'lab', 'seminar']);
const unit = {
  code: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(255),
  weeklyHours: z.number().int().min(1).max(20),
  classLength: z.number().int().min(1).max(6),
  roomType,
  // The courses that take it: this department's or, for servicing, another's.
  courseIds: z.array(id).min(1).max(50),
};
export const unitSchema = z.object({ ...unit, roomType: roomType.default('lecture_hall') }).strict();
export const unitPatchSchema = z.object(unit).partial().strict();

const groupFields = {
  lecturerId: id.nullable(),
  lectureHours: hours,
  practicalHours: hours,
  cfHours: hours,
};

/** One class of a unit. `label` is '' for the whole class, else 'A', 'GR B'... */
export const groupsSchema = z
  .object({
    groups: z
      .array(
        z
          .object({
            label: z.string().trim().max(50).default(''),
            members: z.array(z.object({ courseId: id, students: z.number().int().min(1).max(5000).nullable().optional() }).strict()).min(1).max(50),
            ...groupFields,
          })
          .partial({ lecturerId: true, lectureHours: true, practicalHours: true, cfHours: true })
          .strict(),
      )
      .min(1)
      .max(26),
  })
  .strict();
export const groupPatchSchema = z.object(groupFields).partial().strict();

const lecturer = {
  title: z.string().trim().max(30),
  fullName: z.string().trim().min(1).max(255),
  staffNumber: z.string().trim().max(64).nullable(),
  employmentType: z.enum(['full_time', 'part_time']),
  phone: z.string().trim().max(40),
  email: z.string().trim().max(255),
  maxWeeklyHours: z.number().int().min(0).max(60).nullable(),
  active: z.boolean(),
};
export const lecturerSchema = z
  .object(lecturer)
  .partial({ title: true, staffNumber: true, employmentType: true, phone: true, email: true, maxWeeklyHours: true, active: true })
  .strict();
export const lecturerPatchSchema = z.object(lecturer).partial().strict();

/** Pasted rows, each keyed by its column heading. */
export const bulkSchema = z
  .object({ rows: z.array(z.record(z.union([z.string(), z.number(), z.null()]))).min(1).max(2000) })
  .strict();
export type BulkInput = z.infer<typeof bulkSchema>;

/** A .xlsx file for the paste dialog, base64 (the JSON body limit on this path allows ~5 MB). */
export const spreadsheetSchema = z.object({ file: z.string().min(1).max(7_000_000) }).strict();
export type SpreadsheetInput = z.infer<typeof spreadsheetSchema>;

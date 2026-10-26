import { z } from 'zod';
import { locationSchema, studentLocationSchema } from '../session/session.schema.js';

/** Request contracts for exam sessions (exam.service.ts) and SMARTTT's pushes. */

export const examSessionIdParamSchema = z.object({ sessionId: z.string().uuid('Not a valid identifier.') }).strict();

/** Opening an exam room: the fence is on unless the invigilator turns it off. */
export const openExamSessionSchema = z
  .object({
    geofence: z.enum(['ON', 'OFF']).default('ON'),
    location: locationSchema.optional(),
  })
  .strict();
export type OpenExamSessionInput = z.infer<typeof openExamSessionSchema>;

export const examCheckInSchema = z
  .object({
    payload: z.string().trim().min(8, 'Not a valid exam code.').max(512),
    /** Required when the room's fence is on. */
    location: studentLocationSchema.optional(),
  })
  .strict();
export type ExamCheckInInput = z.infer<typeof examCheckInSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM.');

const pushedExamSessionSchema = z.object({
  key: z.string().trim().min(1).max(220),
  paper_key: z.string().trim().min(1).max(160),
  unit_codes: z.array(z.string().trim().min(1).max(64)).min(1).max(10),
  title: z.string().trim().max(255).default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  start_time: hhmm,
  end_time: hhmm,
  room: z.string().trim().min(1).max(80),
  candidates: z.array(z.unknown()).max(200).default([]),
  registration_numbers: z.array(z.string().trim().min(1).max(64)).max(5000).default([]),
  invigilator_staff_number: z.string().trim().min(1).max(64),
  role: z.enum(['main', 'extra']),
  main_invigilator_staff_number: z.string().trim().max(64).nullish(),
});

/** SMARTTT's latest exam version for a term (attendance_push.exam_sessions_payload there). */
export const examSessionsPushSchema = z.object({
  term_id: z.string().trim().min(1).max(64),
  version: z.number().int().positive(),
  sessions: z.array(pushedExamSessionSchema).max(5000),
});
export type ExamSessionsPush = z.infer<typeof examSessionsPushSchema>;

/** The Director switched a term to exams or closed its exam period (attendance_push.push_term_mode there). */
export const termModePushSchema = z.object({
  term_id: z.string().trim().min(1).max(64),
  mode: z.enum(['teaching', 'exams']),
  switched_at: z.string().datetime({ offset: true }).nullish(),
  closed_at: z.string().datetime({ offset: true }).nullish(),
});
export type TermModePush = z.infer<typeof termModePushSchema>;

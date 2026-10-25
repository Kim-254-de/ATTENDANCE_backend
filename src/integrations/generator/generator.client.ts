import { z } from 'zod';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * The Timetable Generator's terms and published times, for the department
 * Teaching page (src/modules/teaching). The Director opens each term there;
 * departments enter their teaching against it here, and once the Director
 * publishes a version the Generator says when and where each class meets.
 *
 * GET {GENERATOR_BASE_URL}{GENERATOR_TERMS_PATH}[/{id}/times], X-API-Key =
 * GENERATOR_API_KEY (= ATTENDANCE_API_KEY in the Generator). Read-only.
 * Failures throw an AppError the Teaching page shows as it is.
 */

export interface GeneratorTerm {
  id: string;
  academicYear: string;
  semester: number;
  name: string;
  /** The Director's latest approved version, or null before the first. */
  publishedVersion: number | null;
}

export interface Meeting {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  room: string;
}

export interface GeneratorTimes {
  publishedVersion: number | null;
  /** By class key ('COSC103-GRA', 'COSC103-MAIN'). */
  classes: Record<string, Meeting[]>;
}

const termSchema = z.object({
  id: z.coerce.string(),
  academic_year: z.string(),
  semester: z.number().int(),
  name: z.string().nullish(),
  published_version: z.number().int().nullish(),
});

const meetingSchema = z.object({
  day_of_week: z.string(),
  start_time: z.string(),
  end_time: z.string(),
  room: z.coerce.string().nullish(),
});

const timesSchema = z.object({
  published_version: z.number().int().nullish(),
  classes: z.record(z.array(meetingSchema)).default({}),
});

export const generatorEnabled = (): boolean => !!env.GENERATOR_BASE_URL && !!env.GENERATOR_API_KEY;

const unavailable = (message = 'The Timetable Generator could not be reached. Try again shortly.') =>
  new AppError(503, ErrorCode.GENERATOR_UNAVAILABLE, message);

async function get(path: string): Promise<unknown> {
  if (!generatorEnabled()) {
    throw new AppError(
      503,
      ErrorCode.GENERATOR_UNAVAILABLE,
      'Smart Attendance is not connected to the Timetable Generator (GENERATOR_BASE_URL). Contact the administrator.',
    );
  }
  const base = env.GENERATOR_BASE_URL!.replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'smart-attendance-backend', 'X-API-Key': env.GENERATOR_API_KEY! },
      signal: AbortSignal.timeout(env.GENERATOR_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, path }, 'generator: request failed');
    throw unavailable();
  }
  if (response.status === 401 || response.status === 403) {
    logger.error({ status: response.status, path }, 'generator: rejected our key - check GENERATOR_API_KEY / ATTENDANCE_API_KEY');
    throw unavailable('Smart Attendance is not connected to the Timetable Generator correctly. Contact the administrator.');
  }
  if (response.status === 404) throw AppError.notFound('The Timetable Generator has no such term.');
  if (!response.ok) {
    logger.warn({ status: response.status, path }, 'generator: unexpected answer');
    throw unavailable('The Timetable Generator could not answer. Try again.');
  }
  const body: unknown = await response.json().catch(() => null);
  // The Generator wraps answers as {success, data}.
  return body && typeof body === 'object' && 'success' in body ? (body as { data?: unknown }).data : body;
}

function parsed<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    logger.error({ what }, 'generator: answer could not be mapped');
    throw unavailable('The Timetable Generator returned an unexpected answer.');
  }
  return result.data;
}

/** Newest first, as the Generator lists them. */
export async function listTerms(): Promise<GeneratorTerm[]> {
  const rows = parsed(z.array(termSchema), await get(env.GENERATOR_TERMS_PATH), 'terms');
  return rows.map((t) => ({
    id: t.id,
    academicYear: t.academic_year,
    semester: t.semester,
    name: t.name?.trim() || `${t.academic_year} semester ${t.semester}`,
    publishedVersion: t.published_version ?? null,
  }));
}

export async function termTimes(termId: string): Promise<GeneratorTimes> {
  const data = parsed(timesSchema, await get(`${env.GENERATOR_TERMS_PATH}/${encodeURIComponent(termId)}/times`), 'times');
  const classes: Record<string, Meeting[]> = {};
  for (const [key, meetings] of Object.entries(data.classes)) {
    classes[key] = meetings.map((m) => ({ dayOfWeek: m.day_of_week, startTime: m.start_time, endTime: m.end_time, room: m.room ?? '' }));
  }
  return { publishedVersion: data.published_version ?? null, classes };
}

export interface SharedPaper {
  /** The paper's id here (teaching_exam_papers.id), as the Generator imported it. */
  paperRef: string;
  codes: string[];
  date: string | null;
  session: number | null;
  startTime: string | null;
  endTime: string | null;
  rooms: string[];
}

export interface SharedExamDraft {
  /** null until the Director shares a draft. */
  draft: { id: string; name: string; sharedAt: string | null; status: string } | null;
  papers: SharedPaper[];
}

const sharedDraftSchema = z.object({
  draft: z
    .object({ id: z.coerce.string(), name: z.string().nullish(), shared_at: z.string().nullish(), status: z.string().nullish() })
    .nullish(),
  papers: z
    .array(
      z.object({
        paper_ref: z.string().nullish(),
        codes: z.array(z.string()).default([]),
        date: z.string().nullish(),
        session: z.number().int().nullish(),
        start_time: z.string().nullish(),
        end_time: z.string().nullish(),
        rooms: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

/** The exam draft the Director shared, for departments to name invigilators on: each paper's day, session and rooms. */
export async function sharedExamDraft(termId: string): Promise<SharedExamDraft> {
  const data = parsed(sharedDraftSchema, await get(`${env.GENERATOR_TERMS_PATH}/${encodeURIComponent(termId)}/exam-draft`), 'exam draft');
  return {
    draft: data.draft
      ? { id: data.draft.id, name: data.draft.name ?? '', sharedAt: data.draft.shared_at ?? null, status: data.draft.status ?? '' }
      : null,
    papers: data.papers
      .filter((p): p is typeof p & { paper_ref: string } => !!p.paper_ref)
      .map((p) => ({
        paperRef: p.paper_ref,
        codes: p.codes,
        date: p.date ?? null,
        session: p.session ?? null,
        startTime: p.start_time ?? null,
        endTime: p.end_time ?? null,
        rooms: p.rooms,
      })),
  };
}

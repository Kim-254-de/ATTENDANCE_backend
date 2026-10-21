import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { errorMessage } from './smarttt.admin.js';

/**
 * SMARTTT's faculties and departments (SMARTTT_FACULTIES_PATH,
 * SMARTTT_DEPARTMENTS_PATH, served by apps/integrations directory_views.py).
 * SMARTTT owns them; src/modules/directory keeps attendance's linked copy.
 * Never throws.
 */

export interface SmartttFaculty {
  id: number;
  name: string;
  code: string;
}

export interface SmartttDepartment {
  id: number;
  name: string;
  code: string;
  facultyId: number;
  active: boolean;
}

export type SmartttDirectoryResult =
  | { status: 'FOUND'; faculties: SmartttFaculty[]; departments: SmartttDepartment[] }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

export type SmartttCreateResult<T> =
  | { status: 'CREATED'; record: T }
  /** The name is already in SMARTTT: link to `id` instead. */
  | { status: 'NAME_TAKEN'; id: number }
  | { status: 'REFUSED'; message: string }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

const facultySchema = z.object({ id: z.number().int(), name: z.string().min(1), code: z.string() });
const departmentSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  code: z.string(),
  faculty_id: z.number().int(),
  status: z.string(),
});

const toFaculty = (f: z.infer<typeof facultySchema>): SmartttFaculty => ({ id: f.id, name: f.name.trim(), code: f.code });
const toDepartment = (d: z.infer<typeof departmentSchema>): SmartttDepartment => ({
  id: d.id,
  name: d.name.trim(),
  code: d.code,
  facultyId: d.faculty_id,
  active: d.status !== 'inactive',
});

export async function listDirectory(): Promise<SmartttDirectoryResult> {
  if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
  const [faculties, departments] = await Promise.all([request('GET', env.SMARTTT_FACULTIES_PATH), request('GET', env.SMARTTT_DEPARTMENTS_PATH)]);
  for (const answer of [faculties, departments]) {
    if (answer.kind === 'failed') return { status: 'UNAVAILABLE', reason: answer.reason };
    if (answer.status !== 200) return { status: 'UNAVAILABLE', reason: `SMARTTT answered HTTP ${answer.status}.` };
  }
  const f = z.object({ faculties: z.array(facultySchema) }).safeParse(faculties.kind === 'answered' ? faculties.body : null);
  const d = z.object({ departments: z.array(departmentSchema) }).safeParse(departments.kind === 'answered' ? departments.body : null);
  if (!f.success || !d.success) {
    logger.error('smarttt directory: faculties or departments could not be mapped');
    return { status: 'UNAVAILABLE', reason: 'SMARTTT returned an unexpected response.' };
  }
  return { status: 'FOUND', faculties: f.data.faculties.map(toFaculty), departments: d.data.departments.map(toDepartment) };
}

export async function createFaculty(name: string): Promise<SmartttCreateResult<SmartttFaculty>> {
  return create(env.SMARTTT_FACULTIES_PATH, { name }, facultySchema, toFaculty);
}

export async function createDepartment(facultyId: number, name: string): Promise<SmartttCreateResult<SmartttDepartment>> {
  return create(env.SMARTTT_DEPARTMENTS_PATH, { faculty_id: facultyId, name }, departmentSchema, toDepartment);
}

async function create<S extends z.ZodTypeAny, T>(
  path: string,
  body: Record<string, unknown>,
  schema: S,
  map: (value: z.infer<S>) => T,
): Promise<SmartttCreateResult<T>> {
  if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };
  const answer = await request('POST', path, body);
  if (answer.kind === 'failed') return { status: 'UNAVAILABLE', reason: answer.reason };
  if (answer.status === 201) {
    const parsed = schema.safeParse(answer.body);
    if (parsed.success) return { status: 'CREATED', record: map(parsed.data as z.infer<S>) };
    logger.error({ path }, 'smarttt directory: created record could not be mapped');
    return { status: 'UNAVAILABLE', reason: 'SMARTTT returned an unexpected response.' };
  }
  const taken = z.object({ code: z.literal('name_taken'), id: z.number().int() }).safeParse(answer.body);
  if (answer.status === 409 && taken.success) return { status: 'NAME_TAKEN', id: taken.data.id };
  if (answer.status === 400 || answer.status === 409) {
    return { status: 'REFUSED', message: errorMessage(answer.body) ?? 'SMARTTT refused it.' };
  }
  return { status: 'UNAVAILABLE', reason: `SMARTTT answered HTTP ${answer.status}.` };
}

type Answer = { kind: 'answered'; status: number; body: unknown } | { kind: 'failed'; reason: string };

async function request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<Answer> {
  const base = (env.SMARTTT_BASE_URL ?? '').replace(/\/+$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'smart-attendance-backend',
        'X-API-Key': env.SMARTTT_API_KEY ?? '',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(env.SMARTTT_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn({ err: error, path }, 'smarttt directory: request failed');
    return { kind: 'failed', reason: 'SMARTTT could not be reached.' };
  }
  if (response.status === 401 || response.status === 403) {
    logger.error({ status: response.status, path }, 'smarttt directory: rejected our key - check SMARTTT_API_KEY / ATTENDANCE_API_KEY');
    return { kind: 'failed', reason: 'SMARTTT rejected our credentials.' };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // An empty or non-JSON body; the status says enough.
  }
  return { kind: 'answered', status: response.status, body: parsed };
}

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * SMARTTT's admin functions, for the admin console (src/modules/admin).
 *
 * The platform has one admin console, attendance's admin portal. Its SMARTTT
 * pages (master timetable upload, terms, lecturer allocation, notifications,
 * staff IDs, venue capacities) are SMARTTT's own admin views, reached over
 * SMARTTT's integrations/admin/ endpoints with the shared key and the
 * administrator's SMARTTT account id:
 *
 *   X-API-Key: SMARTTT_API_KEY          (= ATTENDANCE_API_KEY in SMARTTT)
 *   X-Acting-Account: <SMARTTT user id>
 *
 * SMARTTT runs the request as that administrator, re-checking on every call
 * that they still are one, and keeps its own permission checks and records.
 * Nothing about these functions is stored here.
 *
 * Like the rest of the SMARTTT client, it never throws: the answer says what
 * happened, and the admin module turns it into the API's response.
 */

export type SmartttAdminBody =
  | { kind: 'json'; value: unknown }
  /** A file upload, passed on byte for byte with its multipart boundary. */
  | { kind: 'raw'; value: Buffer; contentType: string };

export interface SmartttAdminRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Under SMARTTT_ADMIN_PATH, e.g. "terms/" or "timetable/upload/<id>/status/". */
  path: string;
  query?: Record<string, string>;
  body?: SmartttAdminBody;
  /** The signed-in administrator's SMARTTT user id (users.smarttt_user_id). */
  actingAccountId: string;
}

export type SmartttAdminAnswer =
  | { status: 'OK'; httpStatus: number; body: unknown }
  /** SMARTTT refused the request itself (400, 403, 404, 409, 422): `message` says why. */
  | { status: 'REFUSED'; httpStatus: number; code: string | null; message: string; body: unknown }
  /** The acting account is no longer a SMARTTT administrator. */
  | { status: 'NOT_ADMIN'; message: string }
  /** SMARTTT rejected our key: SMARTTT_API_KEY here and ATTENDANCE_API_KEY there differ. */
  | { status: 'MISCONFIGURED' }
  | { status: 'UNAVAILABLE'; reason: string }
  | { status: 'DISABLED' };

export async function callSmartttAdmin(request: SmartttAdminRequest): Promise<SmartttAdminAnswer> {
  if (!env.SMARTTT_BASE_URL) return { status: 'DISABLED' };

  const base = env.SMARTTT_BASE_URL.replace(/\/+$/, '');
  const prefix = `/${env.SMARTTT_ADMIN_PATH.replace(/^\/+|\/+$/g, '')}/`;
  const url = new URL(`${base}${prefix}${request.path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'smart-attendance-backend',
    'X-API-Key': env.SMARTTT_API_KEY ?? '',
    'X-Acting-Account': request.actingAccountId,
  };
  let body: string | Buffer | undefined;
  if (request.body?.kind === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.body.value ?? {});
  } else if (request.body?.kind === 'raw') {
    headers['Content-Type'] = request.body.contentType;
    body = request.body.value;
  }

  const log = { method: request.method, path: request.path };
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      body,
      signal: AbortSignal.timeout(env.SMARTTT_ADMIN_TIMEOUT_MS),
    });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    logger.warn({ err: error, ...log }, 'smarttt admin: request failed');
    return {
      status: 'UNAVAILABLE',
      reason: isTimeout ? 'SMARTTT took too long to answer.' : 'SMARTTT could not be reached.',
    };
  }

  const parsed = await readBody(response);
  if (response.status === 401) {
    logger.error(log, 'smarttt admin: SMARTTT rejected our key - check SMARTTT_API_KEY / ATTENDANCE_API_KEY');
    return { status: 'MISCONFIGURED' };
  }
  if (response.status >= 500) {
    logger.error({ ...log, status: response.status }, 'smarttt admin: SMARTTT failed');
    return { status: 'UNAVAILABLE', reason: `SMARTTT answered HTTP ${response.status}.` };
  }
  if (response.status === 404 && parsed === undefined) {
    // No JSON at all: the route itself is missing, i.e. an older SMARTTT.
    logger.error(log, 'smarttt admin: no such endpoint - deploy SMARTTT with apps/integrations admin/');
    return { status: 'UNAVAILABLE', reason: 'SMARTTT does not offer this admin function yet.' };
  }

  const code = errorCode(parsed);
  if (response.status === 403 && code === 'not_admin') {
    return { status: 'NOT_ADMIN', message: errorMessage(parsed) ?? 'You are no longer a SMARTTT administrator.' };
  }
  if (!response.ok) {
    return {
      status: 'REFUSED',
      httpStatus: response.status,
      code,
      message: errorMessage(parsed) ?? `SMARTTT refused the request (HTTP ${response.status}).`,
      body: parsed ?? null,
    };
  }
  return { status: 'OK', httpStatus: response.status, body: parsed ?? null };
}

/** The JSON body; undefined when there is none or it isn't JSON. */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorCode(body: unknown): string | null {
  if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') return body.code;
  return null;
}

/**
 * What DRF said went wrong: `detail`, or a validation error's first messages
 * ("file: This field is required."). Null when there is nothing readable.
 */
export function errorMessage(body: unknown): string | null {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 500);
  if (Array.isArray(body)) return body.map(String).join(' ').slice(0, 500) || null;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['detail', 'error', 'message']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value.slice(0, 500);
  }
  const parts = Object.entries(record)
    .filter(([key]) => key !== 'code')
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.map(String).join(' ') : typeof value === 'string' ? value : null;
      return text ? (key === 'non_field_errors' ? text : `${key}: ${text}`) : null;
    })
    .filter((part): part is string => part !== null);
  return parts.length ? parts.slice(0, 3).join(' ').slice(0, 500) : null;
}

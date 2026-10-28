import express, { Router, type Request, type Response } from 'express';
import { AppError, ErrorCode, type ErrorCodeValue } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { queryOne } from '../../db/database.js';
import { callSmartttAdmin, type SmartttAdminAnswer, type SmartttAdminBody } from '../../integrations/smarttt/smarttt.admin.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import { auditService } from '../audit/index.js';

/**
 * The admin console's SMARTTT pages: SMARTTT's own admin functions, which
 * used to be its separate "SMART ClassCatch Admin" page.
 *
 *   /admin/smarttt/terms ...                 academic terms; set the current one; clear a term's slots
 *   /admin/smarttt/timetable/uploads ...     upload the master timetable, follow it, delete an upload
 *   /admin/smarttt/lecturer-allocation       the departments' allocation documents -> lecturers on slots;
 *                                            DELETE ?source=<department> removes one
 *   /admin/smarttt/notifications             send a notification; the history
 *   /admin/smarttt/staff-ids ...             the approved staff-ID list lecturers register against
 *   /admin/smarttt/rooms/capacities          venue capacities: upload, summary
 *   /admin/smarttt/programs                  programmes, for choosing a notification's audience
 *
 * Each is passed to SMARTTT (src/integrations/smarttt/smarttt.admin.ts) for
 * the signed-in administrator's SMARTTT account. SMARTTT checks they are
 * still one and keeps its own rules and records; attendance stores none of
 * it, and only adds each change to its audit trail. Answers come back in this
 * API's envelope, so the portal handles them like any other.
 */

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type BodyKind = 'none' | 'json' | 'file' | 'file-or-json';

interface Route {
  method: Method;
  /** Under /admin/smarttt, Express style: ":id" is a SMARTTT UUID. */
  path: string;
  /** Under SMARTTT's integrations/admin/, with the same ":id". */
  smarttt: string;
  body: BodyKind;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/terms', smarttt: 'terms/', body: 'none' },
  { method: 'POST', path: '/terms', smarttt: 'terms/', body: 'json' },
  { method: 'PATCH', path: '/terms/:id', smarttt: 'terms/:id/', body: 'json' },
  { method: 'DELETE', path: '/terms/:id', smarttt: 'terms/:id/', body: 'none' },
  { method: 'POST', path: '/terms/:id/set-current', smarttt: 'terms/:id/set-current/', body: 'none' },
  { method: 'DELETE', path: '/terms/:id/slots', smarttt: 'terms/:id/clear-slots/', body: 'none' },

  { method: 'GET', path: '/timetable/uploads', smarttt: 'timetable/upload/list/', body: 'none' },
  { method: 'POST', path: '/timetable/uploads', smarttt: 'timetable/upload/', body: 'file' },
  { method: 'GET', path: '/timetable/uploads/:id/status', smarttt: 'timetable/upload/:id/status/', body: 'none' },
  { method: 'DELETE', path: '/timetable/uploads/:id', smarttt: 'timetable/upload/:id/delete/', body: 'none' },

  { method: 'GET', path: '/lecturer-allocation', smarttt: 'timetable/assign-lecturers/', body: 'none' },
  { method: 'POST', path: '/lecturer-allocation', smarttt: 'timetable/assign-lecturers/', body: 'file-or-json' },
  { method: 'DELETE', path: '/lecturer-allocation', smarttt: 'timetable/assign-lecturers/', body: 'none' },

  { method: 'GET', path: '/notifications', smarttt: 'notifications/', body: 'none' },
  { method: 'POST', path: '/notifications', smarttt: 'notifications/send/', body: 'json' },

  { method: 'GET', path: '/staff-ids', smarttt: 'staff-ids/', body: 'none' },
  { method: 'POST', path: '/staff-ids', smarttt: 'staff-ids/upload/', body: 'file' },
  { method: 'DELETE', path: '/staff-ids/:id', smarttt: 'staff-ids/:id/', body: 'none' },
  { method: 'GET', path: '/staff-id-uploads', smarttt: 'staff-ids/uploads/', body: 'none' },
  { method: 'DELETE', path: '/staff-id-uploads/:id', smarttt: 'staff-ids/uploads/:id/', body: 'none' },

  { method: 'GET', path: '/rooms/capacities', smarttt: 'rooms/capacity-summary/', body: 'none' },
  { method: 'POST', path: '/rooms/capacities', smarttt: 'rooms/upload/', body: 'file' },

  { method: 'GET', path: '/programs', smarttt: 'programs/', body: 'none' },
];

/** SMARTTT's upload validators allow 25 MB; a little more for the multipart framing. */
const MAX_UPLOAD = '26mb';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Values are URL-encoded on the way out; only control characters and very long values are dropped.
// eslint-disable-next-line no-control-regex
const QUERY_VALUE = /^[^\u0000-\u001f\u007f]{0,200}$/;

const rawUpload = express.raw({ type: 'multipart/form-data', limit: MAX_UPLOAD });

export const adminSmartttRouter: Router = Router();

for (const route of ROUTES) {
  const register = adminSmartttRouter[route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete'].bind(adminSmartttRouter);
  const handlers = [asyncHandler(requireAuth('ADMIN'))];
  if (route.body === 'file' || route.body === 'file-or-json') handlers.push(rawUpload);
  register(route.path, ...handlers, asyncHandler((req: Request, res: Response) => forward(route, req, res)));
}

async function forward(route: Route, req: Request, res: Response): Promise<void> {
  const admin = req.auth?.admin;
  if (!admin) throw AppError.unauthenticated('Please sign in.');

  const raw = req.params['id'];
  const id = typeof raw === 'string' ? raw : undefined;
  if (raw !== undefined && (id === undefined || !UUID.test(id))) throw AppError.badRequest('Not a valid identifier.');
  const path = route.smarttt.replace(':id', id ?? '');

  const answer = await callSmartttAdmin({
    method: route.method,
    path,
    query: queryOf(req),
    body: bodyOf(route, req),
    actingAccountId: await actingAccount(admin.id),
  });

  if (route.method !== 'GET') {
    await auditService.record({
      action: 'SMARTTT_ADMIN_ACTION',
      outcome: answer.status === 'OK' ? 'SUCCESS' : 'FAILURE',
      userId: admin.id,
      reason: answer.status === 'OK' ? null : answer.status,
      ...clientFingerprint(req),
      requestId: req.requestId,
      metadata: { method: route.method, path, status: 'httpStatus' in answer ? answer.httpStatus : null },
    });
  }

  const data = unwrap(answer);
  if (data === undefined) {
    res.status(204).end();
    return;
  }
  sendSuccess(res, data, route.method === 'POST' && 'httpStatus' in answer && answer.httpStatus === 201 ? 201 : 200);
}

/**
 * The administrator's SMARTTT account. Every administrator signs in with it,
 * so it is always linked; one signed in before that (with an attendance
 * password) is asked to sign in again.
 */
async function actingAccount(userId: string): Promise<string> {
  const row = await queryOne<{ smarttt_user_id: string | null }>(`SELECT smarttt_user_id FROM users WHERE id = $1`, [userId]);
  if (!row?.smarttt_user_id) {
    throw new AppError(
      403,
      ErrorCode.SMARTTT_LINK_REQUIRED,
      "Sign out and sign in again with your SMARTTT account to use SMARTTT's admin functions.",
    );
  }
  return row.smarttt_user_id;
}

/** Plain query parameters (paging, filters) pass through; anything odd is dropped. */
function queryOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (/^[a-z_]{1,40}$/.test(key) && typeof value === 'string' && QUERY_VALUE.test(value)) out[key] = value;
  }
  return out;
}

function bodyOf(route: Route, req: Request): SmartttAdminBody | undefined {
  if (route.body === 'none') return undefined;
  const contentType = req.get('content-type') ?? '';
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length === 0) throw AppError.badRequest('Choose a file to upload.');
    return { kind: 'raw', value: req.body, contentType };
  }
  if (route.body === 'file') throw AppError.badRequest('Send the file as multipart/form-data.');
  return { kind: 'json', value: req.body ?? {} };
}

const REFUSED_CODES: Record<number, ErrorCodeValue> = {
  400: ErrorCode.VALIDATION_FAILED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.VALIDATION_FAILED,
  422: ErrorCode.VALIDATION_FAILED,
};

/** SMARTTT's body on success (undefined for an empty one); an AppError for everything else. */
function unwrap(answer: SmartttAdminAnswer): unknown {
  switch (answer.status) {
    case 'OK':
      return answer.httpStatus === 204 || answer.body === null ? undefined : answer.body;
    case 'REFUSED': {
      const status = REFUSED_CODES[answer.httpStatus] ? answer.httpStatus : 400;
      throw new AppError(status, REFUSED_CODES[status] ?? ErrorCode.VALIDATION_FAILED, answer.message, {
        details: answer.body ?? undefined,
      });
    }
    case 'NOT_ADMIN':
      throw new AppError(403, ErrorCode.NOT_SMARTTT_ADMIN, 'You are no longer a SMARTTT administrator. Ask ICT if this is wrong.');
    case 'MISCONFIGURED':
      throw new AppError(502, ErrorCode.SMARTTT_MISCONFIGURED, 'Attendance is not connected to SMARTTT correctly. Contact ICT.');
    case 'UNAVAILABLE':
      throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, `${answer.reason} Try again in a minute.`);
    case 'DISABLED':
      throw new AppError(503, ErrorCode.SMARTTT_UNAVAILABLE, 'SMARTTT is not connected (SMARTTT_BASE_URL is unset).');
  }
}

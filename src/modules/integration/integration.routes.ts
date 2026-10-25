import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { tokenHashesMatch } from '../../common/utils/tokens.js';
import { env } from '../../config/env.js';
import { normaliseUnitCode } from '../../integrations/smarttt/index.js';
import { validate } from '../../middleware/validate.js';
import { clientFingerprint } from '../../middleware/request-context.js';
import * as generatorAuth from '../auth/auth.generator.js';
import { directoryService } from '../directory/index.js';
import { examsService, invigilationService, teachingService } from '../teaching/index.js';
import { unitService } from '../unit/index.js';

/**
 * Calls other systems make to us:
 *  - SMARTTT, the other way round from src/integrations/smarttt, with the same
 *    shared key both ways (SMARTTT_API_KEY here = ATTENDANCE_API_KEY there);
 *  - the Timetable Generator, reading the departments administrators create
 *    here and the teaching departments publish, with its key
 *    (GENERATOR_API_KEY here = ATTENDANCE_API_KEY there).
 */
export const integrationRouter: Router = Router();

/** X-API-Key must equal SMARTTT_API_KEY. Fails closed when the key is unset. */
function requireSmartttKey(req: Request, _res: Response, next: NextFunction): void {
  const expected = env.SMARTTT_API_KEY;
  const presented = req.get('X-API-Key');
  if (!expected || !presented || !tokenHashesMatch(presented, expected)) {
    next(new AppError(401, ErrorCode.INVALID_API_KEY, 'Invalid API key.'));
    return;
  }
  next();
}

const timetableChangeSchema = z
  .object({
    /** The rescheduled slot's lecturer, when SMARTTT links one. */
    staff_number: z.string().trim().max(64).nullish(),
    /** The classes that moved, as SMARTTT's lecturer-units sync names them ("COSC 103 GR A"). */
    unit_codes: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  })
  .refine((v) => !!v.staff_number || v.unit_codes.length > 0, {
    message: 'Name a staff_number or at least one unit code.',
  });

/**
 * SMARTTT rescheduled a class (TimetableSlot reschedule). Re-syncs the
 * lecturers it affects now, so the new day, time and room reach the
 * activation gate and the geofence's room straight away.
 */
integrationRouter.post(
  '/smarttt/timetable-changes',
  requireSmartttKey,
  validate({ body: timetableChangeSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as z.infer<typeof timetableChangeSchema>;
    const result = await unitService.resyncAfterTimetableChange({
      staffNumber: body.staff_number?.toUpperCase() || null,
      unitCodes: [...new Set(body.unit_codes.map(normaliseUnitCode))],
    });
    sendSuccess(res, result);
  }),
);

/** X-API-Key must equal the key in `name`. Fails closed when the key is unset. */
const requireKey = (name: 'GENERATOR_API_KEY') => (req: Request, _res: Response, next: NextFunction): void => {
  const expected = env[name];
  const presented = req.get('X-API-Key');
  if (!expected || !presented || !tokenHashesMatch(presented, expected)) {
    next(new AppError(401, ErrorCode.INVALID_API_KEY, 'Invalid API key.'));
    return;
  }
  next();
};

/**
 * The departments, for the Timetable Generator: administrators create them
 * here (in SMARTTT first, which owns them), and the Generator plans each
 * term's units against them. `code` is the department's university-wide code;
 * `smartttDepartmentId` is null for one not yet in SMARTTT; `lecturerCount`
 * is the active lecturers placed in it here.
 */
integrationRouter.get(
  '/generator/departments',
  requireKey('GENERATOR_API_KEY'),
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, { departments: await directoryService.departmentsForTimetabling() });
  }),
);

/**
 * What departments have published in their Teaching page for a term of the
 * Generator, for the Director's "Import published departments": each
 * published department's courses, units and groups (lecturer by staff
 * number), and the departments that haven't published. The shape is the one
 * the Timetable Allocator used to serve (teaching.service.ts `submissions`).
 */
integrationRouter.get(
  '/generator/terms/:termId/submissions',
  requireKey('GENERATOR_API_KEY'),
  validate({ params: z.object({ termId: z.string().trim().min(1).max(64) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await teachingService.submissions((req.params as { termId: string }).termId));
  }),
);

/**
 * Departments' published exam papers (with the class rows sitting each) and
 * practicals, and who hasn't published, for the Director's exam import; and
 * each paper's invigilator once departments publish them. The shapes the
 * Timetable Allocator used to serve.
 */
integrationRouter.get(
  '/generator/terms/:termId/exams',
  requireKey('GENERATOR_API_KEY'),
  validate({ params: z.object({ termId: z.string().trim().min(1).max(64) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await examsService.submissions((req.params as { termId: string }).termId));
  }),
);

integrationRouter.get(
  '/generator/terms/:termId/invigilators',
  requireKey('GENERATOR_API_KEY'),
  validate({ params: z.object({ termId: z.string().trim().min(1).max(64) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    sendSuccess(res, await invigilationService.forGenerator((req.params as { termId: string }).termId));
  }),
);

/**
 * Sign-in for the Timetable Generator: the timetabling office, invited by an
 * administrator here, signs in there with the email and password they chose
 * (src/modules/auth/auth.generator.ts). `{ authenticated: false }` for any
 * wrong login, with no reason given.
 */
integrationRouter.post(
  '/generator/authenticate',
  requireKey('GENERATOR_API_KEY'),
  validate({ body: z.object({ identifier: z.string().trim().min(1).max(255), password: z.string().min(1).max(1024) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { identifier, password } = req.body as { identifier: string; password: string };
    sendSuccess(res, await generatorAuth.authenticate(identifier, password, { ...clientFingerprint(req), requestId: req.requestId }));
  }),
);

/** Whether a Generator session's account is still active and the timetabling office's; 404 once it is not. */
integrationRouter.get(
  '/generator/identity',
  requireKey('GENERATOR_API_KEY'),
  validate({ query: z.object({ account_id: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const found = await generatorAuth.identity((req.query as { account_id: string }).account_id);
    if (!found) throw AppError.notFound('No such active account.');
    sendSuccess(res, found);
  }),
);

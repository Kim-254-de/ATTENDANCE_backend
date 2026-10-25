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
import { directoryService } from '../directory/index.js';
import { unitService } from '../unit/index.js';

/**
 * Calls other systems make to us:
 *  - SMARTTT, the other way round from src/integrations/smarttt, with the same
 *    shared key both ways (SMARTTT_API_KEY here = ATTENDANCE_API_KEY there);
 *  - the Timetable Generator and Allocator, reading the departments
 *    administrators create here, each with its own key (GENERATOR_API_KEY /
 *    ALLOCATOR_API_KEY here = ATTENDANCE_API_KEY there).
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
const requireKey = (name: 'GENERATOR_API_KEY' | 'ALLOCATOR_API_KEY') => (req: Request, _res: Response, next: NextFunction): void => {
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
 * The departments, for the Timetable Allocator, which knows a department by
 * its code: `{ departments: [{ code, name }] }`. A department without a code
 * (made before codes existed) can't be addressed there, so it is left out
 * until an administrator gives it one.
 */
integrationRouter.get(
  '/allocator/departments',
  requireKey('ALLOCATOR_API_KEY'),
  asyncHandler(async (_req: Request, res: Response) => {
    const departments = await directoryService.departmentsForTimetabling();
    sendSuccess(res, {
      departments: departments.filter((d) => d.code).map((d) => ({ code: d.code!, name: d.name })),
    });
  }),
);

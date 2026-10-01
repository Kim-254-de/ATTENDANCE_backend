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
import { unitService } from '../unit/index.js';

/**
 * Calls SMARTTT makes to us, the other way round from src/integrations/smarttt.
 * Authenticated by the same shared key both ways: SMARTTT_API_KEY here equals
 * ATTENDANCE_API_KEY there.
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

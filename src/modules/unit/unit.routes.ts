import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as unitController from './unit.controller.js';
import { createUnitSchema, unitIdParamSchema } from './unit.schema.js';

export const unitRouter: Router = Router();

/** The units the signed-in lecturer teaches, with how many students are on each. */
unitRouter.get('/', requireAuth('LECTURER'), asyncHandler(unitController.listUnits));

/** The unit ActivateClass may open a session for right now, per the lecturer's issued timetable. */
unitRouter.get('/current', requireAuth('LECTURER'), asyncHandler(unitController.getCurrentUnit));

/** A lecturer adds a unit they teach, by code. */
unitRouter.post(
  '/',
  requireAuth('LECTURER'),
  validate({ body: createUnitSchema }),
  asyncHandler(unitController.createUnit),
);

/** Everyone on the unit — read-only, synced from the ERP's enrollment records. */
unitRouter.get(
  '/:unitId/students',
  requireAuth('LECTURER'),
  validate({ params: unitIdParamSchema }),
  asyncHandler(unitController.listStudents),
);

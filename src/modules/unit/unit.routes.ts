import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as unitController from './unit.controller.js';
import {
  addStudentsSchema,
  allocationParamSchema,
  createUnitSchema,
  enrolSchema,
  unitIdParamSchema,
  updateAllocationSchema,
} from './unit.schema.js';

export const unitRouter: Router = Router();

/** The units the signed-in lecturer teaches, with how many students are on each. */
unitRouter.get('/', requireAuth('LECTURER'), asyncHandler(unitController.listUnits));

/** A lecturer adds a unit they teach. */
unitRouter.post(
  '/',
  requireAuth('LECTURER'),
  validate({ body: createUnitSchema }),
  asyncHandler(unitController.createUnit),
);

/** A student asks to join a unit by its code; the lecturer approves. */
unitRouter.post(
  '/enrol',
  requireAuth('STUDENT'),
  validate({ body: enrolSchema }),
  asyncHandler(unitController.enrol),
);

/** Everyone on the unit, pending requests first. */
unitRouter.get(
  '/:unitId/students',
  requireAuth('LECTURER'),
  validate({ params: unitIdParamSchema }),
  asyncHandler(unitController.listStudents),
);

/** Add students by registration number, each verified against the ERP. */
unitRouter.post(
  '/:unitId/students',
  requireAuth('LECTURER'),
  validate({ params: unitIdParamSchema, body: addStudentsSchema }),
  asyncHandler(unitController.addStudents),
);

/** Approve a request, remove a student, or restore one. */
unitRouter.patch(
  '/:unitId/students/:allocationId',
  requireAuth('LECTURER'),
  validate({ params: allocationParamSchema, body: updateAllocationSchema }),
  asyncHandler(unitController.updateAllocation),
);

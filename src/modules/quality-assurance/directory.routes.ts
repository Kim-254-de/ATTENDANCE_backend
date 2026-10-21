import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as directoryController from './directory.controller.js';

/** Bare id/name lookups for the audit-target picker. Both routes gated to the QA role. */
export const directoryRouter: Router = Router();

directoryRouter.get('/departments', asyncHandler(requireAuth('QA')), asyncHandler(directoryController.departments));
directoryRouter.get('/faculties', asyncHandler(requireAuth('QA')), asyncHandler(directoryController.faculties));

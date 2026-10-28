import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as directoryController from './directory.controller.js';

/** A bare id/name lookup for the audit-target picker, gated to the QA role. */
export const directoryRouter: Router = Router();

directoryRouter.get('/departments', asyncHandler(requireAuth('QA')), asyncHandler(directoryController.departments));

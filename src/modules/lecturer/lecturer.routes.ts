import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as lecturerController from './lecturer.controller.js';

export const lecturerRouter: Router = Router();

/** Profile data for the signed-in, successfully registered lecturer. */
lecturerRouter.get('/profile', asyncHandler(requireAuth('LECTURER')), asyncHandler(lecturerController.profile));

/** Real teaching summary: units taught, total students, avg. attendance, sessions held. */
lecturerRouter.get('/overview', asyncHandler(requireAuth('LECTURER')), asyncHandler(lecturerController.overview));
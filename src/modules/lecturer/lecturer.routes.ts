import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import * as lecturerController from './lecturer.controller.js';

export const lecturerRouter: Router = Router();

/** Profile data for the signed-in, successfully registered lecturer. */
lecturerRouter.get('/profile', asyncHandler(requireAuth('LECTURER')), asyncHandler(lecturerController.profile));
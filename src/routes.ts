import { Router } from 'express';
import { authRouter } from './modules/auth/index.js';
import { lecturerRouter } from './modules/lecturer/lecturer.routes.js';

/**
 * API surface, versioned from the first commit so the mobile app can keep
 * working when v2 arrives.
 *
 * Routers are mounted here as each module is built:
 *   /lecturers   - profile management          (lecturer module)
 *   /students    - student registration        (student module)
 *   /units       - units and allocations       (unit module)
 *   /sessions    - attendance sessions and QR  (session module)
 *   /attendance  - check-in and records        (attendance module)
 *   /reports     - summaries and exports       (reporting module)
 */
export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/lecturers', lecturerRouter);

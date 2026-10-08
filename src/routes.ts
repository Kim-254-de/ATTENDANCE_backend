import { Router } from 'express';
import { authRouter, passkeyRouter } from './modules/auth/index.js';
import { sessionRouter } from './modules/session/index.js';
import { lecturerRouter } from './modules/lecturer/lecturer.routes.js';
import { unitRouter } from './modules/unit/index.js';
import { attendanceRouter } from './modules/attendance/index.js';
import { reportingRouter } from './modules/reporting/index.js';
import { studentRouter } from './modules/student/index.js';
import { integrationRouter } from './modules/integration/index.js';
import { verificationRouter } from './modules/verification/index.js';

/**
 * API surface, versioned from the first commit so the mobile app can keep
 * working when v2 arrives.
 *
 * Routers are mounted here as each module is built:
 *   /lecturers   - profile management          (lecturer module)
 *   /reports     - summaries and exports       (reporting module)
 */
export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/auth/passkeys', passkeyRouter);
apiRouter.use('/sessions', sessionRouter);
apiRouter.use('/lecturers', lecturerRouter);
apiRouter.use('/units', unitRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/reports', reportingRouter);
apiRouter.use('/students', studentRouter);
/** Face check-in: /students/me/face*, /units/:id/students/:id/face, /sessions/:id/face/*. */
apiRouter.use(verificationRouter);
/** Calls from SMARTTT (API key, not a user session). */
apiRouter.use('/integrations', integrationRouter);

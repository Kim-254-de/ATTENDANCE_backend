import { Router } from 'express';
import { authRouter, passkeyRouter } from './modules/auth/index.js';
import { sessionRouter } from './modules/session/index.js';
import { lecturerRouter } from './modules/lecturer/lecturer.routes.js';
import { unitRouter } from './modules/unit/index.js';
import { attendanceRouter } from './modules/attendance/index.js';
import { reportingRouter } from './modules/reporting/index.js';
import { studentRouter } from './modules/student/index.js';
import { departmentRouter } from './modules/department/index.js';
import { facultyRouter } from './modules/faculty/index.js';
import { integrationRouter } from './modules/integration/index.js';
import { verificationRouter } from './modules/verification/index.js';
import { adminRouter } from './modules/admin/index.js';
import { departmentEnrolmentRouter, departmentTerminalRouter, sessionTerminalRouter, terminalRouter } from './modules/terminal/index.js';

/**
 * API surface, versioned from the first commit so the mobile app can keep
 * working when v2 arrives.
 *
 * Routers are mounted here as each module is built:
 *   /lecturers   - profile management          (lecturer module)
 *   /reports     - summaries and exports       (reporting module)
 *   /departments - department-wide oversight   (department module)
 *   /faculties   - faculty-wide oversight      (faculty module)
 *   /admin       - faculties and invitations   (admin module)
 */
export const apiRouter: Router = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/auth/passkeys', passkeyRouter);
apiRouter.use('/sessions', sessionRouter);
apiRouter.use('/sessions', sessionTerminalRouter);
apiRouter.use('/lecturers', lecturerRouter);
apiRouter.use('/units', unitRouter);
apiRouter.use('/attendance', attendanceRouter);
apiRouter.use('/reports', reportingRouter);
apiRouter.use('/students', studentRouter);
apiRouter.use('/departments/terminals', departmentTerminalRouter);
apiRouter.use('/departments/enrolment', departmentEnrolmentRouter);
apiRouter.use('/departments', departmentRouter);
apiRouter.use('/terminals', terminalRouter);
apiRouter.use('/faculties', facultyRouter);
apiRouter.use('/admin', adminRouter);
/** Face check-in: /students/me/face*, /units/:id/students/:id/face, /sessions/:id/face/*. */
apiRouter.use(verificationRouter);
/** Calls from SMARTTT (API key, not a user session). */
apiRouter.use('/integrations', integrationRouter);

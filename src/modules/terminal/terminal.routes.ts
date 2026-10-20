import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { terminalLimiter, terminalPairLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import * as terminalController from './terminal.controller.js';
import { requireTerminal } from './terminal.middleware.js';
import {
  commandIdParamSchema,
  completeCommandSchema,
  coverageQuerySchema,
  failCommandSchema,
  fingerprintIdParamSchema,
  requestEnrolmentSchema,
  createTerminalSchema,
  heartbeatSchema,
  linkSchema,
  pairSchema,
  sessionIdParamSchema,
  terminalCheckInSchema,
  terminalIdParamSchema,
  updateTerminalSchema,
} from './terminal.schema.js';

/**
 * The device's own routes, mounted at /terminals. Everything but pairing
 * needs the device's key; see docs/terminals.md for the contract.
 */
export const terminalRouter: Router = Router();

/** Trade the one-time code from the department's screen for this device's key. */
terminalRouter.post('/pair', terminalPairLimiter, validate({ body: pairSchema }), asyncHandler(terminalController.pair));

const device = [asyncHandler(requireTerminal), terminalLimiter];

/** Report battery and network; learn which class, if any, the device is linked to. */
terminalRouter.post('/heartbeat', ...device, validate({ body: heartbeatSchema }), asyncHandler(terminalController.heartbeat));

/** Link to a class by the code scanned from the lecturer's screen. */
terminalRouter.post('/link', ...device, validate({ body: linkSchema }), asyncHandler(terminalController.link));

/** Let go of the class, e.g. when the lecturer hands the device back. */
terminalRouter.post('/unlink', ...device, asyncHandler(terminalController.unlink));

/** One barcode, NFC card or matched fingerprint, recorded for the linked class. */
terminalRouter.post('/check-in', ...device, validate({ body: terminalCheckInSchema }), asyncHandler(terminalController.checkIn));

/**
 * The department's devices, mounted at /departments/terminals. Every handler
 * resolves the officer's own department server-side, as the rest of
 * /departments does.
 */
export const departmentTerminalRouter: Router = Router();

const officer = asyncHandler(requireAuth('DEPARTMENT'));

departmentTerminalRouter.get('/', officer, asyncHandler(terminalController.list));
departmentTerminalRouter.post('/', officer, validate({ body: createTerminalSchema }), asyncHandler(terminalController.create));
departmentTerminalRouter.patch(
  '/:terminalId',
  officer,
  validate({ params: terminalIdParamSchema, body: updateTerminalSchema }),
  asyncHandler(terminalController.update),
);
departmentTerminalRouter.post(
  '/:terminalId/pairing',
  officer,
  validate({ params: terminalIdParamSchema }),
  asyncHandler(terminalController.reissuePairing),
);
departmentTerminalRouter.post('/:terminalId/lost', officer, validate({ params: terminalIdParamSchema }), asyncHandler(terminalController.markLost));
departmentTerminalRouter.post('/:terminalId/retire', officer, validate({ params: terminalIdParamSchema }), asyncHandler(terminalController.retire));

/** The lecturer's link code, mounted at /sessions alongside the session routes. */
export const sessionTerminalRouter: Router = Router();

sessionTerminalRouter.get(
  '/:sessionId/terminal-link',
  requireAuth('LECTURER'),
  validate({ params: sessionIdParamSchema }),
  asyncHandler(terminalController.linkCode),
);

/** Work the department queued for this device (fingerprint enrolments and removals). */
terminalRouter.get('/commands', ...device, asyncHandler(terminalController.commands));
terminalRouter.post(
  '/commands/:commandId/complete',
  ...device,
  validate({ params: commandIdParamSchema, body: completeCommandSchema }),
  asyncHandler(terminalController.completeCommand),
);
terminalRouter.post(
  '/commands/:commandId/fail',
  ...device,
  validate({ params: commandIdParamSchema, body: failCommandSchema }),
  asyncHandler(terminalController.failCommand),
);

/** Queue a fingerprint enrolment on one of the department's devices. */
departmentTerminalRouter.post(
  '/:terminalId/enrolments',
  officer,
  validate({ params: terminalIdParamSchema, body: requestEnrolmentSchema }),
  asyncHandler(terminalController.requestEnrolment),
);

/** The department's enrolment coverage and corrections, mounted at /departments/enrolment. */
export const departmentEnrolmentRouter: Router = Router();

departmentEnrolmentRouter.get('/students', officer, validate({ query: coverageQuerySchema }), asyncHandler(terminalController.coverage));
departmentEnrolmentRouter.post(
  '/commands/:commandId/cancel',
  officer,
  validate({ params: commandIdParamSchema }),
  asyncHandler(terminalController.cancelCommand),
);
departmentEnrolmentRouter.delete(
  '/fingerprints/:fingerprintId',
  officer,
  validate({ params: fingerprintIdParamSchema }),
  asyncHandler(terminalController.revokeFingerprint),
);

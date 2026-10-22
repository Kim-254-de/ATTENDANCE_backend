import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode } from '../../common/errors/index.js';
import type { Terminal } from './terminal.repository.js';
import * as terminalService from './terminal.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The paired device making this request, set by requireTerminal. */
      terminal?: Terminal;
    }
  }
}

/**
 * A paired terminal presents its own key as `X-Terminal-Key`. Looked up by
 * hash on every request, so marking a device lost or re-pairing it takes
 * effect on its very next call.
 */
export async function requireTerminal(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const key = req.get('X-Terminal-Key');
  const terminal = key && key.length <= 128 ? await terminalService.authenticate(key) : null;
  if (!terminal) {
    next(new AppError(401, ErrorCode.INVALID_API_KEY, 'This terminal is not paired, or has been switched off. Ask your department.'));
    return;
  }
  req.terminal = terminal;
  next();
}

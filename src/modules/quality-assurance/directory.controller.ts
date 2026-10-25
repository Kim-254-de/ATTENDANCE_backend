import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import * as directoryRepository from './directory.repository.js';

/**
 * A department officer resolves their department from their own profile
 * row; a QA officer has none, so this bare id/name lookup exists only so the
 * "create an audit" form can offer a name-based picker instead of asking the
 * officer to already know a raw id.
 */

/** GET /api/v1/quality-assurance/departments */
export async function departments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await directoryRepository.listDepartments());
}

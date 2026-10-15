import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import * as directoryRepository from './directory.repository.js';

/**
 * Every other oversight role resolves its own department/faculty from its
 * own profile row; a QA officer has none, so these two bare id/name lookups
 * exist only so the "create an audit" form can offer a name-based picker
 * instead of asking the officer to already know a raw id.
 */

/** GET /api/v1/quality-assurance/departments */
export async function departments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await directoryRepository.listDepartments());
}

/** GET /api/v1/quality-assurance/faculties */
export async function faculties(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await directoryRepository.listFaculties());
}

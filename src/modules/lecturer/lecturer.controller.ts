import type { Request, Response } from 'express';
import { AppError } from '../../common/errors/index.js';
import { sendSuccess } from '../../common/http/index.js';
import { findActiveLecturerProfile } from './lecturer.repository.js';
import { getOverview } from './lecturer.service.js';

/** GET /api/v1/lecturers/profile */
export async function profile(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) throw AppError.unauthenticated('Please sign in.');

  const lecturer = await findActiveLecturerProfile(userId);
  if (!lecturer) throw AppError.unauthenticated('Your account is no longer available.');

  sendSuccess(res, {
    ...lecturer,
    registeredAt: lecturer.registeredAt.toISOString(),
  });
}

/** GET /api/v1/lecturers/overview — the Dashboard stat cards and the Profile page's teaching summary. */
export async function overview(req: Request, res: Response): Promise<void> {
  const userId = req.auth?.userId;
  if (!userId) throw AppError.unauthenticated('Please sign in.');
  sendSuccess(res, await getOverview(userId));
}
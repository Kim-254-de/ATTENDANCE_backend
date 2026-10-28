import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import * as managementService from './management.service.js';
import type { DepartmentParam, YearParam } from './management.schema.js';

/** HTTP in and out only. */

/** GET /api/v1/management/departments */
export async function departments(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, await managementService.getUniversity());
}

/** GET /api/v1/management/departments/:departmentId */
export async function department(req: Request, res: Response): Promise<void> {
  const { departmentId } = req.params as unknown as DepartmentParam;
  sendSuccess(res, await managementService.getDepartment(departmentId));
}

/** GET /api/v1/management/departments/:departmentId/years/:year */
export async function year(req: Request, res: Response): Promise<void> {
  const { departmentId, year } = req.params as unknown as YearParam;
  sendSuccess(res, await managementService.getYear(departmentId, Number(year)));
}

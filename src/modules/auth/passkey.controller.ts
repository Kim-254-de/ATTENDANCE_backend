import type { Request, Response } from 'express';
import { sendSuccess } from '../../common/http/index.js';
import * as service from './passkey.service.js';
import type { PasskeyAuthenticationInput, PasskeyCredentialInput } from './passkey.schema.js';

function user(req: Request): { id: string; name: string } {
  const account = req.auth?.lecturer ?? req.auth?.student;
  if (!account) throw new Error('Authenticated account missing.');
  return { id: account.id, name: account.fullName };
}

export async function registrationOptions(req: Request, res: Response): Promise<void> {
  const account = user(req);
  sendSuccess(res, await service.registrationOptions(account.id, account.name));
}

export async function verifyRegistration(req: Request, res: Response): Promise<void> {
  await service.verifyRegistration(user(req).id, req.body as PasskeyCredentialInput);
  sendSuccess(res, { registered: true });
}

export async function authenticationOptions(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await service.authenticationOptions(user(req).id));
}

export async function verifyAuthentication(req: Request, res: Response): Promise<void> {
  await service.verifyAuthentication(user(req).id, req.body as PasskeyAuthenticationInput);
  sendSuccess(res, { verified: true });
}

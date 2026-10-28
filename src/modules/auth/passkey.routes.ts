import { Router } from 'express';
import { asyncHandler } from '../../common/utils/async-handler.js';
import { requireAuth } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './passkey.controller.js';
import { passkeyAuthenticationSchema, passkeyCredentialSchema } from './passkey.schema.js';

export const passkeyRouter: Router = Router();

passkeyRouter.use(requireAuth('LECTURER', 'STUDENT'));
passkeyRouter.post('/registration/options', asyncHandler(controller.registrationOptions));
passkeyRouter.post(
  '/registration/verify',
  validate({ body: passkeyCredentialSchema }),
  asyncHandler(controller.verifyRegistration),
);
passkeyRouter.post('/authentication/options', asyncHandler(controller.authenticationOptions));
passkeyRouter.post(
  '/authentication/verify',
  validate({ body: passkeyAuthenticationSchema }),
  asyncHandler(controller.verifyAuthentication),
);

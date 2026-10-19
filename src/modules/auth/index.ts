export { authRouter } from './auth.routes.js';
export { passkeyRouter } from './passkey.routes.js';
export * as authService from './auth.service.js';
export * as passwordService from './auth.password.service.js';
export { lecturerRegistrationSchema, passwordSchema } from './auth.schema.js';
export type { LecturerRegistrationInput } from './auth.schema.js';
export * as deletionService from './auth.deletion.js';
export * as invitationService from './auth.invitation.js';
export { provisionStudentFromSmarttt } from './auth.smarttt.js';

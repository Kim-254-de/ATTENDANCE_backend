import { z } from 'zod';

const credentialResponse = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    response: z.record(z.unknown()),
    type: z.literal('public-key'),
    clientExtensionResults: z.record(z.unknown()).optional(),
    authenticatorAttachment: z.string().optional(),
  })
  .strict();

export const passkeyCredentialSchema = credentialResponse;
export const passkeyAuthenticationSchema = z
  .object({ credential: credentialResponse })
  .strict();

export type PasskeyCredentialInput = z.infer<typeof passkeyCredentialSchema>;
export type PasskeyAuthenticationInput = z.infer<typeof passkeyAuthenticationSchema>;

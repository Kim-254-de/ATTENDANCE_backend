import { z } from 'zod';
import { barcodeCheckInSchema, cardCheckInSchema, fingerprintCheckInSchema } from '../attendance/index.js';

const uuid = z.string().uuid('Not a valid identifier.');

const capabilities = z
  .array(z.enum(['BARCODE', 'CARD', 'FINGERPRINT']))
  .min(1, 'Pick at least one thing the terminal can read.')
  .transform((list) => [...new Set(list)]);

/** A department adding a device. `code` is permanent: fingerprint enrolments are scoped by it. */
export const createTerminalSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, 'Name the terminal.')
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, ".", "_" or "-", e.g. TERM-01.')
      .transform((value) => value.toUpperCase()),
    label: z.string().trim().max(120).optional(),
    capabilities,
  })
  .strict();
export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;

export const updateTerminalSchema = z
  .object({
    label: z.string().trim().max(120).nullable().optional(),
    capabilities: capabilities.optional(),
  })
  .strict()
  .refine((v) => v.label !== undefined || v.capabilities !== undefined, 'Nothing to change.');
export type UpdateTerminalInput = z.infer<typeof updateTerminalSchema>;

export const terminalIdParamSchema = z.object({ terminalId: uuid });
export type TerminalIdParam = z.infer<typeof terminalIdParamSchema>;

export const sessionIdParamSchema = z.object({ sessionId: uuid });
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/** Typed or scanned; dashes and spaces are for people and are ignored. */
export const pairSchema = z
  .object({
    pairingCode: z
      .string()
      .trim()
      .max(32)
      .transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
      .pipe(z.string().regex(/^[0-9A-Z]{10}$/, 'Not a valid pairing code.')),
  })
  .strict();
export type PairInput = z.infer<typeof pairSchema>;

export const heartbeatSchema = z
  .object({
    batteryPercent: z.number().int().min(0).max(100).optional(),
    network: z.enum(['WIFI', 'CELLULAR']).optional(),
    appVersion: z.string().trim().max(32).optional(),
  })
  .strict();
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

export const linkSchema = z.object({ linkCode: z.string().trim().min(8).max(200) }).strict();
export type LinkInput = z.infer<typeof linkSchema>;

/**
 * One read at a linked terminal: exactly one of a barcode, an NFC UID or a
 * matched fingerprint slot. The session comes from the link, not the body.
 */
export const terminalCheckInSchema = z
  .object({
    barcode: barcodeCheckInSchema.shape.barcode.optional(),
    cardUid: cardCheckInSchema.shape.cardUid.optional(),
    fingerRef: fingerprintCheckInSchema.shape.fingerRef.optional(),
  })
  .strict()
  .refine(
    (v) => [v.barcode, v.cardUid, v.fingerRef].filter((x) => x !== undefined).length === 1,
    'Send exactly one of barcode, cardUid or fingerRef.',
  );
export type TerminalCheckInInput = z.infer<typeof terminalCheckInSchema>;

export const requestEnrolmentSchema = z
  .object({
    registrationNumber: z.string().trim().min(3).max(64).transform((v) => v.toUpperCase()),
    label: z.string().trim().max(64).optional(),
  })
  .strict();
export type RequestEnrolmentInput = z.infer<typeof requestEnrolmentSchema>;

export const coverageQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type CoverageQuery = z.infer<typeof coverageQuerySchema>;

export const commandIdParamSchema = z.object({ commandId: uuid });
export type CommandIdParam = z.infer<typeof commandIdParamSchema>;
export const fingerprintIdParamSchema = z.object({ fingerprintId: uuid });
export type FingerprintIdParam = z.infer<typeof fingerprintIdParamSchema>;

export const completeCommandSchema = z.object({ fingerRef: fingerprintCheckInSchema.shape.fingerRef.optional() }).strict();
export type CompleteCommandInput = z.infer<typeof completeCommandSchema>;
export const failCommandSchema = z.object({ reason: z.string().trim().min(1).max(200) }).strict();
export type FailCommandInput = z.infer<typeof failCommandSchema>;

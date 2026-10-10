import { z } from 'zod';
import { studentLocationSchema } from '../session/index.js';

const uuid = z.string().uuid('Not a valid identifier.');

/**
 * A scanned code, submitted by a student. Capped well above a real token:
 * anything longer is not a mis-scan but someone probing the endpoint.
 */
export const checkInSchema = z
  .object({
    payload: z.string().trim().min(8, 'Not a valid attendance code.').max(512),
    /** The phone's GPS reading. Required when the session's geofence is on. */
    location: studentLocationSchema.optional(),
  })
  .strict();
export type CheckInInput = z.infer<typeof checkInSchema>;

export const sessionIdParamSchema = z.object({ sessionId: uuid }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/**
 * A card presented at a terminal.
 *
 * The terminal names the class it is recording for — it is told that by the
 * lecturer's interface when the class is activated, rather than guessing.
 *
 * `cardUid` is whatever the reader got off the card. Readers differ on case
 * and on byte separators, so it is normalised before hashing
 * (common/utils/card-uid.ts); the bounds here just reject anything that is not
 * plausibly a UID. Hex with optional separators only: a reader sending
 * something else is misconfigured, and that is worth a 400 rather than a
 * silent miss.
 */
export const cardCheckInSchema = z
  .object({
    sessionId: uuid,
    cardUid: z
      .string()
      .trim()
      .min(4, 'Not a valid card.')
      .max(64, 'Not a valid card.')
      .regex(/^[0-9a-fA-F][0-9a-fA-F\s:-]*$/, 'Not a valid card.'),
  })
  .strict();
export type CardCheckInInput = z.infer<typeof cardCheckInSchema>;

/**
 * A finger matched at a terminal.
 *
 * `fingerRef` is the reader's own enrolment reference for the template it
 * matched — a slot number on the modules this is built for. It is opaque here
 * and only meaningful alongside `terminalId`, because each reader numbers its
 * own slots (`021_fingerprint_verification.sql`).
 *
 * No fingerprint, template or image is accepted: the reader does the matching.
 * A body carrying biometric data would be a body this service has to be
 * trusted with, and the whole design avoids that.
 */
export const fingerprintCheckInSchema = z
  .object({
    sessionId: uuid,
    /** Which reader. Configured on the device; identifies whose slot numbering this is. */
    terminalId: z
      .string()
      .trim()
      .min(1, 'Name the terminal.')
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Not a valid terminal id.'),
    fingerRef: z
      .string()
      .trim()
      .min(1, 'Not a valid enrolment reference.')
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/, 'Not a valid enrolment reference.'),
  })
  .strict();
export type FingerprintCheckInInput = z.infer<typeof fingerprintCheckInSchema>;

import { z } from 'zod';

/**
 * Request contracts for face check-in. Photos travel as base64 data URLs in
 * JSON, like avatars (db/migrations/008_user_avatar.sql), so there is no
 * upload infrastructure. The portal re-encodes a camera frame as a JPEG of a
 * few hundred KB before sending.
 */

const uuid = z.string().uuid('Not a valid identifier.');

/** ~300 KB of image once decoded. app.ts gives these routes a body limit to match. */
export const MAX_IMAGE_CHARS = 400_000;

export const faceImageSchema = z
  .string()
  .trim()
  .max(MAX_IMAGE_CHARS, 'The photo is too large. Retake it.')
  .regex(/^(data:image\/(jpeg|png|webp);base64,)?[A-Za-z0-9+/]+={0,2}$/, 'Send the photo as a JPEG, PNG or WebP data URL.')
  .refine((value) => value.length >= 100, 'Send the photo as a JPEG, PNG or WebP data URL.');

/** How many photos make an enrollment: enough to cover a slight turn of the head. */
export const ENROLLMENT_PHOTOS = 3;

export const enrollFaceSchema = z
  .object({
    images: z.array(faceImageSchema).length(ENROLLMENT_PHOTOS, `Take ${ENROLLMENT_PHOTOS} photos.`),
  })
  .strict();
export type EnrollFaceInput = z.infer<typeof enrollFaceSchema>;

export const identifyFaceSchema = z.object({ image: faceImageSchema }).strict();
export type IdentifyFaceInput = z.infer<typeof identifyFaceSchema>;

export const confirmFaceSchema = z
  .object({ matchToken: z.string().trim().min(10, 'Not a valid match.').max(200, 'Not a valid match.') })
  .strict();
export type ConfirmFaceInput = z.infer<typeof confirmFaceSchema>;

export const unitStudentParamSchema = z.object({ unitId: uuid, studentUserId: uuid }).strict();
export type UnitStudentParam = z.infer<typeof unitStudentParamSchema>;

export const sessionIdParamSchema = z.object({ sessionId: uuid }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

import { z } from 'zod';

/**
 * Request contracts for the session module. Values are trimmed and normalised
 * here so every layer below can assume clean input.
 */

const uuid = z.string().uuid('Not a valid identifier.');

export const sessionIdParamSchema = z.object({ sessionId: uuid }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/**
 * Opening a session. The window is what stops a code minted on Monday being
 * scanned on Friday, so both ends are required rather than open-ended.
 */
export const createSessionSchema = z
  .object({
    unitId: uuid,
    /** Free-text label shown to students, e.g. "Week 3 - Lecture". */
    title: z.string().trim().min(1).max(160).optional(),
    opensAt: z.coerce.date().optional(),
    /**
     * Optional: a unit with an issued timetable slot has its closesAt derived
     * server-side from that slot's end time, ignoring whatever the client
     * sends — see session.service.ts createSession. Only used as a fallback
     * for a unit with no schedule.
     */
    closesAt: z.coerce.date().optional(),
    /** Per-session override; falls back to QR_ROTATION_SECONDS. */
    rotationSeconds: z.coerce.number().int().min(15).max(600).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.closesAt) return;
    const opensAt = value.opensAt ?? new Date();
    if (value.closesAt <= opensAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['closesAt'],
        message: 'The session must close after it opens.',
      });
    }
    // A 12-hour cap catches the common typo of a wrong date, which would
    // otherwise leave a live QR code valid for weeks.
    const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
    if (value.closesAt.getTime() - opensAt.getTime() > TWELVE_HOURS_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['closesAt'],
        message: 'A session cannot run for more than 12 hours.',
      });
    }
  });
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

/** Image format for the rendered code. */
export const qrQuerySchema = z
  .object({
    format: z.enum(['png', 'svg']).default('png'),
    size: z.coerce.number().int().min(128).max(2048).optional(),
  })
  .strict();
export type QrQuery = z.infer<typeof qrQuerySchema>;

/**
 * A scanned code, submitted by a student.
 *
 * The payload is capped well above a real token: anything longer is not a
 * mis-scan but someone probing the endpoint.
 */
export const verifyScanSchema = z
  .object({
    payload: z.string().trim().min(8, 'Not a valid attendance code.').max(512),
  })
  .strict();
export type VerifyScanInput = z.infer<typeof verifyScanSchema>;

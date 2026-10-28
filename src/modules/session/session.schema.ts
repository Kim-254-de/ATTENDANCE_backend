import { z } from 'zod';

/**
 * Request contracts for the session module. Values are trimmed and normalised
 * here so every layer below can assume clean input.
 */

const uuid = z.string().uuid('Not a valid identifier.');

export const sessionIdParamSchema = z.object({ sessionId: uuid }).strict();
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;

/**
 * A device's GPS reading, as the browser's Geolocation API reports it.
 * `accuracy` is the 68% confidence radius in metres. Whether a reading is
 * precise *enough* is policy, decided in session.geofence.ts, not here.
 */
export const locationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracy: z.number().finite().min(0).max(100_000),
  })
  .strict();
export type LocationInput = z.infer<typeof locationSchema>;

/**
 * A scanning student's reading. Unlike the lecturer's, it carries when the fix
 * was taken, so a cached position from the corridor can be refused.
 *
 * `capturedAt` accepts what devices actually give: the browser's and
 * Android's `timestamp` (epoch milliseconds) or an ISO 8601 string.
 * `isMocked` is Android's `Location.isMock()`; other platforms omit it.
 */
export const studentLocationSchema = locationSchema
  .extend({
    capturedAt: z
      .union([z.number().int().positive(), z.string().datetime({ offset: true })])
      .transform((value) => new Date(value)),
    isMocked: z.boolean().optional(),
  })
  .strict();
export type StudentLocationInput = z.infer<typeof studentLocationSchema>;

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
    /**
     * The lecturer's device reading. Only used when the room has not been
     * surveyed; a surveyed room's point always wins.
     */
    location: locationSchema.optional(),
    /** Check students' location on scan. Only the lecturer can switch it off. */
    geofence: z.enum(['ON', 'OFF']).default('ON'),
    /**
     * The lecturer's four tick boxes: how students may prove they are present.
     * Any combination, at least one, each named once. Defaults to QR and face,
     * each the other's fallback (docs/face-recognition.md).
     *
     * All four have a check-in path now, so any single one is a usable class.
     * Fingerprint and card both need their terminal present in the room — a
     * class enabling only those, with no terminal, is a class nobody can check
     * in to, but that is an operational matter rather than something the schema
     * can tell.
     */
    verificationMethods: z
      .array(z.enum(['QR', 'CARD', 'FINGERPRINT', 'FACE']))
      .min(1, 'Choose at least one way for students to check in.')
      .max(4)
      .default(['QR', 'FACE'])
      .refine((methods) => new Set(methods).size === methods.length, {
        message: 'Each check-in method may only be chosen once.',
      }),
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

/**
 * Switching a running session's fence off, back on, or re-centring it on the
 * lecturer's current position (ON with a location).
 */
export const updateGeofenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('OFF') }).strict(),
  z.object({ mode: z.literal('ON'), location: locationSchema.optional() }).strict(),
]);
export type UpdateGeofenceInput = z.infer<typeof updateGeofenceSchema>;

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
    /** Required when the session's geofence is on; checked in session.geofence.ts. */
    location: studentLocationSchema.optional(),
  })
  .strict();
export type VerifyScanInput = z.infer<typeof verifyScanSchema>;

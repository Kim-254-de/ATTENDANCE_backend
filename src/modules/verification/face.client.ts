import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * HTTP client for face-service (face-service/README.md), which turns a photo
 * into a face template. The only thing that calls it.
 *
 * Like the SMARTTT client, it never throws: an unreadable image is a returned
 * status, and a transport fault, a bad key or an unexpected payload is
 * UNAVAILABLE.
 *
 * The one thing it retries is the service waking up. On Render's free plan an
 * idle service sleeps, and for the ~20-30 s it takes to start, Render's edge
 * answers 502/503/429 or the connection fails. Those are retried for up to
 * FACE_SERVICE_WAKE_WAIT_MS; anything else (a bad key, an unreadable photo) is
 * answered at once. warmUp() lets the portal start the wake-up before the
 * photos are taken, so the lecturer rarely waits at all.
 */

export interface EmbeddedFace {
  box: { x: number; y: number; width: number; height: number };
  detectionScore: number;
  sharpness: number;
  embedding: number[];
  /** A small JPEG data URL of the face, when the request asked for one. */
  crop: string | null;
}

export type EmbedResult =
  | { status: 'OK'; model: string; faceCount: number; face: EmbeddedFace | null }
  /** face-service could not read the image at all. */
  | { status: 'INVALID_IMAGE'; message: string }
  | { status: 'DISABLED' }
  | { status: 'UNAVAILABLE' };

const embedResponseSchema = z.object({
  model: z.string().min(1),
  faceCount: z.number().int().min(0),
  face: z
    .object({
      box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      detectionScore: z.number(),
      sharpness: z.number(),
      embedding: z.array(z.number()).min(16).max(4096),
      // Absent from a face-service that predates crops: treated as none.
      crop: z.string().startsWith('data:image/jpeg;base64,').max(60_000).nullish().transform((v) => v ?? null),
    })
    .nullable(),
});

const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const faceServiceEnabled = (): boolean => !!env.FACE_SERVICE_URL;

/** What Render's edge answers while a sleeping service starts. face-service itself never sends these. */
const WAKING_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAY_MS = 1_000;

const baseUrl = (): string => env.FACE_SERVICE_URL!.replace(/\/+$/, '');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried while the service looks like it is waking up, until
 * FACE_SERVICE_WAKE_WAIT_MS has passed. Returns the last response, or null
 * when no request got through at all.
 */
async function fetchWhileWaking(path: string, init: RequestInit, label: string): Promise<Response | null> {
  const deadline = Date.now() + env.FACE_SERVICE_WAKE_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    try {
      response = await fetch(`${baseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(env.FACE_SERVICE_TIMEOUT_MS) });
      if (!WAKING_STATUSES.has(response.status)) return response;
    } catch (error) {
      if (Date.now() + RETRY_DELAY_MS > deadline) {
        logger.error({ err: error, attempt }, `face-service: ${label} failed`);
        return null;
      }
    }
    if (Date.now() + RETRY_DELAY_MS > deadline) return response;
    logger.warn({ status: response?.status ?? null, attempt }, `face-service: ${label} not ready, retrying (waking up?)`);
    await sleep(RETRY_DELAY_MS);
  }
}

let warming: Promise<void> | null = null;
let warmUntil = 0;
/** After a successful health check, the service is taken to be awake for this long (Render sleeps it after 15 idle minutes). */
const AWAKE_FOR_MS = 5 * 60_000;

/**
 * Wakes face-service if it is asleep, in the background. Called when a
 * lecturer opens the face terminal or the register-face dialog, so the
 * service is up by the time the first photo is sent. Never throws, and
 * concurrent or recent calls share one health check.
 */
export function warmUp(): void {
  if (!env.FACE_SERVICE_URL || warming || Date.now() < warmUntil) return;
  warming = fetchWhileWaking('/health', { headers: { 'User-Agent': 'smart-attendance-backend' } }, 'warm-up')
    .then((response) => {
      if (response?.ok) warmUntil = Date.now() + AWAKE_FOR_MS;
    })
    .catch(() => undefined)
    .finally(() => {
      warming = null;
    });
}

/** `crop` also asks for a small JPEG of the face (enrollment keeps one to show on the terminal). */
export async function embed(image: string, options: { crop?: boolean } = {}): Promise<EmbedResult> {
  if (!env.FACE_SERVICE_URL) return { status: 'DISABLED' };

  const response = await fetchWhileWaking(
    '/embed',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'smart-attendance-backend',
        'X-Face-Service-Key': env.FACE_SERVICE_KEY ?? '',
      },
      body: JSON.stringify(options.crop ? { image, crop: true } : { image }),
    },
    'embed',
  );
  if (!response) return { status: 'UNAVAILABLE' };
  // It answered, so it is awake: no warm-up needed for a while.
  warmUntil = Date.now() + AWAKE_FOR_MS;

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = embedResponseSchema.safeParse(body);
    if (parsed.success) return { status: 'OK', ...parsed.data };
    logger.error({ issues: parsed.error.issues }, 'face-service: unexpected response');
    return { status: 'UNAVAILABLE' };
  }

  const error = errorResponseSchema.safeParse(body);
  const code = error.success ? error.data.error.code : null;
  // A face-service from before crops refuses the unknown field: ask again
  // without it, and the enrollment just has no reference photo.
  if (options.crop && code === 'VALIDATION_ERROR') {
    logger.warn('face-service: does not support crops yet (deploy face-service); enrolling without a reference photo');
    return embed(image);
  }
  if (code === 'INVALID_IMAGE' || code === 'IMAGE_TOO_LARGE') {
    return { status: 'INVALID_IMAGE', message: error.success ? error.data.error.message : 'The photo could not be read.' };
  }
  // A 401 here is a misconfigured key, not the lecturer's fault: logged loudly, shown as an outage.
  logger.error({ status: response.status, code }, 'face-service: request refused');
  return { status: 'UNAVAILABLE' };
}

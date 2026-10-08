import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * HTTP client for face-service (face-service/README.md), which turns a photo
 * into a face template. The only thing that calls it.
 *
 * Like the SMARTTT client, it never throws: an unreadable image is a returned
 * status, and a transport fault, a bad key or an unexpected payload is
 * UNAVAILABLE. No retries: a lecturer is holding the phone up to a student.
 */

export interface EmbeddedFace {
  box: { x: number; y: number; width: number; height: number };
  detectionScore: number;
  sharpness: number;
  embedding: number[];
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
    })
    .nullable(),
});

const errorResponseSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const faceServiceEnabled = (): boolean => !!env.FACE_SERVICE_URL;

export async function embed(image: string): Promise<EmbedResult> {
  if (!env.FACE_SERVICE_URL) return { status: 'DISABLED' };
  const url = `${env.FACE_SERVICE_URL.replace(/\/+$/, '')}/embed`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'smart-attendance-backend',
        'X-Face-Service-Key': env.FACE_SERVICE_KEY ?? '',
      },
      body: JSON.stringify({ image }),
      signal: AbortSignal.timeout(env.FACE_SERVICE_TIMEOUT_MS),
    });
  } catch (error) {
    logger.error({ err: error }, 'face-service: request failed');
    return { status: 'UNAVAILABLE' };
  }

  const body: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = embedResponseSchema.safeParse(body);
    if (parsed.success) return { status: 'OK', ...parsed.data };
    logger.error({ issues: parsed.error.issues }, 'face-service: unexpected response');
    return { status: 'UNAVAILABLE' };
  }

  const error = errorResponseSchema.safeParse(body);
  const code = error.success ? error.data.error.code : null;
  if (code === 'INVALID_IMAGE' || code === 'IMAGE_TOO_LARGE') {
    return { status: 'INVALID_IMAGE', message: error.success ? error.data.error.message : 'The photo could not be read.' };
  }
  // A 401 here is a misconfigured key, not the lecturer's fault: logged loudly, shown as an outage.
  logger.error({ status: response.status, code }, 'face-service: request refused');
  return { status: 'UNAVAILABLE' };
}

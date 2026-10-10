import type { Response } from 'express';

/**
 * A single response envelope for the whole API, so the mobile client has one
 * shape to parse rather than one per endpoint.
 */

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): Response {
  const body: SuccessEnvelope<T> = meta ? { success: true, data, meta } : { success: true, data };
  return res.status(statusCode).json(body);
}

export function sendCreated<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  return sendSuccess(res, data, 201, meta);
}

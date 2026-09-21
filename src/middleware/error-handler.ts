import type { NextFunction, Request, Response } from 'express';
import { PgErrorCode, isPostgresError } from '../db/database.js';
import { ZodError } from 'zod';
import { AppError, ErrorCode, type ErrorCodeValue } from '../common/errors/index.js';
import type { ErrorEnvelope } from '../common/http/index.js';
import { logger } from '../config/logger.js';
import { isProduction } from '../config/env.js';

/**
 * The single place an error becomes an HTTP response.
 *
 * Rule: only an AppError may describe itself to the client. Everything else is
 * logged in full and answered with a generic 500, so stack traces, SQL and
 * driver internals never reach a mobile app.
 */

interface NormalisedError {
  statusCode: number;
  code: ErrorCodeValue;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
  /** True when the error was deliberate; false marks a genuine fault. */
  expected: boolean;
}

function normalise(error: unknown): NormalisedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      retryAfterSeconds: error.retryAfterSeconds,
      expected: true,
    };
  }

  // A Zod error reaching here means a schema was used outside validate().
  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'The submitted details are not valid.',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
      expected: true,
    };
  }

  if (isPostgresError(error)) {
    switch (error.code) {
      case PgErrorCode.UNIQUE_VIOLATION:
        // That a duplicate exists is safe to say; the constraint name, the
        // column and the conflicting value are not.
        return {
          statusCode: 409,
          code: ErrorCode.CONFLICT,
          message: 'A record with these details already exists.',
          expected: true,
        };
      case PgErrorCode.FOREIGN_KEY_VIOLATION:
        return {
          statusCode: 409,
          code: ErrorCode.CONFLICT,
          message: 'This action references a record that does not exist.',
          expected: true,
        };
      case PgErrorCode.QUERY_CANCELED:
        // statement_timeout fired. A genuine fault, but not a code defect.
        return {
          statusCode: 503,
          code: ErrorCode.INTERNAL_ERROR,
          message: 'The request took too long to process. Please try again.',
          expected: false,
        };
      case PgErrorCode.UNDEFINED_TABLE:
      case PgErrorCode.UNDEFINED_COLUMN:
        // The database this service was pointed at does not match what the
        // queries expect. Surfaced as a 500 but logged as a fault, because it
        // is a deployment error rather than anything the caller did.
        return {
          statusCode: 500,
          code: ErrorCode.INTERNAL_ERROR,
          message: 'An unexpected error occurred. Please try again.',
          expected: false,
        };
      default:
        break;
    }
  }

  if (error instanceof SyntaxError && 'body' in error) {
    return {
      statusCode: 400,
      code: ErrorCode.VALIDATION_FAILED,
      message: 'Request body is not valid JSON.',
      expected: true,
    };
  }

  return {
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: 'An unexpected error occurred. Please try again.',
    expected: false,
  };
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Delegate to Express if the response has already started streaming.
  if (res.headersSent) {
    next(error);
    return;
  }

  const normalised = normalise(error);

  const logPayload = {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode: normalised.statusCode,
    code: normalised.code,
    err: error,
  };

  if (normalised.expected && normalised.statusCode < 500) {
    logger.warn(logPayload, 'request rejected');
  } else {
    logger.error(logPayload, 'request failed');
  }

  if (normalised.retryAfterSeconds !== undefined) {
    res.setHeader('Retry-After', String(normalised.retryAfterSeconds));
  }

  const body: ErrorEnvelope = {
    success: false,
    error: {
      code: normalised.code,
      message: normalised.message,
      ...(normalised.details !== undefined ? { details: normalised.details } : {}),
    },
    requestId: req.requestId,
  };

  // Outside production, attach the real message to speed up debugging.
  if (!isProduction && !normalised.expected && error instanceof Error) {
    body.error.details = { debug: error.message, stack: error.stack?.split('\n').slice(0, 5) };
  }

  res.status(normalised.statusCode).json(body);
}

/** Terminal 404 for unmatched routes. Registered after all route mounts. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorEnvelope = {
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `Cannot ${req.method} ${req.originalUrl}`,
    },
    requestId: req.requestId,
  };
  res.status(404).json(body);
}

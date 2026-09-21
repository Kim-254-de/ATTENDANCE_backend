/**
 * Every error the API deliberately returns is an AppError. Anything else that
 * reaches the error handler is treated as an unexpected fault and reported as
 * a generic 500, so internal details never leak to a client.
 */

/** Stable, machine-readable codes the mobile client can branch on. */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Registration / ERP
  ERP_STAFF_NOT_FOUND: 'ERP_STAFF_NOT_FOUND',
  ERP_STAFF_INACTIVE: 'ERP_STAFF_INACTIVE',
  ERP_IDENTITY_MISMATCH: 'ERP_IDENTITY_MISMATCH',
  ERP_UNAVAILABLE: 'ERP_UNAVAILABLE',
  ACCOUNT_ALREADY_EXISTS: 'ACCOUNT_ALREADY_EXISTS',
  ACCOUNT_NOT_ACTIVE: 'ACCOUNT_NOT_ACTIVE',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  /** Field-level detail, safe to show the user. */
  details?: unknown;
  /** Underlying error, kept for logs only — never serialised to a response. */
  cause?: unknown;
  /** Seconds the client should wait before retrying. */
  retryAfterSeconds?: number;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** Distinguishes deliberate responses from genuine faults in the handler. */
  readonly isOperational = true;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.retryAfterSeconds = options.retryAfterSeconds;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message: string, options?: AppErrorOptions): AppError {
    return new AppError(400, ErrorCode.VALIDATION_FAILED, message, options);
  }

  static unauthenticated(message = 'Authentication is required.', options?: AppErrorOptions): AppError {
    return new AppError(401, ErrorCode.UNAUTHENTICATED, message, options);
  }

  static forbidden(message = 'You do not have access to this resource.', options?: AppErrorOptions): AppError {
    return new AppError(403, ErrorCode.FORBIDDEN, message, options);
  }

  static notFound(message = 'Resource not found.', options?: AppErrorOptions): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message, options);
  }

  static conflict(message: string, code: ErrorCodeValue = ErrorCode.CONFLICT, options?: AppErrorOptions): AppError {
    return new AppError(409, code, message, options);
  }

  static internal(message = 'An unexpected error occurred.', options?: AppErrorOptions): AppError {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message, options);
  }
}

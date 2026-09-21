import type { NextFunction, Request, Response } from 'express';
import type { ZodError} from 'zod';
import { type ZodTypeAny, type z } from 'zod';
import { AppError, ErrorCode } from '../common/errors/index.js';

/**
 * Parses and REPLACES the request part with the schema's output, so handlers
 * downstream receive trimmed, normalised, correctly typed values rather than
 * raw strings. Unknown keys are stripped by Zod objects by default, which
 * blocks mass-assignment through the request body.
 */

type RequestPart = 'body' | 'query' | 'params';

interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatIssues(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parts: RequestPart[] = ['params', 'query', 'body'];

    for (const part of parts) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        next(
          new AppError(400, ErrorCode.VALIDATION_FAILED, 'The submitted details are not valid.', {
            details: formatIssues(result.error),
          }),
        );
        return;
      }

      // Express 5 exposes req.query via a getter, so assign through
      // defineProperty rather than plain assignment.
      Object.defineProperty(req, part, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    next();
  };
}

/** Infers the validated body type for a handler. */
export type ValidatedBody<S extends ZodTypeAny> = z.infer<S>;

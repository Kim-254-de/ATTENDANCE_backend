import { z } from 'zod';

/** Request contracts for student course evaluations. */

export const roundIdParamSchema = z.object({ id: z.string().uuid('Not a valid identifier.') }).strict();
export type RoundIdParam = z.infer<typeof roundIdParamSchema>;

const questionSchema = z
  .object({
    prompt: z.string().trim().min(3, 'Question is too short.').max(300),
    kind: z.enum(['RATING', 'TEXT']),
    required: z.boolean().default(true),
  })
  .strict();

const questionsSchema = z.array(questionSchema).min(1, 'Add at least one question.').max(30);

export const createRoundSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    instructions: z.string().trim().max(5000).optional(),
    opensAt: z.coerce.date(),
    closesAt: z.coerce.date(),
    minResponses: z.coerce.number().int().min(1).max(50).optional(),
    questions: questionsSchema,
  })
  .strict()
  .refine((v) => v.closesAt > v.opensAt, { message: 'The round must close after it opens.', path: ['closesAt'] });
export type CreateRoundInput = z.infer<typeof createRoundSchema>;

export const updateRoundSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    instructions: z.string().trim().max(5000).nullable().optional(),
    opensAt: z.coerce.date().optional(),
    closesAt: z.coerce.date().optional(),
    minResponses: z.coerce.number().int().min(1).max(50).optional(),
    questions: questionsSchema.optional(),
  })
  .strict();
export type UpdateRoundInput = z.infer<typeof updateRoundSchema>;

/** Results narrowing for QA; department officers get their own scope instead. */
export const resultsQuerySchema = z
  .object({ departmentId: z.string().uuid('Not a valid identifier.').optional() })
  .strict();
export type ResultsQuery = z.infer<typeof resultsQuerySchema>;

/** POST /students/me/evaluations/:roundId/units/:unitId */
export const submitParamSchema = z
  .object({
    roundId: z.string().uuid('Not a valid identifier.'),
    unitId: z.string().uuid('Not a valid identifier.'),
  })
  .strict();
export type SubmitParam = z.infer<typeof submitParamSchema>;

export const submitEvaluationSchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: z.string().uuid('Not a valid identifier.'),
            rating: z.coerce.number().int().min(1).max(5).optional(),
            text: z.string().trim().max(2000).optional(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type SubmitEvaluationInput = z.infer<typeof submitEvaluationSchema>;

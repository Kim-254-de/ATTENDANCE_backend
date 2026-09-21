import { z } from 'zod';

/**
 * Request contracts for the auth module. These are the API's outer boundary:
 * values are trimmed and normalised here so that every layer below can assume
 * clean input.
 */

/**
 * Institutional staff numbers vary by institution. This accepts letters,
 * digits, hyphens and slashes — the common formats — and normalises case so
 * "ksu/lec/014" and "KSU/LEC/014" cannot become two accounts.
 */
const staffNumberSchema = z
  .string()
  .trim()
  .min(3, 'Staff number is too short.')
  .max(64, 'Staff number is too long.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9/\-_.]*$/,
    'Staff number may only contain letters, digits and the characters / - _ .',
  )
  .transform((value) => value.toUpperCase());

const emailSchema = z
  .string()
  .trim()
  .min(5, 'Email address is too short.')
  .max(255, 'Email address is too long.')
  .email('Enter a valid email address.')
  .transform((value) => value.toLowerCase());

const fullNameSchema = z
  .string()
  .trim()
  .min(3, 'Full name must be at least 3 characters.')
  .max(160, 'Full name is too long.')
  .regex(
    /^[\p{L}][\p{L}\p{M}'\-.\s]*$/u,
    'Full name may only contain letters, spaces, apostrophes and hyphens.',
  )
  // Collapse runs of whitespace so "John   Doe" stores as "John Doe".
  .transform((value) => value.replace(/\s+/g, ' '));

/**
 * Password policy. Length does more for strength than character-class rules,
 * so the minimum is 12 with a light composition requirement rather than a
 * short password forced through four character classes.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  // Argon2 has no practical input limit, but capping the length stops a
  // megabyte-sized password being used to burn CPU.
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[a-z]/, 'Password must include a lowercase letter.')
  .regex(/[A-Z]/, 'Password must include an uppercase letter.')
  .regex(/[0-9]/, 'Password must include a digit.');

export const lecturerRegistrationSchema = z
  .object({
    fullName: fullNameSchema,
    email: emailSchema,
    staffNumber: staffNumberSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match.',
      });
    }
    // A password containing the staff number or email local-part is trivially
    // guessable by anyone holding the registration form.
    const lowered = value.password.toLowerCase();
    const emailLocalPart = value.email.split('@')[0] ?? '';
    if (
      lowered.includes(value.staffNumber.toLowerCase()) ||
      (emailLocalPart.length >= 4 && lowered.includes(emailLocalPart.toLowerCase()))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must not contain your staff number or email address.',
      });
    }
  });

export type LecturerRegistrationInput = z.infer<typeof lecturerRegistrationSchema>;

export const emailVerificationSchema = z
  .object({
    token: z.string().trim().min(16, 'Verification token is not valid.').max(256),
  })
  .strict();

export type EmailVerificationInput = z.infer<typeof emailVerificationSchema>;

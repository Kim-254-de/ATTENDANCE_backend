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

/**
 * Editing a profile. Deliberately excludes full name and email: those are the
 * exact fields the ERP identity check verified at registration, and letting
 * them change here with no re-verification would undermine that guarantee.
 */
export const updateProfileSchema = z
  .object({
    title: z.string().trim().max(32).optional(),
    department: z.string().trim().min(2, 'Enter your department.').max(160),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/**
 * Sign-in accepts a staff number OR an email in one field (README section 3.1). No password
 * policy is applied here: policy is for choosing a password, and enforcing it at sign-in would
 * only reveal the rules to someone guessing.
 */
export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1, 'Enter your staff number or email.').max(255),
    password: z.string().min(1, 'Enter your password.').max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * Requesting a reset link. Only the address is needed — deliberately not the
 * staff number, so the form cannot be used to test whether a staff number is
 * registered.
 */
export const forgotPasswordSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(5)
      .max(255)
      .email('Enter a valid email address.')
      .transform((value) => value.toLowerCase()),
  })
  .strict();

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** Completing a reset with the token from the emailed link. */
export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(16, 'This reset link is not valid.').max(256),
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
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Changing a password from inside the app (as opposed to the emailed-token
 * reset flow above). Proof of the CURRENT password stands in for the emailed
 * token's proof of inbox access.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(128),
    newPassword: passwordSchema,
    confirmNewPassword: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmNewPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmNewPassword'],
        message: 'Passwords do not match.',
      });
    }
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * A profile photo, sent as a data URL. The body-size limit on this route (see
 * app.ts) is the primary guard against abuse; this length cap is a second,
 * independent one at the validation layer.
 */
export const avatarSchema = z
  .object({
    avatarDataUrl: z
      .string()
      .regex(/^data:image\/(png|jpe?g|webp);base64,/, 'Not a supported image format.')
      .max(300_000, 'That image is too large.'),
  })
  .strict();

export type AvatarInput = z.infer<typeof avatarSchema>;

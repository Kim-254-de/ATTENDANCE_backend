import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once, at boot. A malformed or missing variable
 * stops the process immediately rather than surfacing as a confusing runtime
 * failure halfway through a request.
 */

const durationString = z.string().regex(/^\d+[smhd]$/, 'expected a duration like 15m, 24h or 7d');

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

const envSchema = z
  .object({
    // --- Runtime ---
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGINS: csv.default('http://localhost:5173'),
    /** Base URL of the client app, used to build links inside emails. */
    APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),

    // --- Database ---
    // This service connects to an existing database; it does not create one.
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    DATABASE_SSL: booleanish.default('false'),
    DATABASE_SSL_ALLOW_SELF_SIGNED: booleanish.default('false'),

    // --- Auth ---
    JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    JWT_ACCESS_TTL: durationString.default('15m'),
    JWT_REFRESH_TTL: durationString.default('7d'),
    JWT_ISSUER: z.string().min(1).default('smart-attendance-system'),

    ARGON2_MEMORY_COST: z.coerce.number().int().min(8192).default(19456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

    EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),

    // Much shorter than email verification: a reset link is a live key to the
    // account, so its useful life is measured in minutes, not days.
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

    // --- Registration policy ---
    LECTURER_REQUIRES_ADMIN_APPROVAL: booleanish.default('true'),

    // --- ERP ---
    ERP_BASE_URL: z.string().url(),
    ERP_STAFF_LOOKUP_PATH: z
      .string()
      .min(1)
      .refine((path) => path.includes('{staffNumber}'), {
        message: 'must contain the {staffNumber} placeholder',
      })
      .default('/v1/staff/{staffNumber}'),
    ERP_STUDENT_LOOKUP_PATH: z
      .string()
      .min(1)
      .refine((path) => path.includes('{registrationNumber}'), {
        message: 'must contain the {registrationNumber} placeholder',
      })
      .default('/v1/students/{registrationNumber}'),
    ERP_AUTH_SCHEME: z.enum(['bearer', 'api-key', 'basic', 'none']).default('bearer'),
    ERP_API_KEY: z.string().optional(),
    ERP_API_KEY_HEADER: z.string().default('X-API-Key'),
    ERP_BASIC_USERNAME: z.string().optional(),
    ERP_BASIC_PASSWORD: z.string().optional(),
    ERP_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5000),
    ERP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    ERP_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
    ERP_ENFORCE_IDENTITY_MATCH: booleanish.default('true'),

    // --- Rate limiting ---
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    // Tighter than sign-in: each request sends an email, so an open endpoint is
    // a way to flood someone's inbox from a stranger's browser.
    PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

    // --- Sign-in lockout (README section 4.1: repeated failures are rate-limited) ---
    /** Consecutive wrong passwords before the account is temporarily locked. */
    // --- Attendance QR codes ---
    // How often the projected code changes. Shorter is safer but leaves less
    // room for a slow scan; 60s is the balance the spec asks for.
    QR_ROTATION_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
    // Earlier windows still accepted, to cover the gap between a student
    // opening the camera and the scan reaching the server. Each extra window
    // is another rotation period in which a shared screenshot still works.
    QR_ACCEPT_PREVIOUS_WINDOWS: z.coerce.number().int().min(0).max(5).default(1),
    // Pixel width of a rendered PNG. Large enough to scan from the back row.
    QR_IMAGE_SIZE: z.coerce.number().int().min(128).max(2048).default(512),

    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  })
  // Credentials must actually be present for whichever ERP auth scheme is chosen,
  // otherwise every lookup would fail at runtime with a 401 that looks like an
  // ERP outage and would revoke legitimate registrations.
  .superRefine((env, ctx) => {
    if ((env.ERP_AUTH_SCHEME === 'bearer' || env.ERP_AUTH_SCHEME === 'api-key') && !env.ERP_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ERP_API_KEY'],
        message: `is required when ERP_AUTH_SCHEME is "${env.ERP_AUTH_SCHEME}"`,
      });
    }
    if (env.ERP_AUTH_SCHEME === 'basic' && (!env.ERP_BASIC_USERNAME || !env.ERP_BASIC_PASSWORD)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ERP_BASIC_USERNAME'],
        message: 'ERP_BASIC_USERNAME and ERP_BASIC_PASSWORD are required for basic auth',
      });
    }
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Deliberately not using the logger: it depends on this module.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

import 'dotenv/config';
import { z } from 'zod';
import { isValidTimeZone } from '../common/utils/campus-time.js';

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

/** An empty value in .env (`KEY=`) means "not set", not an invalid value. */
const emptyAsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema);

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

    // --- Email delivery (Resend) ---
    // Left empty outside production on purpose: mail is then logged instead of
    // sent, which is what makes registration and password reset testable
    // locally and in CI without a key. In production an empty key is refused.
    RESEND_API_KEY: z.string().default(''),
    /** RFC 5322 sender. The domain must be verified in Resend or it refuses the send. */
    EMAIL_FROM: z.string().min(3).default('Smart Attendance <onboarding@resend.dev>'),

    // Much shorter than email verification: a reset link is a live key to the
    // account, so its useful life is measured in minutes, not days.
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

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
    /** The issued timetable: a unit's real name/schedule/assigned lecturer, looked up by code. */
    ERP_COURSE_LOOKUP_PATH: z
      .string()
      .min(1)
      .refine((path) => path.includes('{code}'), {
        message: 'must contain the {code} placeholder',
      })
      .default('/v1/courses/{code}'),
    /** A unit's roster: who the registrar's records enrol in this course. */
    ERP_COURSE_ENROLLMENTS_PATH: z
      .string()
      .min(1)
      .refine((path) => path.includes('{code}'), {
        message: 'must contain the {code} placeholder',
      })
      .default('/v1/courses/{code}/students'),
    ERP_AUTH_SCHEME: z.enum(['bearer', 'api-key', 'basic', 'none']).default('bearer'),
    ERP_API_KEY: z.string().optional(),
    ERP_API_KEY_HEADER: z.string().default('X-API-Key'),
    ERP_BASIC_USERNAME: z.string().optional(),
    ERP_BASIC_PASSWORD: z.string().optional(),
    ERP_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5000),
    ERP_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    ERP_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),

    // --- SMARTTT (the university timetable system) ---
    // Source of the units a lecturer is timetabled to teach and how many
    // students are registered for each. Unset SMARTTT_BASE_URL = sync off,
    // and units come only from lecturers adding them by code.
    SMARTTT_BASE_URL: emptyAsUnset(z.string().url().optional()),
    /** Sent as X-API-Key; must equal ATTENDANCE_API_KEY on the SMARTTT side. */
    SMARTTT_API_KEY: emptyAsUnset(z.string().optional()),
    /** Student registration checks the registration number here (SMARTTT apps/integrations). */
    SMARTTT_STUDENT_LOOKUP_PATH: z.string().min(1).default('/api/v1/integrations/attendance/students/'),
    /** Lecturer registration checks the staff number here: SMARTTT's approved staff list. */
    SMARTTT_STAFF_LOOKUP_PATH: z.string().min(1).default('/api/v1/integrations/attendance/staff/'),
    /** A student's units page lists the classes SMARTTT has them registered for this term. */
    SMARTTT_STUDENT_UNITS_PATH: z.string().min(1).default('/api/v1/integrations/attendance/student-units/'),
    SMARTTT_LECTURER_UNITS_PATH: z
      .string()
      .min(1)
      .default('/api/v1/integrations/attendance/lecturer-units/'),
    // Generous: SMARTTT on Render's free tier can take a while to wake. The
    // sync fails soft, so a timeout only means the last synced data is shown.
    SMARTTT_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(8000),
    // Per lecturer. Stops every units-page load from calling SMARTTT.
    SMARTTT_SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(60),

    // --- WebAuthn / phone biometrics ---
    WEBAUTHN_RP_ID: z.string().min(1).default('localhost'),
    WEBAUTHN_RP_NAME: z.string().min(1).default('Smart Attendance'),
    WEBAUTHN_ORIGIN: z.string().url().default('http://localhost:5173'),

    // --- Rate limiting ---
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
    REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    // Tighter than sign-in: each request sends an email, so an open endpoint is
    // a way to flood someone's inbox from a stranger's browser.
    PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    // Check-in is limited per signed-in student, not per IP: a lecture hall on
    // campus Wi-Fi reaches the API from one public address, and a per-IP limit
    // sized for one person would lock the whole class out within minutes.
    // Generous enough for a student retrying a vague or stale location reading;
    // tight enough that nobody can probe the fence to calibrate a fake position.
    CHECKIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
    CHECKIN_RATE_LIMIT_PER_STUDENT: z.coerce.number().int().positive().default(20),
    // Backstop against a flood from one address before sign-in is even checked.
    // Sized for the biggest hall retrying at once, not for one person.
    CHECKIN_RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(3000),

    // --- Sign-in lockout (README section 4.1: repeated failures are rate-limited) ---
    /** Consecutive wrong passwords before the account is temporarily locked. */
    // --- Attendance QR codes ---
    // How often the projected code changes. Shorter is safer but leaves less
    // room for a slow scan; 60s is the balance the spec asks for.
    QR_ROTATION_SECONDS: z.coerce.number().int().min(15).max(600).default(45),
    // Earlier windows still accepted, to cover the gap between a student
    // opening the camera and the scan reaching the server. Each extra window
    // is another rotation period in which a shared screenshot still works.
    QR_ACCEPT_PREVIOUS_WINDOWS: z.coerce.number().int().min(0).max(5).default(1),
    // Pixel width of a rendered PNG. Large enough to scan from the back row.
    QR_IMAGE_SIZE: z.coerce.number().int().min(128).max(2048).default(512),

    // --- Student ID card check-in ---
    // The shared key every card terminal presents as X-API-Key. Unset = card
    // check-in is refused outright, which is the right default: a terminal
    // endpoint that anyone can post to would mark a hall present.
    CARD_TERMINAL_API_KEY: emptyAsUnset(z.string().min(32, 'must be at least 32 characters').optional()),
    // Keys the HMAC that card UIDs are stored under. A card UID is only 32-56
    // bits, so a plain hash of it could be enumerated from a database dump and
    // written onto blank cards; an HMAC a dump does not contain cannot be.
    // Changing this invalidates every enrolled card, which is the escape hatch
    // if the table ever leaks.
    CARD_UID_SECRET: emptyAsUnset(z.string().min(32, 'must be at least 32 characters').optional()),

    // --- Fingerprint check-in ---
    // As above, for fingerprint terminals. A separate key from the card
    // terminals' so one class of device can be revoked without the other.
    FINGERPRINT_TERMINAL_API_KEY: emptyAsUnset(z.string().min(32, 'must be at least 32 characters').optional()),
    // Keys the HMAC over the reader's enrolment reference. That reference is
    // often a slot number in the low hundreds, so a plain hash would be
    // trivially enumerable. No fingerprint is stored either way.
    FINGERPRINT_REF_SECRET: emptyAsUnset(z.string().min(32, 'must be at least 32 characters').optional()),

    // --- Geofenced check-in (session.geofence.ts) ---
    // How far from the room's centre a student may be. Accuracy counts in the
    // student's favour, so the effective reach is radius + reported accuracy.
    GEOFENCE_RADIUS_METRES: z.coerce.number().min(5).max(500).default(20),
    // A reading vaguer than this is refused outright: at 200m accuracy the
    // phone could be anywhere on campus, and the rule above would let it in.
    GEOFENCE_MAX_STUDENT_ACCURACY_METRES: z.coerce.number().min(5).max(500).default(50),
    // Tighter than the student limit: every check-in is measured from this
    // point, so an error here moves the fence for the whole class.
    GEOFENCE_MAX_ANCHOR_ACCURACY_METRES: z.coerce.number().min(5).max(500).default(30),
    // A cached fix from the corridor or the bus stop is not evidence of being
    // in the room now.
    GEOFENCE_MAX_FIX_AGE_SECONDS: z.coerce.number().int().min(5).max(600).default(60),

    // --- Face check-in (src/modules/verification, docs/face-recognition.md) ---
    // The Python service that turns photos into face templates. Unset = face
    // check-in is off: its endpoints answer 503 and QR works as before.
    FACE_SERVICE_URL: emptyAsUnset(z.string().url().optional()),
    /** Sent as X-Face-Service-Key; must equal FACE_SERVICE_KEY on the service. */
    FACE_SERVICE_KEY: emptyAsUnset(z.string().min(32, 'must be at least 32 characters').optional()),
    FACE_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(10_000),
    // Cosine similarity a face must reach to be offered as a match. OpenCV's
    // published figure for SFace is 0.363; higher is stricter. The lecturer
    // confirms every match, so this trades "not recognised" retries against
    // offering the wrong name. Tune with real photos (docs/face-recognition.md phase 4).
    FACE_MATCH_THRESHOLD: z.coerce.number().min(0.2).max(0.95).default(0.4),
    // How far the best match must lead the runner-up. Below this the terminal
    // says "not sure" rather than guess between two similar-looking students.
    FACE_MATCH_MARGIN: z.coerce.number().min(0).max(0.5).default(0.05),
    // How long the lecturer has to tap Confirm after a match.
    FACE_MATCH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(60),
    // Frames whose face is smaller (in pixels, width) or blurrier (Laplacian
    // variance of the aligned crop) than this are refused as unusable.
    FACE_MIN_FACE_PX: z.coerce.number().int().min(20).max(1000).default(80),
    FACE_MIN_SHARPNESS: z.coerce.number().min(0).default(40),
    // Per lecturer, in the CHECKIN_RATE_LIMIT_WINDOW_MS window. A terminal takes
    // about two requests per student (identify, confirm), plus retries, for the
    // biggest class.
    FACE_RATE_LIMIT_PER_LECTURER: z.coerce.number().int().positive().default(1500),

    // The zone timetable slots are written in. The server's own clock is usually
    // UTC, so "is this class on now?" is always answered in this zone instead
    // (src/common/utils/campus-time.ts). IANA name, e.g. Africa/Nairobi.
    CAMPUS_TIMEZONE: z
      .string()
      .default('Africa/Nairobi')
      .refine(isValidTimeZone, { message: 'is not a known IANA time zone, e.g. Africa/Nairobi' }),

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
    if (env.SMARTTT_BASE_URL && !env.SMARTTT_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMARTTT_API_KEY'],
        message: 'is required when SMARTTT_BASE_URL is set',
      });
    }
    if (env.FACE_SERVICE_URL && !env.FACE_SERVICE_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FACE_SERVICE_KEY'],
        message: 'is required when FACE_SERVICE_URL is set',
      });
    }
    // A terminal key without the secret would accept swipes it can never match
    // a card to: every one would 404. Fail at boot instead of at the door.
    if (env.CARD_TERMINAL_API_KEY && !env.CARD_UID_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CARD_UID_SECRET'],
        message: 'is required when CARD_TERMINAL_API_KEY is set',
      });
    }
    if (env.FINGERPRINT_TERMINAL_API_KEY && !env.FINGERPRINT_REF_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FINGERPRINT_REF_SECRET'],
        message: 'is required when FINGERPRINT_TERMINAL_API_KEY is set',
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

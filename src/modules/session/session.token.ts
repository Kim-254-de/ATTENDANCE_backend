import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Rotating attendance QR tokens.
 *
 * The problem: a student photographs the projected QR code and sends it to an
 * absent friend, who scans it and is marked present.
 *
 * The fix: the code is not a fixed value. It is derived from the session's
 * secret and the current time window, so it changes every
 * QR_ROTATION_SECONDS (60 by default) and a photographed code stops working
 * almost immediately.
 *
 *   payload   = v1.<sessionId>.<counter>.<signature>
 *   counter   = floor(unixSeconds / rotationSeconds)
 *   signature = HMAC-SHA256(sessionSecret, "v1.<sessionId>.<counter>")
 *
 * Nothing is stored per rotation. The server recomputes the signature when a
 * scan arrives, so a two-hour class writes ONE attendance_sessions row rather
 * than one row per minute. The stable identifier for the class meeting is that
 * row; the unit it belongs to (COSC 100) is a single row in `units`.
 *
 * What this does NOT solve: sharing a screenshot *within* the current window.
 * Rotation shrinks that window to a minute or two; the defences that close it
 * are the one-check-in-per-student-per-session constraint and verifying the
 * student is allocated to the unit. See the module README.
 *
 * This file is deliberately pure — no database, no HTTP — so the signing and
 * rotation rules can be tested exhaustively.
 */

/** Bumped if the payload layout ever changes, so old clients fail cleanly. */
const TOKEN_VERSION = 'v1';

/** Bytes of HMAC kept in the payload. 16 bytes = 128 bits, far past forgery. */
const SIGNATURE_BYTES = 16;

/** Session secrets are 32 bytes of CSPRNG output. */
export const SESSION_SECRET_BYTES = 32;

export interface QrToken {
  /** The string encoded into the QR image. */
  payload: string;
  /** Time window this token belongs to. */
  counter: number;
  /** When this token first became valid. */
  issuedAt: Date;
  /** When the counter rolls over and a fresh code must be shown. */
  rotatesAt: Date;
  /** Seconds until rotation — what the lecturer's screen counts down. */
  expiresInSeconds: number;
}

export type QrVerificationFailure =
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'SESSION_MISMATCH'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'BAD_SIGNATURE';

export type QrVerificationResult =
  | { valid: true; sessionId: string; counter: number; ageSeconds: number }
  | { valid: false; reason: QrVerificationFailure };

/** A fresh secret for a newly created attendance session. Store it, never expose it. */
export function generateSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString('base64url');
}

/** The time window a moment falls in. Server clock only — never client-supplied. */
export function counterFor(at: Date = new Date(), rotationSeconds = env.QR_ROTATION_SECONDS): number {
  return Math.floor(at.getTime() / 1000 / rotationSeconds);
}

function sign(sessionId: string, counter: number, secret: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${TOKEN_VERSION}.${sessionId}.${counter}`)
    .digest()
    .subarray(0, SIGNATURE_BYTES)
    .toString('base64url');
}

/**
 * Builds the token for the window containing `at`.
 *
 * The lecturer's screen calls this roughly once a minute; the response carries
 * `expiresInSeconds` so the client knows exactly when to ask again rather than
 * guessing.
 */
export function issueToken(
  sessionId: string,
  secret: string,
  at: Date = new Date(),
  rotationSeconds = env.QR_ROTATION_SECONDS,
): QrToken {
  const counter = counterFor(at, rotationSeconds);
  const signature = sign(sessionId, counter, secret);

  const windowStartMs = counter * rotationSeconds * 1000;
  const rotatesAtMs = windowStartMs + rotationSeconds * 1000;

  return {
    payload: `${TOKEN_VERSION}.${sessionId}.${counter}.${signature}`,
    counter,
    issuedAt: new Date(windowStartMs),
    rotatesAt: new Date(rotatesAtMs),
    // Rounded up so a client never re-requests a fraction of a second early
    // and gets the same token back.
    expiresInSeconds: Math.max(1, Math.ceil((rotatesAtMs - at.getTime()) / 1000)),
  };
}

/**
 * Checks a scanned payload against the session it claims to belong to.
 *
 * Accepts the current window plus QR_ACCEPT_PREVIOUS_WINDOWS earlier ones. That
 * grace exists because scanning is not instant: a student who opens the camera
 * at second 59 submits at second 61, and rejecting them would be wrong. It is a
 * real trade-off — each extra window is another minute in which a shared
 * screenshot still works — so it is configurable and defaults to 1.
 *
 * Tokens from the FUTURE are never accepted. A counter ahead of the server's
 * clock means either a forged payload or a misconfigured client, and neither
 * should mark attendance.
 */
export function verifyToken(
  payload: string,
  expected: { sessionId: string; secret: string },
  at: Date = new Date(),
  options: { rotationSeconds?: number; acceptPreviousWindows?: number } = {},
): QrVerificationResult {
  const rotationSeconds = options.rotationSeconds ?? env.QR_ROTATION_SECONDS;
  const acceptPrevious = options.acceptPreviousWindows ?? env.QR_ACCEPT_PREVIOUS_WINDOWS;

  const parts = payload.trim().split('.');
  if (parts.length !== 4) return { valid: false, reason: 'MALFORMED' };

  const [version, sessionId, counterText, signature] = parts as [string, string, string, string];

  if (version !== TOKEN_VERSION) return { valid: false, reason: 'UNSUPPORTED_VERSION' };
  if (!sessionId || !signature) return { valid: false, reason: 'MALFORMED' };

  // Reject anything non-numeric before Number() turns it into something
  // surprising — Number('') is 0 and Number('0x10') is 16.
  if (!/^\d+$/.test(counterText)) return { valid: false, reason: 'MALFORMED' };
  const counter = Number(counterText);
  if (!Number.isSafeInteger(counter)) return { valid: false, reason: 'MALFORMED' };

  // Compared before any crypto: a token for a different session is not a
  // signature problem and should not be reported as one.
  if (sessionId !== expected.sessionId) return { valid: false, reason: 'SESSION_MISMATCH' };

  const currentCounter = counterFor(at, rotationSeconds);
  if (counter > currentCounter) return { valid: false, reason: 'NOT_YET_VALID' };
  if (counter < currentCounter - acceptPrevious) return { valid: false, reason: 'EXPIRED' };

  // The signature covers the counter, so a stale code cannot be edited to look
  // current — but verify it anyway before trusting any of the above.
  if (!signaturesMatch(signature, sign(sessionId, counter, expected.secret))) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }

  return {
    valid: true,
    sessionId,
    counter,
    ageSeconds: Math.max(0, Math.floor(at.getTime() / 1000) - counter * rotationSeconds),
  };
}

/** Constant-time compare, so response timing cannot be used to forge a signature byte by byte. */
function signaturesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Human-readable reasons, safe to return to a scanning student. */
export const VERIFICATION_MESSAGES: Record<QrVerificationFailure, string> = {
  MALFORMED: 'This QR code is not a valid attendance code.',
  UNSUPPORTED_VERSION: 'This QR code was produced by an older app version. Please update the app.',
  SESSION_MISMATCH: 'This QR code belongs to a different class session.',
  EXPIRED: 'This QR code has expired. Please scan the code currently on screen.',
  NOT_YET_VALID: 'This QR code is not valid yet. Check your device clock and scan the code on screen.',
  BAD_SIGNATURE: 'This QR code is not a valid attendance code.',
};

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Face match tokens: what lets the lecturer's Confirm tap record the student
 * the server matched, and nobody else.
 *
 *   token     = f1.<studentUserId>.<scoreMilli>.<expiresAtSeconds>.<signature>
 *   signature = HMAC-SHA256(sessionSecret, "f1.<sessionId>.<studentUserId>.<scoreMilli>.<expiresAtSeconds>")
 *
 * Signed with the session's own QR secret, so a token dies with the session
 * and cannot be used on another one. The "f1" prefix keeps these from ever
 * being mistaken for a QR payload signed with the same key ("v1.<sessionId>.<counter>").
 *
 * Nothing is stored: confirming the same token twice is stopped by the
 * one-record-per-student-per-session constraint, like a double scan.
 *
 * Pure — no database, no HTTP.
 */

const TOKEN_VERSION = 'f1';
const SIGNATURE_BYTES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MatchClaim {
  sessionId: string;
  studentUserId: string;
  /** Cosine similarity, rounded to three places by the token. */
  score: number;
}

export type MatchTokenFailure = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

export type MatchTokenResult =
  | { valid: true; studentUserId: string; score: number }
  | { valid: false; reason: MatchTokenFailure };

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest().subarray(0, SIGNATURE_BYTES);
}

export function issueMatchToken(
  claim: MatchClaim,
  secret: string,
  ttlSeconds: number,
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const scoreMilli = Math.round(claim.score * 1000);
  const expiresAtSeconds = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const fields = `${claim.studentUserId}.${scoreMilli}.${expiresAtSeconds}`;
  const signature = sign(`${TOKEN_VERSION}.${claim.sessionId}.${fields}`, secret).toString('base64url');
  return { token: `${TOKEN_VERSION}.${fields}.${signature}`, expiresAt: new Date(expiresAtSeconds * 1000) };
}

/** Checks a token against the session it is being confirmed on. */
export function verifyMatchToken(
  token: string,
  sessionId: string,
  secret: string,
  now: Date = new Date(),
): MatchTokenResult {
  const parts = token.trim().split('.');
  if (parts.length !== 5) return { valid: false, reason: 'MALFORMED' };
  const [version, studentUserId, scoreMilli, expiresAt, signature] = parts as [string, string, string, string, string];
  if (
    version !== TOKEN_VERSION ||
    !UUID_PATTERN.test(studentUserId) ||
    !/^-?\d{1,4}$/.test(scoreMilli) ||
    !/^\d{1,12}$/.test(expiresAt)
  ) {
    return { valid: false, reason: 'MALFORMED' };
  }

  const expected = sign(`${TOKEN_VERSION}.${sessionId}.${studentUserId}.${scoreMilli}.${expiresAt}`, secret);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, reason: 'BAD_SIGNATURE' };
  }
  // Checked after the signature, so an expiry is only ever reported for a token this server issued.
  if (Math.floor(now.getTime() / 1000) > Number(expiresAt)) return { valid: false, reason: 'EXPIRED' };

  return { valid: true, studentUserId: studentUserId.toLowerCase(), score: Number(scoreMilli) / 1000 };
}

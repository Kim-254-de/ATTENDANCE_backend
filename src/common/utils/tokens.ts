import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque, single-use tokens (email verification, password reset).
 *
 * The plaintext token is handed to the user exactly once, by email. Only its
 * SHA-256 hash is persisted, so a stolen database dump cannot be replayed.
 * SHA-256 is adequate here — unlike a password, the token is 256 bits of
 * uniform randomness and is not brute-forceable.
 */

export interface GeneratedToken {
  /** Send this to the user. Never store it. */
  token: string;
  /** Store this. */
  tokenHash: string;
}

export function generateToken(byteLength = 32): GeneratedToken {
  const token = randomBytes(byteLength).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison, to avoid leaking a hash through response timing. */
export function tokenHashesMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function expiresInHours(hours: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

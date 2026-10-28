import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Student ID card identifiers.
 *
 * A card UID is whatever the reader gets off the card — typically a 4 or 7
 * byte NFC serial, so 32 to 56 bits. That is the crucial difference from the
 * tokens in tokens.ts: those are 256 bits of uniform randomness, which is why
 * storing a plain SHA-256 of them is sound. A 32-bit UID is not. Every
 * possible value could be hashed in seconds, so a plain digest of a card UID
 * in a leaked table is as good as the UID itself, and a UID is all it takes to
 * write a working clone onto a blank card.
 *
 * So UIDs are stored under an HMAC keyed with a secret that lives in the
 * environment, not the database. A dump on its own yields nothing, and
 * rotating the secret invalidates every enrolled card at once — which is the
 * recovery path if the table is ever exposed.
 *
 * The UID is normalised first: readers differ on case and on whether they
 * separate bytes, so `04:A3:B2` and `04a3b2` are the same card.
 */

/** Strips separators and upper-cases, so one card hashes the same from any reader. */
export function normaliseCardUid(uid: string): string {
  return uid.trim().replace(/[\s:-]/g, '').toUpperCase();
}

export function hashCardUid(uid: string, secret: string): string {
  if (!secret) throw new Error('hashCardUid requires a secret');
  return createHmac('sha256', secret).update(normaliseCardUid(uid)).digest('hex');
}

/** Constant-time compare, so response timing cannot be used to confirm a UID byte by byte. */
export function cardHmacsMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

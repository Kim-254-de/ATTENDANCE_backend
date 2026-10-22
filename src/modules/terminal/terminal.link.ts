import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The code a lecturer's screen shows so a terminal can link itself to their
 * class: `ATL1.<sessionId>.<expiresUnix>.<signature>`, rendered as a QR code.
 *
 * Signed with the session's own secret (the one its rotating QR codes use),
 * so only the server can mint one and a code names exactly one session. It is
 * stateless and good for a few minutes, so a lecturer with a large class can
 * link two or three terminals from the same code. Nothing about it lets a
 * student check in: only a paired terminal's key can use it.
 */

const PREFIX = 'ATL1';
export const LINK_CODE_TTL_SECONDS = 300;

function sign(secret: string, sessionId: string, expiresUnix: number): string {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`terminal-link|${sessionId}|${expiresUnix}`)
    .digest('base64url')
    .slice(0, 32);
}

export function issueLinkCode(sessionId: string, secret: string, now: Date = new Date()): { code: string; expiresAt: Date } {
  const expiresUnix = Math.floor(now.getTime() / 1000) + LINK_CODE_TTL_SECONDS;
  return {
    code: `${PREFIX}.${sessionId}.${expiresUnix}.${sign(secret, sessionId, expiresUnix)}`,
    expiresAt: new Date(expiresUnix * 1000),
  };
}

/** The session a code claims to be for, before its signature is checked. Null when it is not a link code at all. */
export function parseLinkCode(code: string): { sessionId: string; expiresUnix: number; signature: string } | null {
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, sessionId, expires, signature] = parts as [string, string, string, string];
  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !/^\d{1,12}$/.test(expires) || !signature) return null;
  return { sessionId, expiresUnix: Number(expires), signature };
}

export function checkLinkCode(
  parsed: { sessionId: string; expiresUnix: number; signature: string },
  secret: string,
  now: Date = new Date(),
): 'OK' | 'EXPIRED' | 'INVALID' {
  const expected = Buffer.from(sign(secret, parsed.sessionId, parsed.expiresUnix));
  const presented = Buffer.from(parsed.signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return 'INVALID';
  return now.getTime() / 1000 > parsed.expiresUnix ? 'EXPIRED' : 'OK';
}

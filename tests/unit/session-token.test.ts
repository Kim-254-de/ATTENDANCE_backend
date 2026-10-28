import { describe, expect, it } from 'vitest';
import {
  counterFor,
  generateSessionSecret,
  issueToken,
  verifyToken,
} from '../../src/modules/session/session.token.js';

const SESSION = '3f1b2c4d-0000-4000-8000-000000000001';
const OTHER_SESSION = '3f1b2c4d-0000-4000-8000-000000000002';
const SECRET = generateSessionSecret();

/** A fixed instant, so the tests never depend on when they run. */
const T0 = new Date('2026-09-22T09:00:00.000Z');
const at = (secondsFromT0: number) => new Date(T0.getTime() + secondsFromT0 * 1000);

const opts = { rotationSeconds: 60, acceptPreviousWindows: 1 };

describe('generateSessionSecret', () => {
  it('returns a different secret every call', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateSessionSecret()));
    expect(secrets.size).toBe(50);
  });

  it('returns 32 bytes of entropy', () => {
    expect(Buffer.from(generateSessionSecret(), 'base64url')).toHaveLength(32);
  });
});

describe('issueToken', () => {
  it('produces the documented payload layout', () => {
    const token = issueToken(SESSION, SECRET, T0, 60);
    const [version, sessionId, counter, signature] = token.payload.split('.');
    expect(version).toBe('v1');
    expect(sessionId).toBe(SESSION);
    expect(counter).toBe(String(counterFor(T0, 60)));
    expect(signature).toBeTruthy();
  });

  it('returns the same payload for every instant inside one window', () => {
    const first = issueToken(SESSION, SECRET, at(0), 60).payload;
    const middle = issueToken(SESSION, SECRET, at(30), 60).payload;
    const last = issueToken(SESSION, SECRET, at(59), 60).payload;
    expect(middle).toBe(first);
    expect(last).toBe(first);
  });

  it('changes once the minute rolls over', () => {
    const before = issueToken(SESSION, SECRET, at(59), 60).payload;
    const after = issueToken(SESSION, SECRET, at(60), 60).payload;
    expect(after).not.toBe(before);
  });

  it('counts down to the rotation boundary', () => {
    expect(issueToken(SESSION, SECRET, at(0), 60).expiresInSeconds).toBe(60);
    expect(issueToken(SESSION, SECRET, at(45), 60).expiresInSeconds).toBe(15);
    // Never zero: a client told "0 seconds left" has nothing to display.
    expect(issueToken(SESSION, SECRET, at(59.5), 60).expiresInSeconds).toBeGreaterThanOrEqual(1);
  });

  it('gives different sessions different payloads at the same instant', () => {
    const a = issueToken(SESSION, SECRET, T0, 60).payload;
    const b = issueToken(OTHER_SESSION, SECRET, T0, 60).payload;
    expect(a).not.toBe(b);
  });

  it('gives different secrets different signatures for the same session', () => {
    const a = issueToken(SESSION, generateSessionSecret(), T0, 60).payload;
    const b = issueToken(SESSION, generateSessionSecret(), T0, 60).payload;
    expect(a).not.toBe(b);
  });
});

describe('verifyToken', () => {
  it('accepts the code currently on screen', () => {
    const token = issueToken(SESSION, SECRET, at(10), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(12), opts);
    expect(result.valid).toBe(true);
  });

  it('accepts a scan that lands just after the code rotated', () => {
    // Student opens the camera at 0:59 and the request arrives at 1:01.
    const token = issueToken(SESSION, SECRET, at(59), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(61), opts);
    expect(result.valid).toBe(true);
  });

  it('rejects a photographed code once the grace window has passed', () => {
    const token = issueToken(SESSION, SECRET, at(0), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(150), opts);
    expect(result).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('rejects immediately when no grace is allowed', () => {
    const token = issueToken(SESSION, SECRET, at(0), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(61), {
      rotationSeconds: 60,
      acceptPreviousWindows: 0,
    });
    expect(result).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('never accepts a token from the future', () => {
    const token = issueToken(SESSION, SECRET, at(300), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(0), opts);
    expect(result).toEqual({ valid: false, reason: 'NOT_YET_VALID' });
  });

  it("rejects another session's valid code", () => {
    const token = issueToken(OTHER_SESSION, SECRET, T0, 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, T0, opts);
    expect(result).toEqual({ valid: false, reason: 'SESSION_MISMATCH' });
  });

  it('rejects a code signed with a different secret', () => {
    const token = issueToken(SESSION, generateSessionSecret(), T0, 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, T0, opts);
    expect(result).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects a stale code edited to carry the current counter', () => {
    // The forger takes yesterday's photo and rewrites the counter. The
    // signature covers the counter, so it no longer matches.
    const stale = issueToken(SESSION, SECRET, at(0), 60);
    const [version, sessionId, , signature] = stale.payload.split('.');
    const forged = [version, sessionId, String(counterFor(at(600), 60)), signature].join('.');
    const result = verifyToken(forged, { sessionId: SESSION, secret: SECRET }, at(600), opts);
    expect(result).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it.each([
    ['empty', ''],
    ['too few parts', 'v1.session.1'],
    ['too many parts', 'v1.session.1.sig.extra'],
    ['non-numeric counter', `v1.${SESSION}.abc.sig`],
    ['negative counter', `v1.${SESSION}.-1.sig`],
    ['hex counter', `v1.${SESSION}.0x10.sig`],
    ['empty counter', `v1.${SESSION}..sig`],
  ])('rejects a malformed payload: %s', (_label, payload) => {
    const result = verifyToken(payload, { sessionId: SESSION, secret: SECRET }, T0, opts);
    expect(result).toEqual({ valid: false, reason: 'MALFORMED' });
  });

  it('rejects an unknown payload version', () => {
    const token = issueToken(SESSION, SECRET, T0, 60);
    const result = verifyToken(
      token.payload.replace(/^v1\./, 'v2.'),
      { sessionId: SESSION, secret: SECRET },
      T0,
      opts,
    );
    expect(result).toEqual({ valid: false, reason: 'UNSUPPORTED_VERSION' });
  });

  it('tolerates surrounding whitespace from a scanner', () => {
    const token = issueToken(SESSION, SECRET, T0, 60);
    const result = verifyToken(`  ${token.payload}\n`, { sessionId: SESSION, secret: SECRET }, T0, opts);
    expect(result.valid).toBe(true);
  });

  it('reports how old an accepted code is', () => {
    const token = issueToken(SESSION, SECRET, at(0), 60);
    const result = verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(30), opts);
    expect(result).toMatchObject({ valid: true, ageSeconds: 30 });
  });
});

describe('rotation boundaries', () => {
  it('advances the counter exactly once per rotation period', () => {
    const start = counterFor(T0, 60);
    expect(counterFor(at(59), 60)).toBe(start);
    expect(counterFor(at(60), 60)).toBe(start + 1);
    expect(counterFor(at(119), 60)).toBe(start + 1);
    expect(counterFor(at(120), 60)).toBe(start + 2);
  });

  it('honours a non-default rotation period', () => {
    const token = issueToken(SESSION, SECRET, at(0), 30);
    expect(
      verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(29), {
        rotationSeconds: 30,
        acceptPreviousWindows: 0,
      }).valid,
    ).toBe(true);
    expect(
      verifyToken(token.payload, { sessionId: SESSION, secret: SECRET }, at(31), {
        rotationSeconds: 30,
        acceptPreviousWindows: 0,
      }).valid,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { generateSessionSecret } from '../../src/modules/session/session.token.js';
import { issueMatchToken, verifyMatchToken } from '../../src/modules/verification/face.token.js';

const SESSION = '3f1b2c4d-0000-4000-8000-000000000001';
const OTHER_SESSION = '3f1b2c4d-0000-4000-8000-000000000002';
const STUDENT = '9a1b2c4d-0000-4000-8000-0000000000aa';
const OTHER_STUDENT = '9a1b2c4d-0000-4000-8000-0000000000bb';
const SECRET = generateSessionSecret();

const T0 = new Date('2026-10-08T09:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const issue = (score = 0.8123) => issueMatchToken({ sessionId: SESSION, studentUserId: STUDENT, score }, SECRET, 60, T0);

describe('match tokens', () => {
  it('carry the student and the score, rounded to three places', () => {
    const { token, expiresAt } = issue();
    expect(token.split('.')).toHaveLength(5);
    expect(expiresAt).toEqual(at(60));
    expect(verifyMatchToken(token, SESSION, SECRET, at(30))).toEqual({ valid: true, studentUserId: STUDENT, score: 0.812 });
  });

  it('are valid up to their expiry and not after', () => {
    const { token } = issue();
    expect(verifyMatchToken(token, SESSION, SECRET, at(60)).valid).toBe(true);
    expect(verifyMatchToken(token, SESSION, SECRET, at(61))).toEqual({ valid: false, reason: 'EXPIRED' });
  });

  it('only work on the session they were issued for', () => {
    const { token } = issue();
    expect(verifyMatchToken(token, OTHER_SESSION, SECRET, at(1))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    expect(verifyMatchToken(token, SESSION, generateSessionSecret(), at(1))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it('cannot be edited to name another student, a better score or a later expiry', () => {
    const [v, student, score, exp, sig] = issue().token.split('.');
    const edits = [
      [v, OTHER_STUDENT, score, exp, sig],
      [v, student, '999', exp, sig],
      [v, student, score, String(Number(exp) + 600), sig],
    ];
    for (const parts of edits) {
      expect(verifyMatchToken(parts.join('.'), SESSION, SECRET, at(1))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
    }
  });

  it('report a forged token as forged even when it would also be expired', () => {
    const [v, , score, exp, sig] = issue().token.split('.');
    expect(verifyMatchToken([v, OTHER_STUDENT, score, exp, sig].join('.'), SESSION, SECRET, at(3600))).toEqual({ valid: false, reason: 'BAD_SIGNATURE' });
  });

  it.each([
    '',
    'nonsense',
    'f1.a.b.c.d',
    `v1.${STUDENT}.812.1.sig`,
    `f1.${STUDENT}.812.1`,
    `f1.${STUDENT}.abc.1.sig`,
  ])('refuse malformed input %j', (token) => {
    expect(verifyMatchToken(token, SESSION, SECRET, at(1))).toEqual({ valid: false, reason: 'MALFORMED' });
  });
});

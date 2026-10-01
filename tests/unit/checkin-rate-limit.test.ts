import express, { type Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCheckInLimiters, isCheckInRequest } from '../../src/middleware/rate-limit.js';

/**
 * Check-in rate limits, on a bare app: the real limiters skip in tests, so
 * these build enforcing ones. Every request here comes from the same IP,
 * which is the point: that's what a lecture hall on campus Wi-Fi looks like.
 */
function hall(limits: { perStudent: number; perIp: number }) {
  const { perIp, perStudent } = createCheckInLimiters({ ...limits, windowMs: 60_000, enforceInTests: true });
  const app = express();
  app.post(
    '/check-in',
    perIp,
    // Stands in for requireAuth.
    (req, _res, next) => {
      const student = req.header('x-student');
      if (student) req.auth = { userId: student, sessionId: 's', role: 'STUDENT', lecturer: null, student: null };
      next();
    },
    perStudent,
    (_req, res) => { res.status(201).json({ success: true }); },
  );
  return (student: string) => request(app).post('/check-in').set('x-student', student);
}

describe('check-in rate limits', () => {
  it('gives every student their own allowance, however many share an IP', async () => {
    const checkIn = hall({ perStudent: 3, perIp: 1000 });
    for (let n = 0; n < 200; n++) {
      expect((await checkIn(`student-${n}`)).status).toBe(201);
    }
  });

  it('stops one student retrying without end, with Retry-After and the API error shape', async () => {
    const checkIn = hall({ perStudent: 3, perIp: 1000 });
    for (let n = 0; n < 3; n++) expect((await checkIn('keen')).status).toBe(201);

    const blocked = await checkIn('keen');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });

    // Their classmates are unaffected.
    expect((await checkIn('classmate')).status).toBe(201);
  });

  it('still caps a single address as a backstop against floods', async () => {
    const checkIn = hall({ perStudent: 1000, perIp: 5 });
    for (let n = 0; n < 5; n++) expect((await checkIn(`s${n}`)).status).toBe(201);
    expect((await checkIn('s-next')).status).toBe(429);
  });
});

describe('isCheckInRequest (exempt from the global per-IP limit)', () => {
  const req = (method: string, path: string) => ({ method, path }) as Request;

  it('matches the two check-in routes, as seen from the /api mount', () => {
    expect(isCheckInRequest(req('POST', '/v1/attendance/check-in'))).toBe(true);
    expect(isCheckInRequest(req('POST', '/v1/sessions/scan'))).toBe(true);
  });

  it('matches nothing else', () => {
    expect(isCheckInRequest(req('GET', '/v1/attendance/check-in'))).toBe(false);
    expect(isCheckInRequest(req('POST', '/v1/sessions'))).toBe(false);
    expect(isCheckInRequest(req('POST', '/v1/auth/login'))).toBe(false);
    expect(isCheckInRequest(req('POST', '/v1/attendance/check-in/extra'))).toBe(false);
  });
});

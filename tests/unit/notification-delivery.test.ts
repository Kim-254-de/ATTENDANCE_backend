import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How mail leaves the system.
 *
 * Two behaviours are load-bearing and easy to break without noticing:
 *  - With no key, the body is logged at debug level. Every integration test
 *    reads its verification and reset tokens out of that line.
 *  - Resend reports a refusal in the response body rather than by throwing, so
 *    a rejected message looks like a delivered one unless the error is checked.
 */

const send = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

/** Imported fresh each time: env is read at import, and the client is cached per module. */
async function load(apiKey: string) {
  vi.resetModules();
  process.env.RESEND_API_KEY = apiKey;
  process.env.EMAIL_FROM = 'Smart Attendance <no-reply@test.local>';
  const { notificationService } = await import('../../src/modules/notification/index.js');
  const { logger } = await import('../../src/config/logger.js');
  return { notificationService, logger };
}

const reset = { to: 'lecturer@uni.ac.ke', fullName: 'Dr. Jane Otieno', token: 'plain-token', expiresInMinutes: 60 };

beforeEach(() => { send.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.RESEND_API_KEY; });

describe('email delivery', () => {
  it('logs the body instead of sending when no key is configured', async () => {
    const { notificationService, logger } = await load('');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    await notificationService.sendPasswordReset(reset);

    expect(send).not.toHaveBeenCalled();
    // The token has to reach the log, or no local flow can be followed through.
    const bodies = debug.mock.calls.map(([first]) => (first as { body?: string }).body ?? '');
    expect(bodies.join('\n')).toContain('plain-token');
  });

  it('sends through Resend when a key is configured', async () => {
    const { notificationService } = await load('re_test_key');
    send.mockResolvedValue({ data: { id: 'msg_1' }, error: null });

    await notificationService.sendPasswordReset(reset);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      from: 'Smart Attendance <no-reply@test.local>',
      to: reset.to,
      subject: expect.stringMatching(/password/i),
      text: expect.stringContaining('plain-token'),
    });
  });

  it('treats a refusal reported in the body as a failure', async () => {
    const { notificationService } = await load('re_test_key');
    send.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });

    await expect(notificationService.sendPasswordReset(reset)).rejects.toThrow(/domain is not verified/);
  });
});

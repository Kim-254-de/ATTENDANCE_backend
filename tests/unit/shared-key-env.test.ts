import { afterEach, describe, expect, it, vi } from 'vitest';

describe('keys shared with SMARTTT and the Generator', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it.each(['  abc123\n', '"abc123"', "'abc123' ", 'abc123'])('%j is read as abc123', async (raw) => {
    process.env.GENERATOR_API_KEY = raw;
    process.env.SMARTTT_API_KEY = raw;
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect([env.GENERATOR_API_KEY, env.SMARTTT_API_KEY]).toEqual(['abc123', 'abc123']);
  });

  it('a blank key is unset', async () => {
    process.env.GENERATOR_API_KEY = '   ';
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect(env.GENERATOR_API_KEY).toBeUndefined();
  });
});

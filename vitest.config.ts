import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    /**
     * Each integration file creates its own database and replays every
     * migration in beforeAll. That grows with the schema, and past ~20
     * migrations it crosses vitest's 10s default — which surfaces as whole
     * files failing to load with no assertion failure, intermittently and
     * worse on a loaded machine. Raised so adding a migration cannot quietly
     * start breaking unrelated suites.
     */
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/**/index.ts'],
    },
  },
});

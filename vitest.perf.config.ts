import { defineConfig } from 'vitest/config';

// Dedicated config for `npm run test:perf` — runs only the perf bench under
// test/perf/, with a longer hook timeout. The default vitest.config.ts
// excludes test/perf/** to keep `npm test` fast.

export default defineConfig({
  test: {
    include: ['test/perf/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 5 * 60_000, // 5 min — populate + queries fit comfortably
    fileParallelism: false,
  },
});

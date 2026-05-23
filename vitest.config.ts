import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The perf bench lives under test/perf/ and is opt-in via
    // `npm run test:perf`, which targets the directory explicitly.
    // Excluding it here keeps the default `npm test` fast.
    exclude: ['node_modules/**', 'dist/**', 'test/perf/**'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});

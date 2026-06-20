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
    // Each integration test file creates its own throwaway testcontainer in
    // beforeAll → startHarness(). No state is shared between files, so
    // file-level parallelism is safe by construction. We cap at 4 workers
    // because every worker boots a Postgres container — unbounded
    // parallelism (vitest's default of `os.availableParallelism() - 1`)
    // saturates the Docker daemon on resource-constrained dev machines and
    // measured worse than this cap. See issue #24 for the measured
    // tradeoffs; the per-file isolation model (rather than pg-boss's
    // schema-per-test) is tracked in #16.
    fileParallelism: true,
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
  },
});

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
    // Each integration test file creates ONE throwaway testcontainer in
    // beforeAll → startHarness() and resets state BETWEEN tests in a beforeEach
    // (drop/truncate the pgbossier schema, delete pgboss.job) — NOT a container
    // per test. Booting a container costs ~3-5s; resetting is milliseconds, so
    // a file with N install-scenario tests must share one container, not boot N
    // (the #24 collapse cut ~32 container starts this way). When you add a file,
    // keep this pattern: assume the DB is dirty and reset, never boot per test.
    //
    // No state is shared between files, so file-level parallelism is safe by
    // construction. We cap at 4 workers because every worker boots a Postgres
    // container — unbounded parallelism (vitest's default of
    // `os.availableParallelism() - 1`) saturates the Docker daemon on
    // resource-constrained dev machines and measured worse than this cap. See
    // issue #24 for the measured tradeoffs; the per-file isolation model
    // (rather than pg-boss's schema-per-test) is tracked in #16.
    fileParallelism: true,
    poolOptions: {
      threads: {
        minThreads: 1,
        maxThreads: 4,
      },
    },
  },
});

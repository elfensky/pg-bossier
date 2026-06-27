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
    // ONE shared Postgres container for the whole run (#16): global-setup boots
    // it and provides its URL; each file's startHarness() creates a fresh
    // database inside it. The container boot (the slow part) happens once, not
    // once per file.
    globalSetup: ['test/global-setup.ts'],
    // Each integration test file creates ONE throwaway testcontainer in
    // beforeAll → startHarness() and resets state BETWEEN tests in a beforeEach
    // (drop/truncate the pgbossier schema, delete pgboss.job) — NOT a container
    // per test. Booting a container costs ~3-5s; resetting is milliseconds, so
    // a file with N install-scenario tests must share one container, not boot N
    // (the #24 collapse cut ~32 container starts this way). When you add a file,
    // keep this pattern: assume the DB is dirty and reset, never boot per test.
    //
    // No state is shared between files, so file-level parallelism is safe by
    // construction. We cap at 4 workers because every worker creates its own
    // database + pg-boss instance against the one shared container (#16) —
    // unbounded parallelism (vitest's default of `os.availableParallelism() - 1`)
    // saturates Postgres connections / the Docker daemon on resource-constrained
    // dev machines and measured worse than this cap. See issue #24 for the
    // measured tradeoffs; the per-file isolation model is tracked in #16.
    //
    // Vitest 4 removed `poolOptions`; the worker count is a top-level option now
    // (`maxWorkers`), and `pool: 'threads'` keeps the prior thread-pool model.
    fileParallelism: true,
    pool: 'threads',
    maxWorkers: 4,
  },
});

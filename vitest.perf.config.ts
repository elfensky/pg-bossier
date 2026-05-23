import { defineConfig } from 'vitest/config';

// Dedicated config for `npm run test:perf` — runs only the perf bench under
// test/perf/ as a vitest benchmark suite. The default vitest.config.ts
// excludes test/perf/** to keep `npm test` fast.
//
// Mode: `vitest bench` (CLI) uses the `test.benchmark` block below.
// The `include` pattern selects which files vitest considers as bench
// suites. The `outputJson` reporter file is consumed by the issue-#23
// CI history pipeline — `scripts/perf-write.mjs` (on develop) and
// `scripts/perf-compare.mjs` (on PRs).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 5 * 60_000, // 5 min — populate + queries fit comfortably
    fileParallelism: false,
    // globalSetup runs before the bench workers spawn. It spins up the
    // testcontainer, populates 1k jobs, and provides the connection
    // string + median job id to the bench file via inject(). See
    // test/perf/global-setup.ts. Required because vitest's bench mode
    // does NOT invoke describe-level beforeAll hooks (issue #23).
    globalSetup: ['test/perf/global-setup.ts'],
    benchmark: {
      include: ['test/perf/**/*.bench.ts'],
      // The default benchmark reporter prints a sorted comparison table to
      // stdout. The structured JSON output below is written independently
      // of which reporter is chosen — vitest's BenchmarkReporter writes
      // `outputJson` in onTestRunEnd. The CI pipeline reads this exact path.
      reporters: ['default'],
      outputJson: 'perf-output.json',
    },
  },
});

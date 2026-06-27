import { describe, bench, inject } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import pg from 'pg';
import { bossier, type Bossier } from '../../src/client.js';

/**
 * Perf bench — chronicle read methods over a synthetic all-states populate
 * (default 1k jobs, scalable via PERF_N; see test/perf/global-setup.ts).
 *
 * Setup (testcontainer + synthetic all-states populate) is in `test/perf/global-setup.ts`
 * because vitest's `NodeBenchmarkRunner` does NOT invoke describe-level
 * `beforeAll` hooks. globalSetup provides `perfPgUrl` and `perfKnownJobId`
 * via vitest's `provide()`; we read them with `inject()` and build a
 * local pg.Pool + pg-boss instance pointing at the same container.
 *
 * Each bench is pinned to exactly N=100 iterations via tinybench's
 * `{ iterations: 100, time: 0, warmupIterations: 0 }` so the sample count
 * is deterministic across runs and the resulting mean / median / p99 are
 * comparable across CI runs.
 *
 * Output: tinybench's `TaskResult` (mean, median, p99, sd, samples, …) is
 * surfaced via vitest's JSON reporter to `perf-output.json` (see
 * `vitest.perf.config.ts`). The CI-anchored history pipeline (issue #23)
 * reads that file in `scripts/perf-write.mjs` and `scripts/perf-compare.mjs`.
 *
 * Run via: npm run test:perf
 * Spec: docs/superpowers/archive/2026-05-23-performance-budget-design.md
 */

const QUEUE = 'perf-q-0'; // one of the populated queues (see global-setup.ts)
const SAMPLES_PER_METHOD = 100;

// Pin tinybench to exactly N=100 iterations. tinybench stops when BOTH the
// time budget elapses AND the iteration count is reached; setting time=0
// and warmupIterations=0 makes iterations the only stopping condition.
const PIN_100 = {
  iterations: SAMPLES_PER_METHOD,
  time: 0,
  warmupIterations: 0,
};

// globalSetup ran already — pull the handoff values.
const connectionString = inject('perfPgUrl');
const knownJobId = inject('perfKnownJobId');

// Build local pool + pg-boss against the same container globalSetup
// populated. pg-boss start() is idempotent — its schema already exists.
const pool = new pg.Pool({ connectionString });
const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
await boss.start();
const client: Bossier = bossier({ boss, pool });

describe('Perf — chronicle read methods (all-states populate)', () => {
  // Each bench's `name` is the human-readable variant_label.
  // The stable canonical `method_id` is paired by name in
  // `scripts/perf-write.mjs::METHOD_IDS`; keep that map in sync with this list.
  // knownJobId is a RETRIED job, so getRetryHistory(known) sees a real chain;
  // QUEUE is one of the populated queues; the populate leaves active jobs so
  // listLongRunning returns non-empty. Scale via PERF_N (see global-setup.ts).
  bench('findById(known)',                () => client.findById(knownJobId),                            PIN_100);
  bench('findById(unknown)',              () => client.findById(randomUUID()),                          PIN_100);
  bench('getRetryHistory(known)',         () => client.getRetryHistory(knownJobId),                     PIN_100);
  bench('listJobs({})',                   () => client.listJobs({}),                                    PIN_100);
  bench("listJobs({state:'completed'})",  () => client.listJobs({ state: 'completed' }),                PIN_100);
  bench("listJobs({queue:'perf-q-0'})",   () => client.listJobs({ queue: QUEUE }),                      PIN_100);
  bench("latestPerQueue(['perf-q-0'])",   () => client.latestPerQueue([QUEUE]),                         PIN_100);
  bench('countByState({})',               () => client.countByState({}),                                PIN_100);
  bench('countByQueue({})',               () => client.countByQueue({}),                                PIN_100);
  bench('listLongRunning({900})',         () => client.listLongRunning({ longerThanSeconds: 900 }),     PIN_100);
});

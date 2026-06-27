import type { TestProject } from 'vitest/node';
import { startContainerHarness, type Harness } from '../harness.ts';
import { install } from '../../src/install.ts';
import { bossier } from '../../src/client.ts';

/**
 * Global setup for the perf bench (issues #23, #21).
 *
 * Vitest's bench mode does NOT invoke describe-level `beforeAll` hooks, so the
 * container + populate live here. We `provide()` the connection string + a known
 * (retried) job id; the bench reads them via `inject()`.
 *
 * Populate (#21): a synthetic **all-states** chronicle — completed, failed,
 * retried (real multi-attempt chains), active/in-progress, cancelled, and
 * created — spread across several queues. Built by ONE bulk `INSERT … SELECT`
 * over `generate_series` (no per-job round-trips), so it scales from the 1k
 * default to **1M** via `PERF_N`. The distribution is deterministic (keyed off
 * the row index, not RNG) so benchmark numbers stay comparable across runs —
 * randomized chaos lives in `test/battle/`, not the bench. This replaces the
 * old happy-path-only populate, which measured getRetryHistory on no-retry jobs,
 * listLongRunning on zero active jobs, and latest/count on a single queue.
 */

const N = Number(process.env.PERF_N ?? 1000);
const QUEUES = 8;

let harness: Harness | null = null;

/**
 * Bulk-insert `n` jobs' worth of all-states chronicle rows. Each job gets a
 * deterministic shape from its index `i`:
 *  - queue: `perf-q-<i % 8>` (multi-queue cardinality)
 *  - outcome: cycled across completed/failed/cancelled/active/created
 *  - attempts: ~1 in 5 jobs get 2–4 attempts (the earlier ones frozen at
 *    `retry`, the last at the outcome) → real retry chains for getRetryHistory
 * `active` jobs get an old `started_on` (no `completed_on`) so listLongRunning
 * returns non-empty. seq/captured_at use the table defaults.
 */
async function populateChronicle(pool: Harness['pool'], n: number): Promise<void> {
  await pool.query(
    `INSERT INTO pgbossier.record
       (job_id, queue, attempt, state, data, output, priority, retry_limit,
        created_on, started_on, completed_on)
     SELECT
       j.id,
       j.queue,
       a.attempt,
       CASE WHEN a.attempt < j.attempts - 1 THEN 'retry' ELSE j.outcome END,
       jsonb_build_object('idx', j.i, 'payload', repeat('x', 64)),
       CASE
         WHEN a.attempt < j.attempts - 1 THEN jsonb_build_object('err', 'transient')
         WHEN j.outcome = 'completed'     THEN jsonb_build_object('ok', true)
         WHEN j.outcome = 'failed'        THEN jsonb_build_object('err', 'exhausted')
         ELSE NULL
       END,
       (j.i % 9), 3,
       now() - make_interval(mins => j.i % 4000),
       CASE WHEN j.outcome <> 'created' OR a.attempt > 0
            THEN now() - make_interval(mins => (j.i % 4000) - 1) END,
       CASE WHEN a.attempt = j.attempts - 1
             AND j.outcome IN ('completed', 'failed', 'cancelled')
            THEN now() - make_interval(mins => (j.i % 4000) / 2) END
     FROM (
       SELECT i,
              gen_random_uuid() AS id,
              'perf-q-' || (i % $2) AS queue,
              (ARRAY['completed','completed','completed','failed',
                     'cancelled','active','active','created'])[1 + (i % 8)] AS outcome,
              CASE WHEN i % 5 = 0 THEN 1 + (i % 4) ELSE 1 END AS attempts
       FROM generate_series(1, $1) AS i
     ) j
     CROSS JOIN LATERAL generate_series(0, j.attempts - 1) AS a(attempt)`,
    [n, QUEUES],
  );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  harness = await startContainerHarness();
  await install(harness.pool);
  await populateChronicle(harness.pool, N);

  // A known job WITH a retry chain, so getRetryHistory(known) is benched on a
  // real multi-attempt job (not a 1-attempt one).
  const { rows } = await harness.pool.query<{ job_id: string }>(
    `SELECT job_id FROM pgbossier.record
     GROUP BY job_id HAVING count(*) > 1 LIMIT 1`,
  );
  const knownJobId = rows[0]?.job_id;
  if (!knownJobId) {
    throw new Error('populateChronicle produced no retried job — cannot bench getRetryHistory(known)');
  }

  // Warm the read query plans once (the bench pins warmupIterations: 0, so the
  // first sample of each method would otherwise pay a plan-compile tax).
  const client = bossier({ boss: harness.boss, pool: harness.pool });
  await Promise.all([
    client.findById(knownJobId), client.getRetryHistory(knownJobId),
    client.listJobs({}), client.countByState({}), client.countByQueue({}),
    client.latestPerQueue(['perf-q-0']), client.listLongRunning({ longerThanSeconds: 900 }),
  ]);

  await harness.boss.stop(); // bench builds its own pg-boss against the same container
  project.provide('perfPgUrl', harness.connectionString);
  project.provide('perfKnownJobId', knownJobId);

  return async () => {
    if (!harness) return;
    await harness.teardown().catch(() => { /* container may already be down */ });
    harness = null;
  };
}

declare module 'vitest' {
  interface ProvidedContext {
    perfPgUrl: string;
    perfKnownJobId: string;
  }
}

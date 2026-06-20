import type { TestProject } from 'vitest/node';
import { startHarness, type Harness } from '../harness.ts';
import { install } from '../../src/install.ts';

/**
 * Global setup for the perf bench (issue #23).
 *
 * Vitest's bench mode does NOT invoke describe-level `beforeAll` hooks,
 * so the testcontainer + 1k-job populate cannot live inside the bench file.
 * The canonical vitest pattern is `globalSetup` + `provide()` / `inject()`:
 * setup runs once before any bench worker spawns, provides serializable
 * connection info to the bench file, then teardown stops the container.
 *
 * `provide()` values must be serializable, so we hand off the Postgres
 * connection string (and the median job id) — the bench file then creates
 * its own pg.Pool + pg-boss instance against the running container.
 */

const QUEUE = 'perf-queue';
const N_JOBS = 1000;
const N_WARMUP_JOBS = 100;

let harness: Harness | null = null;

async function populateLifecycle(boss: Harness['boss'], n: number): Promise<string[]> {
  await boss.createQueue(QUEUE);
  const jobIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await boss.send(QUEUE, { idx: i });
    if (id) jobIds.push(id);
  }
  let remaining = jobIds.length;
  while (remaining > 0) {
    const batch = await boss.fetch(QUEUE, { batchSize: 100 });
    if (!batch || batch.length === 0) break;
    for (const job of batch) {
      await boss.complete(QUEUE, job.id);
    }
    remaining -= batch.length;
  }
  return jobIds;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  harness = await startHarness();

  // -------- Phase 0: warmup populate (untimed, discarded) --------
  // JITs pg-boss's hot paths and warms Postgres's plan cache for
  // INSERT/UPDATE on pgboss.job. Without this, the first query of each
  // shape pays a plan-cache compilation tax that inflates p99 noisily.
  //
  // The TRUNCATE below runs while `harness.boss` is still alive. This is
  // tolerable because we constructed pg-boss with `supervise: false,
  // schedule: false` in harness.ts — no maintenance/cron loops are
  // running, no `work()` handler is registered, and we don't touch
  // pg-boss again until populating phase 1 (which doesn't depend on
  // pg-boss's in-memory state surviving the wipe).
  await populateLifecycle(harness.boss, N_WARMUP_JOBS);
  await harness.pool.query('TRUNCATE pgboss.job CASCADE');

  // -------- Phase 1: install pg-bossier, populate 1k jobs --------
  await install(harness.pool);
  const jobIds = await populateLifecycle(harness.boss, N_JOBS);

  if (jobIds.length === 0) {
    throw new Error(
      'populateLifecycle returned no job ids — bench cannot sample known-id methods',
    );
  }

  // Pick the median-position job id for known-id lookups.
  const knownJobId = jobIds[Math.floor(jobIds.length / 2)]!;

  // Stop pg-boss but leave the container running — the bench file builds
  // its own pg-boss instance against the same database.
  await harness.boss.stop();

  // Hand the connection string and chosen job id to the bench file.
  // Bench reads these via `inject('perfPgUrl')` and `inject('perfKnownJobId')`.
  project.provide('perfPgUrl', harness.connectionString);
  project.provide('perfKnownJobId', knownJobId);

  // Teardown: stop the container, drop the pool. Returned function runs
  // after all bench files complete.
  return async () => {
    if (!harness) return;
    await harness.pool.end();
    // harness.boss already stopped; calling stop() again is a no-op
    await harness.teardown().catch(() => {
      // If teardown errors (e.g. container already stopped via process
      // exit handler), don't fail the bench run on it.
    });
    harness = null;
  };
}

// Augment vitest's ProvidedContext so `inject('perfPgUrl')` is typed.
declare module 'vitest' {
  interface ProvidedContext {
    perfPgUrl: string;
    perfKnownJobId: string;
  }
}

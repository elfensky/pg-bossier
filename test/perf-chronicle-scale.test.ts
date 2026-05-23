import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

/**
 * Perf bench — chronicle read methods at 1k populated jobs.
 *
 * Single warm testcontainer:
 *   Phase 0 — warmup populate (100 jobs, discarded) to JIT pg-boss's hot
 *             paths and warm Postgres's plan cache before timed work.
 *   Phase 1 — install pg-bossier, populate 1k jobs through full pg-boss
 *             lifecycle (send → fetch → complete). Builds the chronicle.
 *   Phase 2 — sample each of the seven Goal 5 read methods 100 times,
 *             record mean + p99.
 *
 * Trigger-overhead measurement (a two-populate baseline-vs-installed
 * comparison) was attempted at N=1000 and found unreliable: JIT and OS
 * cache noise at this scale is the same order of magnitude as the
 * trigger's per-state-change cost, so the populate-time delta produced
 * inconsistent (sometimes negative) numbers. Trigger overhead measurement
 * is carried as follow-up #21 — likely via direct DB-side timing rather
 * than a populate-delta. This bench publishes ONLY read-method latencies.
 *
 * Run via: npm run test:perf
 * Spec: docs/superpowers/specs/2026-05-23-performance-budget-design.md
 */

const QUEUE = 'perf-queue';
const N_JOBS = 1000;
const N_WARMUP_JOBS = 100; // small populate to warm V8 JIT + PG plan cache before queries
const SAMPLES_PER_METHOD = 100;
const PERF_TIMEOUT_MS = 5 * 60_000; // 5-minute ceiling for the whole bench

interface Measurement {
  name: string;
  samples: number[];
  mean: number;
  median: number;
  p99: number;
}

class BenchHarness {
  private measurements: Measurement[] = [];

  async sampleMethod(name: string, n: number, fn: () => Promise<unknown>): Promise<void> {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const measurement: Measurement = {
      name,
      samples,
      mean: sum / samples.length,
      // Percentile of rank p over n samples: sorted[floor((n - 1) * p)].
      // For n=100, p99 is sorted[98] (second-highest), not sorted[99] (max).
      median: sorted[Math.floor((sorted.length - 1) * 0.5)]!,
      p99: sorted[Math.floor((sorted.length - 1) * 0.99)]!,
    };
    this.measurements.push(measurement);
  }

  allMeasurements(): readonly Measurement[] {
    return this.measurements;
  }

  /**
   * Print a markdown table to stdout. The same shape goes into PERFORMANCE.md.
   * Use console.log (not console.error) so vitest's stdout-reporter captures it.
   */
  report(): void {
    const lines: string[] = [];
    lines.push('');
    lines.push('### Perf bench — chronicle read methods (1k populated jobs, single-process)');
    lines.push('');
    lines.push('| Method                                | mean (ms) | median (ms) | p99 (ms) |');
    lines.push('|---------------------------------------|-----------|-------------|----------|');
    for (const m of this.measurements) {
      const padded = m.name.padEnd(37);
      lines.push(`| ${padded} | ${m.mean.toFixed(2).padStart(9)} | ${m.median.toFixed(2).padStart(11)} | ${m.p99.toFixed(2).padStart(8)} |`);
    }
    lines.push('');
    console.log(lines.join('\n'));
  }
}

/**
 * Populate the queue with N jobs via the full pg-boss happy-path lifecycle:
 *   N × send → fetch → complete (3 state transitions per job: created → active → completed).
 *
 * Returns the array of job IDs in creation order.
 */
async function populateLifecycle(boss: Harness['boss'], n: number): Promise<string[]> {
  await boss.createQueue(QUEUE);
  // Phase A — send
  const jobIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await boss.send(QUEUE, { idx: i });
    if (id) jobIds.push(id);
  }
  // Phase B — fetch + complete in batches of 100
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

describe('Perf — chronicle read methods (1k jobs)', () => {
  let env: Harness | null = null;
  let knownJobId: string;
  const bench = new BenchHarness();

  beforeAll(async () => {
    env = await startHarness();
    try {
      // -------- Phase 0: warmup populate (untimed, discarded) --------
      // 100 jobs through the lifecycle, then TRUNCATE. JITs pg-boss's hot
      // paths and warms Postgres's plan cache for INSERT/UPDATE on
      // pgboss.job. Without this the first query of each shape pays a
      // plan-cache compilation tax that inflates p99 noisily.
      await populateLifecycle(env.boss, N_WARMUP_JOBS);
      await env.pool.query('TRUNCATE pgboss.job CASCADE');

      // -------- Phase 1: install pg-bossier, populate 1k jobs --------
      await install(env.pool);
      const jobIds = await populateLifecycle(env.boss, N_JOBS);

      if (jobIds.length === 0) {
        throw new Error('populateLifecycle returned no job ids — bench cannot sample known-id methods');
      }
      // Pick the median-position job id for known-id lookups.
      knownJobId = jobIds[Math.floor(jobIds.length / 2)]!;
    } catch (err) {
      // Tear down the leaked container, then rethrow so the test fails loudly.
      await env.teardown();
      env = null;
      throw err;
    }

    // -------- Phase 2: query measurements against the populated chronicle --------
    const client = bossier({ boss: env.boss, pool: env.pool });
    await bench.sampleMethod('findById(known)',                SAMPLES_PER_METHOD, () => client.findById(knownJobId));
    await bench.sampleMethod('findById(unknown)',              SAMPLES_PER_METHOD, () => client.findById(randomUUID()));
    await bench.sampleMethod('getRetryHistory(known)',         SAMPLES_PER_METHOD, () => client.getRetryHistory(knownJobId));
    await bench.sampleMethod('listJobs({})',                   SAMPLES_PER_METHOD, () => client.listJobs({}));
    await bench.sampleMethod("listJobs({state:'completed'})",  SAMPLES_PER_METHOD, () => client.listJobs({ state: 'completed' }));
    await bench.sampleMethod("listJobs({queue:'perf-queue'})", SAMPLES_PER_METHOD, () => client.listJobs({ queue: QUEUE }));
    await bench.sampleMethod("latestPerQueue(['perf-queue'])", SAMPLES_PER_METHOD, () => client.latestPerQueue([QUEUE]));
    await bench.sampleMethod('countByState({})',               SAMPLES_PER_METHOD, () => client.countByState({}));
    await bench.sampleMethod('countByQueue({})',               SAMPLES_PER_METHOD, () => client.countByQueue({}));
    await bench.sampleMethod('listLongRunning({900})',         SAMPLES_PER_METHOD, () => client.listLongRunning({ olderThanSeconds: 900 }));

    bench.report();
  }, PERF_TIMEOUT_MS);

  afterAll(async () => {
    if (env) await env.teardown();
  });

  it('captured 10 query measurements', () => {
    expect(bench.allMeasurements().length).toBe(10);
  });

  it('every measurement has 100 samples', () => {
    for (const m of bench.allMeasurements()) {
      expect(m.samples.length).toBe(SAMPLES_PER_METHOD);
    }
  });

  it('every query p99 is under 1 second (sanity check, not budget)', () => {
    for (const m of bench.allMeasurements()) {
      expect(m.p99, `p99 of ${m.name}`).toBeLessThan(1000);
    }
  });
});

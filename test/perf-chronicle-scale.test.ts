import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

/**
 * Perf bench — chronicle scale (1k jobs).
 *
 * Two cold testcontainers in sequence:
 *   Phase 1 — baseline populate, no pg-bossier installed.
 *   Phase 2 — populate with pg-bossier installed. Container stays alive.
 *
 * Phase 3 (query measurement) runs against phase 2's container.
 *
 * The per-state-transition overhead = (T_phase2 - T_phase1) / 3000.
 * 3000 reflects 3 trigger fires per happy-path job (created → active → completed).
 *
 * Run via: npm run test:perf
 * Spec: docs/superpowers/specs/2026-05-23-performance-budget-design.md
 */

const QUEUE = 'perf-queue';
const N_JOBS = 1000;
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
  triggerOverheadMsPerStateChange = 0;
  tBaselineLifecycleMs = 0;
  tWithTriggerLifecycleMs = 0;

  recordTriggerOverhead(args: { tBaseline: number; tWithTrigger: number; stateTransitions: number }) {
    this.tBaselineLifecycleMs = args.tBaseline;
    this.tWithTriggerLifecycleMs = args.tWithTrigger;
    const delta = args.tWithTrigger - args.tBaseline;
    this.triggerOverheadMsPerStateChange = delta / args.stateTransitions;
  }

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
    lines.push('### Perf bench — chronicle scale (1k jobs, single-process)');
    lines.push('');
    lines.push(`- Populate baseline (no trigger):  ${this.tBaselineLifecycleMs.toFixed(1)} ms`);
    lines.push(`- Populate with trigger:           ${this.tWithTriggerLifecycleMs.toFixed(1)} ms`);
    lines.push(`- Per-state-transition overhead:   ${this.triggerOverheadMsPerStateChange.toFixed(3)} ms`);
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
 * Populate the queue with N jobs via the full pg-boss lifecycle:
 *   N × send → 3 trigger fires per job (created on INSERT, active on fetch UPDATE, completed on complete UPDATE).
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

describe('Perf — chronicle scale (1k jobs)', () => {
  let env: Harness | null = null;
  let knownJobId: string;
  const bench = new BenchHarness();

  beforeAll(async () => {
    // Single warm container for both phases. Empirically, two cold containers
    // produce a confounded trigger-overhead measurement: Docker startup,
    // Postgres filesystem cache, and V8 JIT differ between cold runs in ways
    // that swamp the trigger's per-state-change cost (the original two-cold
    // design measured negative overhead because the second populate benefited
    // from warm caches the first didn't have). One container with TRUNCATE
    // between phases keeps everything but the install status of pg-bossier
    // identical — the only variable that should drive the timing delta.
    env = await startHarness();
    try {
      // -------- Phase 1: baseline populate, no pg-bossier installed --------
      const t0p1 = performance.now();
      await populateLifecycle(env.boss, N_JOBS);
      const tBaseline = performance.now() - t0p1;

      // Reset between phases — drop the jobs but keep pgboss.queue config and
      // the warm Postgres process. CASCADE clears any partitions on the
      // partitioned pgboss.job table.
      await env.pool.query('TRUNCATE pgboss.job CASCADE');

      // -------- Phase 2: populate with pg-bossier installed --------
      await install(env.pool);
      const t0p2 = performance.now();
      const jobIds = await populateLifecycle(env.boss, N_JOBS);
      const tWithTrigger = performance.now() - t0p2;

      bench.recordTriggerOverhead({
        tBaseline,
        tWithTrigger,
        stateTransitions: N_JOBS * 3,
      });

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

    // -------- Phase 3: query measurements against the populated chronicle --------
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

  it('captured 10 query measurements (trigger overhead is a separate scalar)', () => {
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

  it('per-state-transition trigger overhead is under 50 ms (sanity check)', () => {
    expect(bench.triggerOverheadMsPerStateChange).toBeLessThan(50);
  });
});

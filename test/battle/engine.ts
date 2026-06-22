import type { JobState } from '../../src/read.js';

// ──────────────────────────────────────────────────────────────────────────
// Seeded PRNG — mulberry32. Reproduces the job PLAN SET, not the execution
// interleaving (see spec "Reproducibility — and its honest boundary").
// ──────────────────────────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number; // inclusive both ends
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  return {
    next: r,
    int,
    pick: <T>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new RangeError('pick: empty array');
      return arr[int(0, arr.length - 1)]!;
    },
    chance: (p: number): boolean => r() < p,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Workload planner. The seed fixes the plan set; outcomes are derived so the
// per-job oracle is exact (see spec "Core idea: an oracle, with bounded
// exactness").
// ──────────────────────────────────────────────────────────────────────────
export type Pattern = 'push' | 'pull';
export type Outcome = 'complete' | 'retryThenComplete' | 'exhaust' | 'cancel';
export type TerminalState = 'completed' | 'failed' | 'cancelled';

export interface QueueDef {
  name: string;
  pattern: Pattern;
}

export interface PlannedJob {
  key: string;
  queue: string;
  pattern: Pattern;
  retryLimit: number;
  priority: number;
  singletonKey: string;
  outcome: Outcome;
  /** Attempts (0-based count) that fail before the terminal attempt. */
  plannedFails: number;
  /** 0, or a small positive delay for the sendAfter (scheduled) shape. */
  delaySeconds: number;
  expectedAttempts: number;
  expectedTerminalState: TerminalState;
  /** Final state of each attempt row, oldest-first; length === expectedAttempts. */
  expectedAttemptStates: JobState[];
}

function expectedFor(
  outcome: Outcome,
  retryLimit: number,
  plannedFails: number,
): Pick<PlannedJob, 'expectedAttempts' | 'expectedTerminalState' | 'expectedAttemptStates'> {
  switch (outcome) {
    case 'complete':
      return { expectedAttempts: 1, expectedTerminalState: 'completed', expectedAttemptStates: ['completed'] };
    case 'cancel':
      return { expectedAttempts: 1, expectedTerminalState: 'cancelled', expectedAttemptStates: ['cancelled'] };
    case 'retryThenComplete':
      return {
        expectedAttempts: plannedFails + 1,
        expectedTerminalState: 'completed',
        expectedAttemptStates: [...Array<JobState>(plannedFails).fill('retry'), 'completed'],
      };
    case 'exhaust':
      return {
        expectedAttempts: retryLimit + 1,
        expectedTerminalState: 'failed',
        expectedAttemptStates: [...Array<JobState>(retryLimit).fill('retry'), 'failed'],
      };
  }
}

export function planWorkload(rng: Rng, opts: { n: number; queues: readonly QueueDef[] }): PlannedJob[] {
  const OUTCOMES: Outcome[] = ['complete', 'retryThenComplete', 'exhaust', 'cancel'];
  const jobs: PlannedJob[] = [];
  for (let i = 0; i < opts.n; i++) {
    const queue = rng.pick(opts.queues);
    const retryLimit = rng.int(0, 3);
    let outcome = rng.pick(OUTCOMES);
    // retryThenComplete needs at least one retry available.
    if (outcome === 'retryThenComplete' && retryLimit === 0) outcome = 'complete';

    let plannedFails: number;
    if (outcome === 'retryThenComplete') plannedFails = rng.int(1, retryLimit);
    else if (outcome === 'exhaust') plannedFails = retryLimit + 1;
    else plannedFails = 0;

    // Only the plain-complete shape may be delayed (keeps the scheduled path
    // free of retry/cancel interactions). Short delay → no wall-clock CI cost.
    const delaySeconds = outcome === 'complete' && rng.chance(0.15) ? 1 : 0;

    jobs.push({
      key: `j${i}`,
      queue: queue.name,
      pattern: queue.pattern,
      retryLimit,
      priority: rng.int(0, 5),
      singletonKey: `sk-${i}`, // unique → no dedup in the randomized body
      outcome,
      plannedFails,
      delaySeconds,
      ...expectedFor(outcome, retryLimit, plannedFails),
    });
  }
  return jobs;
}

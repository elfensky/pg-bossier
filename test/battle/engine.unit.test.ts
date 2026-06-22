import { test, expect } from 'vitest';
import {
  mulberry32,
  makeRng,
  planWorkload,
  decideAction,
  isTransientError,
  diffChronicle,
  findGlobalViolations,
  fingerprint,
  type QueueDef,
  type PlannedJob,
  type PerAttempt,
  type RunInfo,
} from './engine.js';

test('mulberry32 is deterministic for a seed and varies by seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  expect(seqA).toEqual(seqB);
  expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);

  const c = mulberry32(43);
  expect([c(), c(), c()]).not.toEqual(seqA.slice(0, 3));
});

test('makeRng.int respects inclusive bounds; pick returns a member', () => {
  const rng = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng.int(3, 8);
    expect(v).toBeGreaterThanOrEqual(3);
    expect(v).toBeLessThanOrEqual(8);
    expect(Number.isInteger(v)).toBe(true);
  }
  const items = ['x', 'y', 'z'] as const;
  for (let i = 0; i < 50; i++) expect(items).toContain(rng.pick(items));
});

test('makeRng.chance honors the 0 and 1 boundaries', () => {
  const rng = makeRng(11);
  for (let i = 0; i < 100; i++) {
    expect(rng.chance(0)).toBe(false); // r() < 0 never true
    expect(rng.chance(1)).toBe(true);  // r() < 1 always true ([0,1) range)
  }
});

const QS: QueueDef[] = [
  { name: 'p1', pattern: 'push' },
  { name: 'l1', pattern: 'pull' },
];

test('planWorkload is deterministic for a seed', () => {
  const a = planWorkload(makeRng(99), { n: 50, queues: QS });
  const b = planWorkload(makeRng(99), { n: 50, queues: QS });
  expect(a).toEqual(b);
  expect(a).toHaveLength(50);
});

test('every planned job is internally consistent', () => {
  const jobs = planWorkload(makeRng(1234), { n: 400, queues: QS });
  for (const j of jobs) {
    expect(j.expectedAttemptStates).toHaveLength(j.expectedAttempts);
    expect(j.expectedAttemptStates.at(-1)).toBe(j.expectedTerminalState);
    expect(j.pattern).toBe(QS.find((q) => q.name === j.queue)!.pattern);
    if (j.outcome === 'complete') {
      expect(j).toMatchObject({ plannedFails: 0, expectedAttempts: 1, expectedTerminalState: 'completed' });
    }
    if (j.outcome === 'cancel') {
      expect(j).toMatchObject({ plannedFails: 0, expectedAttempts: 1, expectedTerminalState: 'cancelled' });
    }
    if (j.outcome === 'retryThenComplete') {
      expect(j.retryLimit).toBeGreaterThanOrEqual(1);
      expect(j.plannedFails).toBeGreaterThanOrEqual(1);
      expect(j.plannedFails).toBeLessThanOrEqual(j.retryLimit);
      expect(j.expectedAttempts).toBe(j.plannedFails + 1);
      expect(j.expectedAttemptStates.slice(0, j.plannedFails).every((s) => s === 'retry')).toBe(true);
    }
    if (j.outcome === 'exhaust') {
      expect(j.expectedAttempts).toBe(j.retryLimit + 1);
      expect(j.expectedTerminalState).toBe('failed');
    }
    if (j.delaySeconds > 0) expect(j.outcome).toBe('complete');
  }
});

test('decideAction fails the planned-fail attempts then completes', () => {
  const plan = planWorkload(makeRng(5), { n: 1, queues: QS })[0]!;
  // Synthesise a known plan instead of relying on the random one:
  const p: PlannedJob = { ...plan, plannedFails: 2 };
  expect(decideAction(p, 0)).toBe('fail');
  expect(decideAction(p, 1)).toBe('fail');
  expect(decideAction(p, 2)).toBe('complete');
  expect(decideAction(p, 3)).toBe('complete');
});

test('isTransientError classifies retryable Postgres/connection errors', () => {
  expect(isTransientError({ code: '40001' })).toBe(true); // serialization
  expect(isTransientError({ code: '40P01' })).toBe(true); // deadlock
  expect(isTransientError({ code: '57P01' })).toBe(true); // admin shutdown (terminate_backend)
  expect(isTransientError({ code: '08006' })).toBe(true); // connection failure
  expect(isTransientError(new Error('Connection terminated unexpectedly'))).toBe(true);
  expect(isTransientError({ code: '23505' })).toBe(false); // unique_violation — real bug
  expect(isTransientError(new Error('boom'))).toBe(false);
});

function faithfulRows(plan: PlannedJob): PerAttempt[] {
  return plan.expectedAttemptStates.map((state, attempt) => ({
    attempt,
    state,
    priority: attempt === 0 ? plan.priority : null,
    retryLimit: attempt === 0 ? plan.retryLimit : null,
    singletonKey: attempt === 0 ? plan.singletonKey : null,
    dataJson: JSON.stringify({ key: plan.key }),
  }));
}

test('diffChronicle returns no errors for a faithful chronicle', () => {
  const jobs = planWorkload(makeRng(321), { n: 100, queues: QS });
  for (const plan of jobs) {
    expect(diffChronicle(faithfulRows(plan), plan)).toEqual([]);
  }
});

test('diffChronicle catches a wrong terminal state, wrong count, and wrong config', () => {
  const plan = planWorkload(makeRng(1), { n: 1, queues: QS })[0]!;
  const p: PlannedJob = {
    ...plan, outcome: 'retryThenComplete', retryLimit: 2, plannedFails: 1,
    expectedAttempts: 2, expectedTerminalState: 'completed',
    expectedAttemptStates: ['retry', 'completed'],
  };
  // Drop the final attempt and corrupt config → multiple diffs.
  const broken: PerAttempt[] = [
    { attempt: 0, state: 'retry', priority: 999, retryLimit: 2, singletonKey: p.singletonKey, dataJson: JSON.stringify({ key: p.key }) },
  ];
  const errs = diffChronicle(broken, p);
  expect(errs.some((e) => /attempts:/.test(e))).toBe(true);
  expect(errs.some((e) => /priority:/.test(e))).toBe(true);
});

test('findGlobalViolations flags duplicate PK and non-distinct seq', () => {
  expect(findGlobalViolations([
    { jobId: 'a', attempt: 0, seq: 1n },
    { jobId: 'a', attempt: 1, seq: 2n },
  ])).toEqual([]);
  const bad = findGlobalViolations([
    { jobId: 'a', attempt: 0, seq: 1n },
    { jobId: 'a', attempt: 0, seq: 1n },
  ]);
  expect(bad.some((e) => /dup PK/.test(e))).toBe(true);
  expect(bad.some((e) => /seq not distinct/.test(e))).toBe(true);
});

test('fingerprint includes seed, jobId, replay hint, and each error', () => {
  const plan = planWorkload(makeRng(2), { n: 1, queues: QS })[0]!;
  const info: RunInfo = { seed: 0xc0ffee, n: 200, workers: 5, phase: 'A' };
  const fp = fingerprint(info, 'job-123', plan, ['attempts: expected 2, got 1']);
  expect(fp).toContain('12648430'); // 0xc0ffee
  expect(fp).toContain('job-123');
  expect(fp).toContain('BATTLE_ONLY_JOB=job-123');
  expect(fp).toContain('attempts: expected 2, got 1');
});

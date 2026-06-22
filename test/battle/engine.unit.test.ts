import { test, expect } from 'vitest';
import { mulberry32, makeRng } from './engine.js';

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

import { planWorkload, type QueueDef, type PlannedJob } from './engine.js';

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

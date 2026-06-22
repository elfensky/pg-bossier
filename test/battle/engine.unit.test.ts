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

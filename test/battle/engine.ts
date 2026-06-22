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

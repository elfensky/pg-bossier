# Battle-test (chaos) Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a seeded, concurrent chaos harness that drives N jobs of varied shape/outcome through pg-boss and asserts pg-bossier's `pgbossier.record` chronicle stays faithful under concurrency, forensic deletes, audit-path outages, and connection kills.

**Architecture:** A pure-functions engine (`test/battle/engine.ts`) — seeded PRNG, workload planner, per-attempt decision logic, and the oracle's comparison core (all unit-testable without a container) — plus the IO layer (drivers, chaos injectors, assertion runners). A vitest orchestrator (`test/battle/battle.test.ts`) runs Phases A/B/C in the default `npm test` gate and Phase D behind `BATTLE_CHAOS_FULL=1`. Spec: `docs/superpowers/specs/2026-06-22-battle-test-harness-design.md` (v2, post-debate).

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest 4, `@testcontainers/postgresql` (real Postgres, no mocks), pg-boss 12, `pg`.

## Global Constraints

- **TypeScript strict + `noUncheckedIndexedAccess`.** Indexed access yields `T | undefined`; guard with `!` only where provably safe.
- **ESM with explicit `.js` specifiers** in relative imports (e.g. `'../../src/client.js'`), even though source is `.ts`.
- **No new runtime or dev dependency.** Seeded PRNG is hand-rolled (`mulberry32`). No `fast-check`.
- **No `src/` change.** Test-only. Do not modify `test/harness.ts` either.
- **Lands directly on `develop`** (test-only). Commit incrementally.
- **Fail-open is the contract under test** — never assert pg-bossier blocks a pg-boss op.
- **Determinism boundary:** the seed reproduces the *job plan set*, not execution interleaving. Assert per-`job_id` facts exactly; cross-job facts as invariants only; **never** assert cross-job ordering / relative timestamps / array position.
- **Verify before done:** `npm run lint && npm run build && npm test` must pass. Report actual output.
- **Commit message footer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create `test/battle/engine.ts`** — the harness engine. Pure exports (PRNG, planner, `decideAction`, `isTransientError`, `diffChronicle`, `findGlobalViolations`, `fingerprint`) + IO exports (queue/send/cancel, push handler factory, pull driver, `withRetry`, `waitForDrain`, `collectAllRows`, `assertWorkload`, `assertEventsCatchUp`, and the chaos injectors `forensicDelete` / `withAuditOutage` / `killBackends`). One cohesive module; the pure half has no `pg`/`pg-boss` IO.
- **Create `test/battle/engine.unit.test.ts`** — fast unit tests for the pure half (no testcontainer). Validates PRNG determinism, planner consistency, decision logic, error classification, and the oracle comparison core (positive + negative).
- **Create `test/battle/battle.test.ts`** — the vitest orchestrator (testcontainer). Phases A/B/C default; Phase D gated; singleton + dead-letter mini-cases.

`test/battle/engine.unit.test.ts` is the standard `vitest.config.ts` project, so it runs under `npm test` alongside the integration file. It needs no Docker and finishes in milliseconds.

---

## Verified reference facts (from the codebase — do not re-derive)

- `startHarness()` → `{ pool: pg.Pool, boss: PgBoss, connectionString: string, teardown: () => Promise<void> }`, with pg-boss built `supervise:false, schedule:false`. (`test/harness.ts`)
- `install(pool)` creates the `pgbossier` schema/trigger. (`src/install.ts`)
- `bossier({ boss, pool })` → `Bossier` (pg-boss API + pg-bossier methods). (`src/client.ts`)
- `resolveSchemas()` → `{ pgbossier: 'pgbossier', pgboss: 'pgboss' }`. (`src/sql.ts`)
- `JobRecord` fields used here: `jobId`, `queue`, `attempt:number`, `state: 'created'|'active'|'retry'|'completed'|'cancelled'|'failed'`, `data`, `output`, `priority:number|null`, `retryLimit:number|null`, `singletonKey:string|null`, `seq:bigint`. (`src/read.ts`)
- Chronicle semantics (`test/capture.test.ts`): a failed-with-retries-remaining attempt row ends in state `'retry'`; an exhausted final attempt ends `'failed'`; a job keeps one stable `id` across retries; `attempt` == pg-boss `retry_count` (0-based); `getRetryHistory(id)` returns attempts oldest-first; `priority`/`retry_limit`/`singleton_key` are captured at attempt 0.
- Client methods used: `findById(id)`, `getRetryHistory(id)`, `getEventsSince(since: bigint, limit?)`, `recordDeadLetter({sourceJobId, dlqJobId})`, `findDeadLetterSource(dlqJobId)`, `findDeadLetterTarget(sourceJobId)`. (`src/client.ts`)
- pg-boss methods used: `createQueue(name, opts?)`, `send(name, data, opts?)`, `sendAfter(name, data, opts, seconds)`, `fetch(name, opts?)`, `complete(name, id, output?)`, `fail(name, id, output?)`, `cancel(name, id)`, `work(name, opts, handler)`, `offWork(name)`.

> **One-time verification at the start of Task 5:** open `node_modules/pg-boss/types.d.ts` and confirm the exact names: `PgBoss.Job` (has `.id`), `PgBoss.SendOptions` (has `retryLimit`, `retryDelay`, `priority`, `singletonKey`, `deadLetter`), `PgBoss.WorkOptions` (has `pollingIntervalSeconds`, `teamSize`, `teamConcurrency`, `batchSize`), and `fetch`'s options/return shape. Adjust the type annotations in Task 5 to match. This is a real check, not a placeholder — the field *names* are stable but their TS spelling must match the installed version.

---

### Task 1: Seeded PRNG

**Files:**
- Create: `test/battle/engine.ts`
- Test: `test/battle/engine.unit.test.ts`

**Interfaces:**
- Produces: `mulberry32(seed: number): () => number`; `Rng` interface `{ next(): number; int(lo: number, hi: number): number; pick<T>(arr: readonly T[]): T; chance(p: number): boolean }`; `makeRng(seed: number): Rng`.

- [ ] **Step 1: Write the failing test**

Create `test/battle/engine.unit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: FAIL — cannot resolve `./engine.js` / exports not defined.

- [ ] **Step 3: Write minimal implementation**

Create `test/battle/engine.ts` with:

```ts
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
    pick: <T>(arr: readonly T[]): T => arr[int(0, arr.length - 1)]!,
    chance: (p: number): boolean => r() < p,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/engine.unit.test.ts
git commit -m "test(battle): seeded PRNG for the chaos harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Workload planner + expected outcomes

**Files:**
- Modify: `test/battle/engine.ts`
- Test: `test/battle/engine.unit.test.ts`

**Interfaces:**
- Consumes: `Rng` (Task 1).
- Produces:
  - `type Pattern = 'push' | 'pull'`
  - `type Outcome = 'complete' | 'retryThenComplete' | 'exhaust' | 'cancel'`
  - `type TerminalState = 'completed' | 'failed' | 'cancelled'`
  - `interface QueueDef { name: string; pattern: Pattern }`
  - `interface PlannedJob { key: string; queue: string; pattern: Pattern; retryLimit: number; priority: number; singletonKey: string; outcome: Outcome; plannedFails: number; delaySeconds: number; expectedAttempts: number; expectedTerminalState: TerminalState; expectedAttemptStates: JobState[] }`
  - `planWorkload(rng: Rng, opts: { n: number; queues: readonly QueueDef[] }): PlannedJob[]`

- [ ] **Step 1: Write the failing test**

Append to `test/battle/engine.unit.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: FAIL — `planWorkload` / `QueueDef` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `test/battle/engine.ts` (add the `JobState` type import at the top of the file):

```ts
import type { JobState } from '../../src/read.js';
```

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/engine.unit.test.ts
git commit -m "test(battle): seeded workload planner with derived expectations

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Per-attempt decision + transient-error classification

**Files:**
- Modify: `test/battle/engine.ts`
- Test: `test/battle/engine.unit.test.ts`

**Interfaces:**
- Consumes: `PlannedJob` (Task 2).
- Produces:
  - `decideAction(plan: PlannedJob, attemptIndex: number): 'fail' | 'complete'`
  - `isTransientError(err: unknown): boolean`

- [ ] **Step 1: Write the failing test**

Append to `test/battle/engine.unit.test.ts`:

```ts
import { decideAction, isTransientError } from './engine.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: FAIL — `decideAction` / `isTransientError` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `test/battle/engine.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────────
// Drivers apply the plan to the job they RECEIVE, keyed on attempt index — the
// debate's linchpin (spec Decision 2). `attemptIndex` is the count of prior
// handler/fetch invocations for that job id, NOT an assumed identity.
// ──────────────────────────────────────────────────────────────────────────
export function decideAction(plan: PlannedJob, attemptIndex: number): 'fail' | 'complete' {
  return attemptIndex < plan.plannedFails ? 'fail' : 'complete';
}

// Transient Postgres / connection errors that a driver op should retry rather
// than treat as a changed outcome (spec Decision 3).
const TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled
  '57P01', // admin_shutdown (pg_terminate_backend)
  '08000', '08003', '08006', // connection exceptions
  '53300', // too_many_connections
]);

export function isTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string'
    && /terminat|reset by peer|ECONNRESET|connection (closed|ended|refused|terminated)/i.test(msg);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/engine.unit.test.ts
git commit -m "test(battle): per-attempt decision + transient-error classifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Oracle comparison core + failure fingerprint

**Files:**
- Modify: `test/battle/engine.ts`
- Test: `test/battle/engine.unit.test.ts`

**Interfaces:**
- Consumes: `PlannedJob` (Task 2), `JobState` (`src/read.ts`).
- Produces:
  - `interface PerAttempt { attempt: number; state: JobState; priority: number | null; retryLimit: number | null; singletonKey: string | null; dataJson: string }`
  - `diffChronicle(rows: PerAttempt[], plan: PlannedJob): string[]` — empty array means faithful.
  - `findGlobalViolations(rows: { jobId: string; attempt: number; seq: bigint }[]): string[]`
  - `interface RunInfo { seed: number; n: number; workers: number; phase: string }`
  - `fingerprint(info: RunInfo, jobId: string, plan: PlannedJob, errs: string[]): string`

- [ ] **Step 1: Write the failing test**

Append to `test/battle/engine.unit.test.ts`:

```ts
import {
  diffChronicle, findGlobalViolations, fingerprint,
  type PerAttempt, type RunInfo,
} from './engine.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: FAIL — comparison exports not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `test/battle/engine.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────────
// Oracle comparison core (pure). Per-job-id facts are exact; the integration
// layer feeds DB rows in. Cross-job ordering/timestamps are NEVER compared
// (spec Decision 4).
// ──────────────────────────────────────────────────────────────────────────
export interface PerAttempt {
  attempt: number;
  state: JobState;
  priority: number | null;
  retryLimit: number | null;
  singletonKey: string | null;
  dataJson: string;
}

export function diffChronicle(rows: PerAttempt[], plan: PlannedJob): string[] {
  const errs: string[] = [];
  if (rows.length !== plan.expectedAttempts) {
    errs.push(`attempts: expected ${plan.expectedAttempts}, got ${rows.length}`);
  }
  for (let i = 0; i < plan.expectedAttemptStates.length; i++) {
    const want = plan.expectedAttemptStates[i];
    const got = rows[i]?.state;
    if (got !== want) errs.push(`attempt[${i}] state: expected ${want}, got ${got ?? 'MISSING'}`);
  }
  const first = rows[0];
  if (first) {
    const wantData = JSON.stringify({ key: plan.key });
    if (first.dataJson !== wantData) errs.push(`data: expected ${wantData}, got ${first.dataJson}`);
    if (first.priority !== plan.priority) errs.push(`priority: expected ${plan.priority}, got ${first.priority}`);
    if (first.retryLimit !== plan.retryLimit) errs.push(`retryLimit: expected ${plan.retryLimit}, got ${first.retryLimit}`);
    if (first.singletonKey !== plan.singletonKey) errs.push(`singletonKey: expected ${plan.singletonKey}, got ${first.singletonKey}`);
  }
  return errs;
}

export function findGlobalViolations(rows: { jobId: string; attempt: number; seq: bigint }[]): string[] {
  const errs: string[] = [];
  const pk = new Set<string>();
  let dupPk = 0;
  for (const r of rows) {
    const k = `${r.jobId}#${r.attempt}`;
    if (pk.has(k)) dupPk++;
    pk.add(k);
  }
  if (dupPk > 0) errs.push(`dup PK: ${dupPk} duplicate (job_id, attempt) row(s)`);

  const seqSet = new Set(rows.map((r) => r.seq.toString()));
  if (seqSet.size !== rows.length) {
    errs.push(`seq not distinct: ${rows.length - seqSet.size} collision(s)`);
  }
  return errs;
}

export interface RunInfo {
  seed: number;
  n: number;
  workers: number;
  phase: string;
}

export function fingerprint(info: RunInfo, jobId: string, plan: PlannedJob, errs: string[]): string {
  return [
    `BATTLE FAILURE [phase=${info.phase}]`,
    `  seed=${info.seed} n=${info.n} workers=${info.workers}`,
    `  jobId=${jobId} key=${plan.key} queue=${plan.queue} pattern=${plan.pattern}`,
    `  outcome=${plan.outcome} retryLimit=${plan.retryLimit} plannedFails=${plan.plannedFails} delaySeconds=${plan.delaySeconds}`,
    `  replay: BATTLE_SEED=${info.seed} BATTLE_ONLY_JOB=${jobId} npx vitest run test/battle/battle.test.ts`,
    ...errs.map((e) => `  ✗ ${e}`),
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/battle/engine.unit.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/engine.unit.test.ts
git commit -m "test(battle): pure oracle core + failure fingerprint (positive+negative)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: IO layer + minimal Phase A smoke

**Files:**
- Modify: `test/battle/engine.ts`
- Create: `test/battle/battle.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `PgBoss` / `pg.Pool` / `SchemaNames` / `Bossier`.
- Produces (IO exports on `engine.ts`):
  - `createQueues(boss, queues): Promise<void>`
  - `sendWorkload(boss, jobs): Promise<Map<string, PlannedJob>>`
  - `cancelPlanned(boss, byId): Promise<void>`
  - `makePushHandler(byId, attemptsSeen): (jobs: PgBoss.Job[]) => Promise<{ ok: true }>`
  - `runPullDriver(boss, pool, queue, byId, attemptsSeen, signal): Promise<void>`
  - `withRetry<T>(fn): Promise<T>`
  - `waitForDrain(pool, schemas, queues, deadlineMs): Promise<void>`
  - `collectAllRows(pool, schemas, queues): Promise<{ jobId; attempt; seq }[]>`
  - `assertWorkload(client, pool, schemas, byId, queues, info): Promise<void>`

> Do the **one-time pg-boss type verification** noted above before writing this task.

- [ ] **Step 1: Write the minimal smoke test (the failing test)**

Create `test/battle/battle.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../harness.js';
import { install } from '../../src/install.js';
import { bossier, type Bossier } from '../../src/client.js';
import { resolveSchemas } from '../../src/sql.js';
import * as battle from './engine.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
let client: Bossier;

beforeAll(async () => {
  h = await startHarness();
  await install(h.pool);
  client = bossier({ boss: h.boss, pool: h.pool });
}, 180_000);

afterAll(async () => { await h.teardown(); });

test('Phase A smoke — 10 complete-only push jobs are faithfully chronicled', async () => {
  const QUEUES: battle.QueueDef[] = [{ name: 'battle-smoke', pattern: 'push' }];
  const jobs = battle.planWorkload(battle.makeRng(1), { n: 10, queues: QUEUES })
    // force the smoke set to plain completes for a trivial first cut
    .map((j) => ({ ...j, outcome: 'complete' as const, plannedFails: 0, delaySeconds: 0,
      expectedAttempts: 1, expectedTerminalState: 'completed' as const, expectedAttemptStates: ['completed' as const] }));

  await battle.createQueues(h.boss, QUEUES);
  const byId = await battle.sendWorkload(h.boss, jobs);

  const attemptsSeen = new Map<string, number>();
  await h.boss.work('battle-smoke', { pollingIntervalSeconds: 0.5, teamSize: 5, teamConcurrency: 5 },
    battle.makePushHandler(byId, attemptsSeen));

  await battle.waitForDrain(h.pool, SCHEMAS, ['battle-smoke'], 60_000);
  await h.boss.offWork('battle-smoke');

  await battle.assertWorkload(client, h.pool, SCHEMAS, byId, ['battle-smoke'],
    { seed: 1, n: 10, workers: 5, phase: 'A-smoke' });
  expect(byId.size).toBe(10);
}, 120_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/battle/battle.test.ts`
Expected: FAIL — `createQueues` / `sendWorkload` / etc. not exported.

- [ ] **Step 3: Write the IO implementation**

Add imports at the top of `test/battle/engine.ts`:

```ts
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { SchemaNames } from '../../src/sql.js';
import type { Bossier } from '../../src/client.js';
```

Append to `test/battle/engine.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────────
// IO layer. Drivers act on the job they RECEIVE; transient errors retry with
// read-back reconciliation.
// ──────────────────────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err)) throw err;
      lastErr = err;
      await sleep(50 * (i + 1));
    }
  }
  throw lastErr;
}

export async function createQueues(boss: PgBoss, queues: readonly QueueDef[]): Promise<void> {
  for (const q of queues) await boss.createQueue(q.name);
}

export async function sendWorkload(boss: PgBoss, jobs: readonly PlannedJob[]): Promise<Map<string, PlannedJob>> {
  const byId = new Map<string, PlannedJob>();
  for (const job of jobs) {
    const opts: PgBoss.SendOptions = {
      retryLimit: job.retryLimit,
      retryDelay: 0, // retries are immediately re-fetchable → fast, deterministic
      priority: job.priority,
      singletonKey: job.singletonKey,
    };
    const id = job.delaySeconds > 0
      ? await boss.sendAfter(job.queue, { key: job.key }, opts, job.delaySeconds)
      : await boss.send(job.queue, { key: job.key }, opts);
    if (!id) throw new Error(`battle: send returned null for ${job.key} (unexpected singletonKey collision)`);
    byId.set(id, job);
  }
  return byId;
}

export async function cancelPlanned(boss: PgBoss, byId: Map<string, PlannedJob>): Promise<void> {
  // Cancel from 'created' before any worker/driver runs → deterministic
  // created→cancelled, no race (spec Drivers / Phase A).
  for (const [id, job] of byId) {
    if (job.outcome === 'cancel') await boss.cancel(job.queue, id);
  }
}

export function makePushHandler(
  byId: Map<string, PlannedJob>,
  attemptsSeen: Map<string, number>,
): (jobs: PgBoss.Job[]) => Promise<{ ok: true }> {
  // batchSize defaults to 1, so `jobs` holds one job per call; throwing fails
  // exactly that job (auto-retry if retries remain), returning auto-completes it.
  return async (jobs: PgBoss.Job[]): Promise<{ ok: true }> => {
    for (const job of jobs) {
      const plan = byId.get(job.id);
      if (!plan) continue; // not part of our workload
      const idx = attemptsSeen.get(job.id) ?? 0;
      attemptsSeen.set(job.id, idx + 1);
      if (decideAction(plan, idx) === 'fail') {
        throw new Error(`battle: planned fail ${plan.key} attempt ${idx}`);
      }
    }
    return { ok: true };
  };
}

async function alreadyAdvanced(pool: Pool, schemas: SchemaNames, jobId: string): Promise<boolean> {
  // Read-back reconciliation: an ambiguous commit (ack lost after Postgres
  // committed) shows the job already off 'active'. Treat as applied (Decision 3).
  const { rows } = await pool.query<{ state: string }>(
    `SELECT state FROM ${schemas.pgboss}.job WHERE id = $1`, [jobId],
  );
  return rows.length === 0 || rows[0]!.state !== 'active';
}

export async function runPullDriver(
  boss: PgBoss,
  pool: Pool,
  schemas: SchemaNames,
  queue: string,
  byId: Map<string, PlannedJob>,
  attemptsSeen: Map<string, number>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const batch = await withRetry(() => boss.fetch(queue, { batchSize: 10 }));
    if (!batch || batch.length === 0) { await sleep(50); continue; }
    for (const job of batch) {
      const plan = byId.get(job.id);
      if (!plan) { await boss.complete(queue, job.id); continue; }
      const idx = attemptsSeen.get(job.id) ?? 0;
      attemptsSeen.set(job.id, idx + 1);
      const act = decideAction(plan, idx);
      try {
        if (act === 'fail') await boss.fail(queue, job.id, { err: `planned ${idx}` });
        else await boss.complete(queue, job.id, { ok: true });
      } catch (err) {
        if (!isTransientError(err)) throw err;
        if (await alreadyAdvanced(pool, schemas, job.id)) continue;
        await withRetry(() => (act === 'fail'
          ? boss.fail(queue, job.id, { err: `planned ${idx}` })
          : boss.complete(queue, job.id, { ok: true })));
      }
    }
  }
}

export async function waitForDrain(
  pool: Pool, schemas: SchemaNames, queues: readonly string[], deadlineMs: number,
): Promise<void> {
  const start = Date.now();
  let stable = 0;
  while (Date.now() - start < deadlineMs) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schemas.pgbossier}.record
       WHERE queue = ANY($1) AND state IN ('created', 'active')`,
      [queues],
    );
    if (rows[0]!.n === '0') {
      if (++stable >= 3) return; // stable across 3 polls → drained
    } else {
      stable = 0;
    }
    await sleep(100);
  }
  throw new Error(`battle: workload did not drain within ${deadlineMs}ms`);
}

export async function collectAllRows(
  pool: Pool, schemas: SchemaNames, queues: readonly string[],
): Promise<{ jobId: string; attempt: number; seq: bigint }[]> {
  const { rows } = await pool.query<{ job_id: string; attempt: number; seq: string }>(
    `SELECT job_id, attempt, seq FROM ${schemas.pgbossier}.record WHERE queue = ANY($1)`,
    [queues],
  );
  return rows.map((r) => ({ jobId: r.job_id, attempt: r.attempt, seq: BigInt(r.seq) }));
}

export async function assertWorkload(
  client: Bossier,
  pool: Pool,
  schemas: SchemaNames,
  byId: Map<string, PlannedJob>,
  queues: readonly string[],
  info: RunInfo,
): Promise<void> {
  const only = process.env.BATTLE_ONLY_JOB;
  const failures: string[] = [];

  for (const [id, plan] of byId) {
    if (only && only !== id) continue;
    const hist = await client.getRetryHistory(id);
    const rows: PerAttempt[] = hist.map((h) => ({
      attempt: h.attempt,
      state: h.state,
      priority: h.priority,
      retryLimit: h.retryLimit,
      singletonKey: h.singletonKey,
      dataJson: JSON.stringify(h.data),
    }));
    const errs = diffChronicle(rows, plan);
    if (errs.length) failures.push(fingerprint(info, id, plan, errs));
  }

  const globalErrs = findGlobalViolations(await collectAllRows(pool, schemas, queues));
  if (globalErrs.length) {
    failures.push(`BATTLE GLOBAL INVARIANT [phase=${info.phase}] seed=${info.seed}\n`
      + globalErrs.map((e) => `  ✗ ${e}`).join('\n'));
  }

  if (failures.length) throw new Error(`\n${failures.join('\n\n')}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/battle/battle.test.ts`
Expected: PASS (the smoke test). If it times out, confirm Docker is running and pg-boss `work` options match the installed version.

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/battle.test.ts
git commit -m "test(battle): IO layer + minimal Phase A smoke

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Phase A — full concurrency storm + events catch-up

**Files:**
- Modify: `test/battle/engine.ts` (add `assertEventsCatchUp`)
- Modify: `test/battle/battle.test.ts` (replace the smoke test with the full Phase A)

**Interfaces:**
- Produces: `assertEventsCatchUp(client, byId): Promise<void>` — uses `getEventsSince(0n)` as the authority (spec Decision 5).

- [ ] **Step 1: Write `assertEventsCatchUp` (engine.ts)**

Append to `test/battle/engine.ts`:

```ts
export async function assertEventsCatchUp(
  client: Bossier,
  byId: Map<string, PlannedJob>,
): Promise<void> {
  // getEventsSince is the authority — live NOTIFY delivery is best-effort and
  // not asserted (spec Decision 5). Fresh container → all rows are ours.
  const evs = await client.getEventsSince(0n, 1_000_000);
  // strictly ascending seq
  for (let i = 1; i < evs.length; i++) {
    if (!(evs[i]!.seq > evs[i - 1]!.seq)) {
      throw new Error(`battle: getEventsSince seq not ascending at index ${i}`);
    }
  }
  // every job has a terminal-state row in the catch-up stream
  const terminalById = new Map<string, string>();
  for (const e of evs) {
    if (e.state === 'completed' || e.state === 'failed' || e.state === 'cancelled') {
      terminalById.set(e.jobId, e.state);
    }
  }
  const missing: string[] = [];
  for (const [id, plan] of byId) {
    if (terminalById.get(id) !== plan.expectedTerminalState) {
      missing.push(`${id} (${plan.key}): want ${plan.expectedTerminalState}, got ${terminalById.get(id) ?? 'NONE'}`);
    }
  }
  if (missing.length) {
    throw new Error(`battle: events catch-up missing terminal rows:\n  ${missing.join('\n  ')}`);
  }
}
```

- [ ] **Step 2: Replace the smoke test with full Phase A (battle.test.ts)**

Replace the `Phase A smoke` test with module-level config and the full test. Add near the top (after `const SCHEMAS`):

```ts
const SEED = process.env.BATTLE_SEED === 'random'
  ? Math.floor(Math.random() * 2 ** 31)
  : Number(process.env.BATTLE_SEED ?? 0xc0ffee);
const N = Number(process.env.BATTLE_N ?? 200);
const WORKERS = 5;
const QUEUES: battle.QueueDef[] = [
  { name: 'battle-push-1', pattern: 'push' },
  { name: 'battle-push-2', pattern: 'push' },
  { name: 'battle-push-3', pattern: 'push' },
  { name: 'battle-pull-1', pattern: 'pull' },
  { name: 'battle-pull-2', pattern: 'pull' },
];
const QNAMES = QUEUES.map((q) => q.name);

// Shared across the A/B/C sweep below.
let byId: Map<string, battle.PlannedJob>;
```

Add a `console.log` of the seed inside `beforeAll` (after `client = ...`):

```ts
  console.log(`[battle] seed=${SEED} n=${N} workers=${WORKERS}`);
```

Then the full Phase A test:

```ts
test('Phase A — concurrency storm: per-job chronicle is faithful', async () => {
  const jobs = battle.planWorkload(battle.makeRng(SEED), { n: N, queues: QUEUES });
  await battle.createQueues(h.boss, QUEUES);
  byId = await battle.sendWorkload(h.boss, jobs);
  await battle.cancelPlanned(h.boss, byId);

  const attemptsSeen = new Map<string, number>();
  for (const q of QUEUES.filter((q) => q.pattern === 'push')) {
    await h.boss.work(q.name, { pollingIntervalSeconds: 0.5, teamSize: WORKERS, teamConcurrency: WORKERS },
      battle.makePushHandler(byId, attemptsSeen));
  }
  const ac = new AbortController();
  const pullers = QUEUES.filter((q) => q.pattern === 'pull')
    .map((q) => battle.runPullDriver(h.boss, h.pool, SCHEMAS, q.name, byId, attemptsSeen, ac.signal));

  await battle.waitForDrain(h.pool, SCHEMAS, QNAMES, 90_000);
  ac.abort();
  await Promise.allSettled(pullers);
  for (const q of QUEUES.filter((q) => q.pattern === 'push')) await h.boss.offWork(q.name);

  await battle.assertWorkload(client, h.pool, SCHEMAS, byId, QNAMES,
    { seed: SEED, n: N, workers: WORKERS, phase: 'A' });
  await battle.assertEventsCatchUp(client, byId);
}, 180_000);
```

- [ ] **Step 3: Run the full Phase A**

Run: `npx vitest run test/battle/battle.test.ts`
Expected: PASS. On failure, the thrown error is the fingerprint — re-run with the printed seed and `BATTLE_ONLY_JOB=<id>` to isolate.

- [ ] **Step 4: Re-run with a different seed to confirm robustness**

Run: `BATTLE_SEED=1 npx vitest run test/battle/battle.test.ts` then `BATTLE_SEED=2 npx vitest run test/battle/battle.test.ts`
Expected: PASS both. (If one flakes on a cross-job assumption, that's a real bug in the oracle — fix the assertion, do not add ordering tolerance.)

- [ ] **Step 5: Commit**

```bash
git add test/battle/engine.ts test/battle/battle.test.ts
git commit -m "test(battle): Phase A — full concurrency storm + events catch-up

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Phase B (forensic-delete) + Phase C (fail-open)

**Files:**
- Modify: `test/battle/engine.ts` (add `forensicDelete`, `withAuditOutage`)
- Modify: `test/battle/battle.test.ts` (add B and C tests, ordered after A)

**Interfaces:**
- Produces:
  - `forensicDelete(pool, schemas, jobIds): Promise<number>` — returns rows deleted.
  - `withAuditOutage<T>(pool, schemas, fn): Promise<T>` — renames `record` away, runs `fn`, renames back in `finally`.

- [ ] **Step 1: Add the injectors (engine.ts)**

Append to `test/battle/engine.ts`:

```ts
// ──────────────────────────────────────────────────────────────────────────
// Chaos injectors.
// ──────────────────────────────────────────────────────────────────────────
export async function forensicDelete(
  pool: Pool, schemas: SchemaNames, jobIds: readonly string[],
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM ${schemas.pgboss}.job WHERE id = ANY($1)`, [jobIds],
  );
  return rowCount ?? 0;
}

export async function withAuditOutage<T>(
  pool: Pool, schemas: SchemaNames, fn: () => Promise<T>,
): Promise<T> {
  // Rename the chronicle table away → the trigger's INSERT fails on a missing
  // relation and is swallowed by its EXCEPTION WHEN OTHERS (fail-open). seq and
  // rows are preserved (spec Decision 1).
  await pool.query(`ALTER TABLE ${schemas.pgbossier}.record RENAME TO record__chaos`);
  try {
    return await fn();
  } finally {
    await pool.query(`ALTER TABLE ${schemas.pgbossier}.record__chaos RENAME TO record`);
  }
}
```

- [ ] **Step 2: Add Phase B + C tests (battle.test.ts)**

Append after the Phase A test:

```ts
test('Phase B — forensic survival after pgboss.job rows are deleted', async () => {
  expect(byId.size).toBeGreaterThan(0); // depends on Phase A having run
  // Sample up to 20 completed jobs from the workload.
  const sample = [...byId.entries()]
    .filter(([, p]) => p.expectedTerminalState === 'completed')
    .slice(0, 20)
    .map(([id]) => id);
  expect(sample.length).toBeGreaterThan(0);

  const deleted = await battle.forensicDelete(h.pool, SCHEMAS, sample);
  expect(deleted).toBe(sample.length);

  for (const id of sample) {
    const job = await client.findById(id);
    expect(job, `findById(${id}) after delete`).not.toBeNull();
    const plan = byId.get(id)!;
    const hist = await client.getRetryHistory(id);
    expect(hist).toHaveLength(plan.expectedAttempts);
    expect(hist.at(-1)!.state).toBe('completed');
    expect(hist[0]!.data).toEqual({ key: plan.key });
  }
}, 60_000);

test('Phase C — fail-open: pg-boss ops never block while the audit path is broken', async () => {
  const q = 'battle-failopen';
  await h.boss.createQueue(q);

  // During the outage, drive a batch end-to-end and assert NOTHING throws.
  const outageIds = await battle.withAuditOutage(h.pool, SCHEMAS, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = await h.boss.send(q, { key: `outage-${i}` });
      ids.push(id!);
    }
    for (const id of ids) {
      const fetched = await h.boss.fetch(q);
      expect(fetched && fetched.length).toBeTruthy();
    }
    // complete whatever is active (fetch returns arbitrary order)
    let drained = 0;
    while (drained < ids.length) {
      const batch = await h.boss.fetch(q, { batchSize: 20 });
      if (!batch || batch.length === 0) break;
      for (const j of batch) { await h.boss.complete(q, j.id, { ok: true }); drained++; }
    }
    return ids;
  });
  expect(outageIds).toHaveLength(15);

  // After restore, a fresh job gets a complete, faithful chronicle (recovery).
  const freshId = await h.boss.send(q, { key: 'after-restore' });
  const got = await h.boss.fetch(q);
  expect(got && got.length).toBeTruthy();
  await h.boss.complete(q, freshId!, { ok: true });

  const hist = await client.getRetryHistory(freshId!);
  expect(hist.at(-1)!.state).toBe('completed');
  expect(hist[0]!.data).toEqual({ key: 'after-restore' });
}, 60_000);
```

- [ ] **Step 3: Run B + C (and A, since they share state)**

Run: `npx vitest run test/battle/battle.test.ts`
Expected: PASS (A, B, C). Tests in one file run in declaration order under `vitest.config.ts`'s `fileParallelism: false`, so B/C see A's `byId`.

- [ ] **Step 4: Commit**

```bash
git add test/battle/engine.ts test/battle/battle.test.ts
git commit -m "test(battle): Phase B forensic-delete + Phase C fail-open

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Phase D (connection-kill, gated) + mini-cases

**Files:**
- Modify: `test/battle/engine.ts` (add `killBackends`)
- Modify: `test/battle/battle.test.ts` (add gated Phase D + singleton + dead-letter)

**Interfaces:**
- Produces: `killBackends(pool): Promise<number>` — returns count of terminated backends.

- [ ] **Step 1: Add `killBackends` (engine.ts)**

Append to `test/battle/engine.ts`:

```ts
export async function killBackends(pool: Pool): Promise<number> {
  // Terminate every other backend on this database — the pool's and pg-boss's
  // connections both reconnect on next use. The trigger fires inside pg-boss's
  // own txn, so a killed op rolls back BOTH the job change and its chronicle
  // row: complete-row-or-none, never a partial (spec Decision 6).
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(pg_terminate_backend(pid))::text AS n
     FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND datname = current_database()`,
  );
  return Number(rows[0]!.n);
}
```

- [ ] **Step 2: Add gated Phase D + mini-cases (battle.test.ts)**

Append:

```ts
const FULL = process.env.BATTLE_CHAOS_FULL === '1';

test.runIf(FULL)('Phase D — connection kill: chronicle stays consistent + recovers', { retry: 2 }, async () => {
  const QD: battle.QueueDef[] = [{ name: 'battle-killA', pattern: 'pull' }, { name: 'battle-killB', pattern: 'push' }];
  const QDN = QD.map((q) => q.name);
  const jobs = battle.planWorkload(battle.makeRng(SEED + 1), { n: 60, queues: QD });
  await battle.createQueues(h.boss, QD);
  const local = await battle.sendWorkload(h.boss, jobs);
  await battle.cancelPlanned(h.boss, local);

  const attemptsSeen = new Map<string, number>();
  await h.boss.work('battle-killB', { pollingIntervalSeconds: 0.5, teamSize: WORKERS, teamConcurrency: WORKERS },
    battle.makePushHandler(local, attemptsSeen));
  const ac = new AbortController();
  const puller = battle.runPullDriver(h.boss, h.pool, SCHEMAS, 'battle-killA', local, attemptsSeen, ac.signal);

  // Kill backends a few times mid-storm.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 400));
    await battle.killBackends(h.pool).catch(() => 0); // the kill may sever its own ack
  }

  // Best-effort settle — outcomes are NOT asserted under kill (Decision 6).
  await battle.waitForDrain(h.pool, SCHEMAS, QDN, 90_000).catch(() => { /* contract-only below */ });
  ac.abort();
  await Promise.allSettled([puller]);
  await h.boss.offWork('battle-killB');

  // Contract: no chronicle corruption (no dup PK / non-distinct seq).
  const violations = battle.findGlobalViolations(await battle.collectAllRows(h.pool, SCHEMAS, QDN));
  expect(violations, violations.join('; ')).toEqual([]);

  // Recovery: a fresh job after the storm is captured normally.
  const rq = 'battle-kill-recover';
  await h.boss.createQueue(rq);
  const rid = await h.boss.send(rq, { key: 'recovered' });
  await h.boss.fetch(rq);
  await h.boss.complete(rq, rid!, { ok: true });
  const hist = await client.getRetryHistory(rid!);
  expect(hist.at(-1)!.state).toBe('completed');
}, 180_000);

test('mini — singleton dedup collapses same-key sends to one job', async () => {
  const q = 'battle-singleton';
  await h.boss.createQueue(q);
  const id1 = await h.boss.send(q, {}, { singletonKey: 'dup' });
  const id2 = await h.boss.send(q, {}, { singletonKey: 'dup' });
  expect(id1).toBeTruthy();
  expect(id2).toBeNull(); // deduped
  expect(await client.getRetryHistory(id1!)).toHaveLength(1);
}, 60_000);

test('mini — dead-letter lineage round-trips via recordDeadLetter', async () => {
  const src = 'battle-dlq-src';
  const dlq = 'battle-dlq-dead';
  await h.boss.createQueue(dlq);
  await h.boss.createQueue(src, { deadLetter: dlq });

  const srcId = await h.boss.send(src, { key: 'dlq' }, { retryLimit: 0, deadLetter: dlq });
  await h.boss.fetch(src);
  await h.boss.fail(src, srcId!, { err: 'boom' });
  await new Promise((r) => setTimeout(r, 300)); // let pg-boss enqueue the DLQ job

  const { rows } = await h.pool.query<{ id: string }>(
    `SELECT id FROM ${SCHEMAS.pgboss}.job WHERE name = $1 ORDER BY created_on DESC LIMIT 1`, [dlq],
  );
  expect(rows).toHaveLength(1);
  const dlqId = rows[0]!.id;

  await client.recordDeadLetter({ sourceJobId: srcId!, dlqJobId: dlqId });
  expect(await client.findDeadLetterTarget(srcId!)).toMatchObject({ dlqJobId: dlqId });
  expect(await client.findDeadLetterSource(dlqId)).toMatchObject({ jobId: srcId! });
}, 60_000);
```

> **Verification note for the dead-letter mini-case:** confirm against `node_modules/pg-boss/types.d.ts` that `createQueue` accepts `{ deadLetter }` and/or `send` accepts `{ deadLetter }` in the installed version (pg-boss 12 supports queue-level dead-letter). If only queue-level is supported, drop the per-send `deadLetter` option. This is a real API check.

- [ ] **Step 3: Run default tier (D skipped) and the full tier**

Run: `npx vitest run test/battle/battle.test.ts`
Expected: PASS; Phase D shows as skipped.

Run: `BATTLE_CHAOS_FULL=1 npx vitest run test/battle/battle.test.ts`
Expected: PASS including Phase D (may use a retry).

- [ ] **Step 4: Commit**

```bash
git add test/battle/engine.ts test/battle/battle.test.ts
git commit -m "test(battle): Phase D connection-kill (gated) + dedup/dead-letter mini-cases

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: CHANGELOG + full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Under `## [Unreleased]` → `### Added` (create the section if absent), add:

```markdown
- Seeded chaos/battle-test harness (`test/battle/`): drives N jobs of varied
  shape/outcome through concurrent push + pull workers and asserts the
  `pgbossier.record` chronicle stays faithful per job, plus forensic-delete
  survival, fail-open (audit-path outage), and a gated connection-kill phase
  (`BATTLE_CHAOS_FULL=1`). Reproducible via `BATTLE_SEED`; tunable via `BATTLE_N`.
```

- [ ] **Step 2: Full verification (mirrors CI order)**

Run: `npm run lint && npm run build && npm test`
Expected: all pass. The battle file adds ~30–60 s. If lint flags `noUncheckedIndexedAccess` issues, add `!` only where provably safe (e.g. `rows[0]!` after a length check).

- [ ] **Step 3: Optional — full monkey suite locally**

Run: `BATTLE_CHAOS_FULL=1 npm test`
Expected: pass including Phase D.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): record the battle-test harness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin develop
```

---

## Self-Review

**1. Spec coverage**
- Seeded PRNG + boundary → Task 1, fingerprint replay → Task 4. ✓
- Workload variety (push/pull, retryLimit/priority/unique singletonKey, all outcomes, sendAfter-delayed) → Task 2 planner + Task 5/6 drivers. ✓ (deadLetter moved to the Task 8 mini-case to keep Phase A's oracle exact — a deliberate, spec-consistent narrowing.)
- Drivers apply plan to received job; never assume fetch identity → Task 5 `makePushHandler` / `runPullDriver`. ✓ (Decision 2)
- Transient retry + read-back reconciliation → Task 5 `withRetry` + `alreadyAdvanced`. ✓ (Decision 3)
- Phase A exact per-job-id; cross-job invariant-only; no ordering assertions → Task 4 `diffChronicle` / `findGlobalViolations`, Task 6. ✓ (Decision 4)
- Events via `getEventsSince` catch-up authority → Task 6 `assertEventsCatchUp`. ✓ (Decision 5)
- Phase B forensic-delete → Task 7. ✓
- Phase C fail-open via table rename → Task 7 `withAuditOutage`. ✓ (Decision 1)
- Phase D connection-kill, gated, contract-scoped, `retry:2` → Task 8. ✓ (Decision 6)
- Keep `mulberry32`, no fast-check → Task 1, Global Constraints. ✓ (Decision 7)
- CI tiering (A/B/C default; D gated) → Task 6/7 default, Task 8 `test.runIf(FULL)`. ✓
- Mini-cases (singleton dedup, dead-letter) → Task 8. ✓
- Real cron cut → not built (correctly absent). ✓

**2. Placeholder scan:** No TBD/TODO. The two "verification notes" are genuine API-spelling checks against the installed pg-boss `.d.ts`, with explicit fallback instructions — not hand-waves.

**3. Type consistency:** `PlannedJob`, `QueueDef`, `PerAttempt`, `RunInfo` are defined once (Tasks 2/4) and consumed with the same field names throughout. `decideAction` / `withRetry` / `runPullDriver` signatures match between definition (Task 5) and call sites (Tasks 6/8). `runPullDriver` takes `schemas` in both its definition and every call. `assertWorkload` / `assertEventsCatchUp` signatures match their calls.

**Known sequencing dependency (intentional):** Phases B and C read `byId` populated by Phase A. This relies on in-file declaration order under `fileParallelism: false` (set in `vitest.config.ts`). Phase D and the mini-cases are self-contained (own queues/data) and do not depend on A.

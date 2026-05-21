# Goal 5 — Operational Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build pg-bossier's operational read API — seven typed query methods (`findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`) on the `bossier` client, reading `pgbossier.record`, so consumers stop writing raw SQL against `pgboss.*`.

**Architecture:** All reads are `SELECT … FROM pgbossier.record` — single source. A new `src/read.ts` holds the `JobRecord` type (a discriminated union on `state`), a row mapper, and the seven query functions; `src/client.ts` wires them onto the `bossier` client, bound to its `pg.Pool`. Methods that need one row per job use an inline `DISTINCT ON (job_id)` "current view" CTE. Full design: `docs/superpowers/specs/2026-05-21-goal-5-read-api-spec.md`.

**Tech Stack:** TypeScript (strict, ESM, `NodeNext`, `noUncheckedIndexedAccess`) · `pg` · `vitest` · `@testcontainers/postgresql` · pg-boss 12.18.2.

---

## Before you start

- **Work on a branch, never `main`.** Per `CLAUDE.md`, create a worktree first:
  `git worktree add .worktrees/feat-goal-5-read-api -b feat/goal-5-read-api`, then `cd` into it and `npm install`. Every commit in this plan lands on `feat/goal-5-read-api`.
- **These are integration tests against a real Postgres + pg-boss** (via testcontainers) — no mocks. Docker must be running. The suite is slow (~10–30s container startup per file).
- **All SQL is lifted from the buildable spec** (`docs/superpowers/specs/2026-05-21-goal-5-read-api-spec.md`).
- The substrate (v0.1.1) already ships: `pgbossier.record`, the capture trigger, `install()`/`uninstall()`, and `bossier({ boss, pool })` returning `{ boss, recordPatch }`. This plan extends that client.
- **Test isolation:** all tests in `test/read.test.ts` share one container + one `install()` (`beforeAll`). `pgbossier.record` accumulates rows across tests, so **every test uses a unique queue name and filters its reads by that queue** — otherwise one test's jobs pollute another's counts/lists.
- Run `npm run lint && npm run build` before the final task's commit.

## File structure

| Path | Created/Modified | Responsibility |
|---|---|---|
| `src/sql.ts` | Modify | Append `record_active_idx` to `RECORD_INDEXES_SQL` |
| `src/read.ts` | Create | `JobRecord`/`JobState`/`JobFilter`/`ListJobsOpts` types, the row mapper, the seven query functions |
| `src/client.ts` | Modify | `bossier()` wires the seven methods onto the client |
| `src/index.ts` | Modify | Re-export the new public types |
| `test/install.test.ts` | Modify | Assert the new index exists |
| `test/read.test.ts` | Create | Integration tests, one block per method |
| `test/client.test.ts` | Modify | Assert the client exposes the read methods |

---

### Task 1: Add the `record_active_idx` partial index

**Files:**
- Modify: `src/sql.ts`
- Modify: `test/install.test.ts`

- [ ] **Step 1: Add the failing index assertion**

Append to `test/install.test.ts`:
```typescript
test('install creates the record_active_idx partial index', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  expect(rows.map((r) => r.indexname)).toContain('record_active_idx');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/install.test.ts`
Expected: FAIL — `record_active_idx` not found.

- [ ] **Step 3: Append the index to `RECORD_INDEXES_SQL` in `src/sql.ts`**

`RECORD_INDEXES_SQL` is a `readonly string[]`. Add this as a new final element of the array:
```typescript
  `CREATE INDEX IF NOT EXISTS record_active_idx ON pgbossier.record (queue, started_on) WHERE state = 'active';`,
```

A **partial** index — it only holds currently-active rows, so it stays small even as `pgbossier.record` grows unbounded. `install()` already loops `RECORD_INDEXES_SQL`, so no change to `install.ts` is needed; an existing install picks the index up on its next `install()` run (`CREATE INDEX IF NOT EXISTS` is idempotent).

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/install.test.ts`
Expected: PASS — all install tests green.

- [ ] **Step 5: Commit**

```bash
git add src/sql.ts test/install.test.ts
git commit -m "feat: add record_active_idx partial index for active-job reads"
```

---

### Task 2: `src/read.ts` foundation + `findById`

**Files:**
- Create: `src/read.ts`
- Create: `test/read.test.ts`

- [ ] **Step 1: Write the failing `findById` test**

`test/read.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { findById } from '../src/read.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('findById returns the latest attempt of a job', async () => {
  const queue = 'read-findbyid';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { n: 1 });

  const job = await findById(h.pool, jobId!);
  expect(job).not.toBeNull();
  expect(job!.jobId).toBe(jobId);
  expect(job!.queue).toBe(queue);
  expect(job!.state).toBe('created');
  expect(job!.attempt).toBe(0);
  expect(job!.data).toEqual({ n: 1 });
});

test('findById returns null for an unknown job id', async () => {
  const job = await findById(h.pool, '00000000-0000-0000-0000-000000000000');
  expect(job).toBeNull();
});

test('findById returns null for a malformed job id (no Postgres error)', async () => {
  const job = await findById(h.pool, 'not-a-uuid');
  expect(job).toBeNull();
});

test('findById returns the current attempt of a retried job, not attempt 0', async () => {
  const queue = 'read-findbyid-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'first' });   // attempt 0 -> retry
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });    // attempt 1 -> completed

  const job = await findById(h.pool, jobId!);
  expect(job!.attempt).toBe(1);
  expect(job!.state).toBe('completed');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — cannot resolve `../src/read.js`.

- [ ] **Step 3: Create `src/read.ts`**

```typescript
import type { Pool } from 'pg';

export type JobState =
  | 'created' | 'active' | 'retry' | 'completed' | 'cancelled' | 'failed';

interface RecordShared<TInput> {
  jobId: string;
  queue: string;
  attempt: number;
  data: TInput | null;
  progress: unknown;
  inputSnapshot: unknown;
  createdOn: Date | null;
  startedOn: Date | null;
  completedOn: Date | null;
  capturedAt: Date;
}

/** One attempt's row. Discriminated on `state` — `output` differs per state. */
export type JobRecord<TInput = unknown, TOutput = unknown> =
  | (RecordShared<TInput> & { state: 'created' | 'active'; output: null;           terminalDetail: null })
  | (RecordShared<TInput> & { state: 'retry' | 'failed';   output: unknown;        terminalDetail: unknown })
  | (RecordShared<TInput> & { state: 'completed';          output: TOutput | null; terminalDetail: unknown })
  | (RecordShared<TInput> & { state: 'cancelled';          output: unknown;        terminalDetail: unknown });

export interface JobFilter {
  queue?: string;
  queues?: string[];
  states?: JobState[];
  createdAfter?: Date;
  createdBefore?: Date;
  completedAfter?: Date;
  completedBefore?: Date;
}

export interface ListJobsOpts extends JobFilter {
  orderBy?: 'createdOn' | 'completedOn' | 'capturedAt';
  limit?: number;
  offset?: number;
}

interface RawRecordRow {
  job_id: string;
  queue: string;
  attempt: number;
  state: JobState;
  data: unknown;
  output: unknown;
  progress: unknown;
  terminal_detail: unknown;
  input_snapshot: unknown;
  created_on: Date | null;
  started_on: Date | null;
  completed_on: Date | null;
  captured_at: Date;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a raw snake_case DB row to a camelCase `JobRecord`. The single `as` cast
 * is the controlled DB boundary: the state-to-output correlation is a runtime
 * invariant TypeScript cannot verify.
 */
function mapRecord<TInput = unknown, TOutput = unknown>(
  r: RawRecordRow,
): JobRecord<TInput, TOutput> {
  return {
    jobId: r.job_id,
    queue: r.queue,
    attempt: r.attempt,
    state: r.state,
    data: r.data,
    output: r.output,
    progress: r.progress,
    terminalDetail: r.terminal_detail,
    inputSnapshot: r.input_snapshot,
    createdOn: r.created_on,
    startedOn: r.started_on,
    completedOn: r.completed_on,
    capturedAt: r.captured_at,
  } as JobRecord<TInput, TOutput>;
}

/** A job's latest attempt, across all queues. `null` if never captured. */
export async function findById<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  jobId: string,
): Promise<JobRecord<TInput, TOutput> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM pgbossier.record
     WHERE job_id = $1
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  return rows[0] ? mapRecord<TInput, TOutput>(rows[0]) : null;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS — all four `findById` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add read API foundation and findById"
```

---

### Task 3: `getRetryHistory`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/read.test.ts` (and add `getRetryHistory` to the `../src/read.js` import):
```typescript
test('getRetryHistory returns every attempt of a job, oldest first', async () => {
  const queue = 'read-history';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 2 });

  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-0' });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-1' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const history = await getRetryHistory(h.pool, jobId!);
  expect(history.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(history[2]!.state).toBe('completed');
});

test('getRetryHistory returns an empty array for an unknown job id', async () => {
  const history = await getRetryHistory(h.pool, '00000000-0000-0000-0000-000000000000');
  expect(history).toEqual([]);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `getRetryHistory` is not exported.

- [ ] **Step 3: Append `getRetryHistory` to `src/read.ts`**

```typescript
/** Every attempt of a job, oldest first. `[]` if unknown. */
export async function getRetryHistory<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  jobId: string,
): Promise<JobRecord<TInput, TOutput>[]> {
  if (!UUID_RE.test(jobId)) return [];
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM pgbossier.record
     WHERE job_id = $1
     ORDER BY attempt ASC`,
    [jobId],
  );
  return rows.map((r) => mapRecord<TInput, TOutput>(r));
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add getRetryHistory read method"
```

---

### Task 4: `listJobs` + the shared query helpers

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/read.test.ts` (add `listJobs` to the import):
```typescript
test('listJobs filters by queue and reports an accurate total', async () => {
  const queue = 'read-list';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 5; i++) await h.boss.send(queue, { i });

  const result = await listJobs(h.pool, { queue });
  expect(result.total).toBe(5);
  expect(result.rows).toHaveLength(5);
  expect(result.rows.every((r) => r.queue === queue)).toBe(true);
});

test('listJobs paginates without overlap and total is independent of limit', async () => {
  const queue = 'read-list-page';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 6; i++) await h.boss.send(queue, { i });

  const page1 = await listJobs(h.pool, { queue, limit: 2, offset: 0 });
  const page2 = await listJobs(h.pool, { queue, limit: 2, offset: 2 });
  expect(page1.total).toBe(6);
  expect(page2.total).toBe(6);
  const ids1 = page1.rows.map((r) => r.jobId);
  const ids2 = page2.rows.map((r) => r.jobId);
  expect(ids1).toHaveLength(2);
  expect(ids2).toHaveLength(2);
  expect(ids1.some((id) => ids2.includes(id))).toBe(false);
});

test('listJobs filters by state and counts a retried job once', async () => {
  const queue = 'read-list-state';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const result = await listJobs(h.pool, { queue, states: ['completed'] });
  expect(result.total).toBe(1);
  expect(result.rows[0]!.jobId).toBe(jobId);
});

test('listJobs returns an empty result for a queue with no jobs', async () => {
  const result = await listJobs(h.pool, { queue: 'read-list-empty' });
  expect(result).toEqual({ rows: [], total: 0 });
});

test('listJobs filters by a creation-time window', async () => {
  const queue = 'read-list-window';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) await h.boss.send(queue, { i });

  const hourAgo = new Date(Date.now() - 3_600_000);
  const hourAhead = new Date(Date.now() + 3_600_000);
  const recent = await listJobs(h.pool, { queue, createdAfter: hourAgo });
  expect(recent.total).toBe(3);
  const future = await listJobs(h.pool, { queue, createdAfter: hourAhead });
  expect(future.total).toBe(0);
});

test('listJobs rejects a non-positive limit', async () => {
  await expect(listJobs(h.pool, { limit: 0 })).rejects.toThrow();
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `listJobs` is not exported.

- [ ] **Step 3: Append the shared helpers and `listJobs` to `src/read.ts`**

```typescript
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** `WITH` body: the latest-attempt row of every job. */
const RECORD_CURRENT = `
  current AS (
    SELECT DISTINCT ON (job_id) *
    FROM pgbossier.record
    ORDER BY job_id, attempt DESC
  )`;

const ORDER_COLUMNS = {
  createdOn: 'created_on',
  completedOn: 'completed_on',
  capturedAt: 'captured_at',
} as const;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_LIMIT);
}

function resolveOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got ${String(offset)}`);
  }
  return offset;
}

/** Turn a JobFilter into a parameterized WHERE clause. Params start at $1. */
function buildWhere(filter: JobFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const next = (): string => `$${params.length + 1}`;

  if (filter.queue !== undefined) {
    conds.push(`queue = ${next()}`);
    params.push(filter.queue);
  } else if (filter.queues !== undefined) {
    conds.push(`queue = ANY(${next()})`);
    params.push(filter.queues);
  }
  if (filter.states !== undefined) {
    conds.push(`state = ANY(${next()})`);
    params.push(filter.states);
  }
  if (filter.createdAfter !== undefined) {
    conds.push(`created_on >= ${next()}`);
    params.push(filter.createdAfter);
  }
  if (filter.createdBefore !== undefined) {
    conds.push(`created_on < ${next()}`);
    params.push(filter.createdBefore);
  }
  if (filter.completedAfter !== undefined) {
    conds.push(`completed_on >= ${next()}`);
    params.push(filter.completedAfter);
  }
  if (filter.completedBefore !== undefined) {
    conds.push(`completed_on < ${next()}`);
    params.push(filter.completedBefore);
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** Filtered, paginated job list over the current view, with an exact total. */
export async function listJobs<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  opts: ListJobsOpts = {},
): Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }> {
  const limit = resolveLimit(opts.limit);
  const offset = resolveOffset(opts.offset);
  const orderCol = ORDER_COLUMNS[opts.orderBy ?? 'createdOn'];
  const { clause, params } = buildWhere(opts);
  const { rows } = await pool.query<RawRecordRow & { total_count: string }>(
    `WITH ${RECORD_CURRENT}
     SELECT *, count(*) OVER () AS total_count
     FROM current
     ${clause}
     ORDER BY ${orderCol} DESC NULLS LAST, job_id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
  return { rows: rows.map((r) => mapRecord<TInput, TOutput>(r)), total };
}
```

`orderCol` is a value from the fixed `ORDER_COLUMNS` whitelist — never consumer input — so interpolating it is injection-safe; every other value is a positional parameter.

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS — all five `listJobs` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add listJobs read method with filtering and pagination"
```

---

### Task 5: `latestPerQueue`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/read.test.ts` (add `latestPerQueue` to the import):
```typescript
test('latestPerQueue returns the most recent job per queue', async () => {
  const qa = 'read-lpq-a';
  const qb = 'read-lpq-b';
  await h.boss.createQueue(qa);
  await h.boss.createQueue(qb);
  await h.boss.send(qa, { first: true });
  const lastA = await h.boss.send(qa, { last: true });
  const lastB = await h.boss.send(qb, { only: true });

  const rows = await latestPerQueue(h.pool, [qa, qb]);
  const byQueue = new Map(rows.map((r) => [r.queue, r]));
  expect(byQueue.get(qa)!.jobId).toBe(lastA);
  expect(byQueue.get(qb)!.jobId).toBe(lastB);
});

test('latestPerQueue returns an empty array for an empty queue list', async () => {
  const rows = await latestPerQueue(h.pool, []);
  expect(rows).toEqual([]);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `latestPerQueue` is not exported.

- [ ] **Step 3: Append `latestPerQueue` to `src/read.ts`**

```typescript
/** The single most-recently-created job in each queue, at its current state. */
export async function latestPerQueue(
  pool: Pool,
  queues: string[],
  opts: { states?: JobState[] } = {},
): Promise<JobRecord[]> {
  if (queues.length === 0) return [];
  const params: unknown[] = [queues];
  let stateClause = '';
  if (opts.states !== undefined) {
    params.push(opts.states);
    stateClause = `AND state = ANY($${params.length})`;
  }
  const { rows } = await pool.query<RawRecordRow>(
    `WITH ${RECORD_CURRENT}
     SELECT DISTINCT ON (queue) *
     FROM current
     WHERE queue = ANY($1) ${stateClause}
     ORDER BY queue, created_on DESC, job_id`,
    params,
  );
  return rows.map((r) => mapRecord(r));
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add latestPerQueue read method"
```

---

### Task 6: `countByState`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/read.test.ts` (add `countByState` to the import):
```typescript
test('countByState counts each job once by its current state, all six keys present', async () => {
  const queue = 'read-cbs';
  await h.boss.createQueue(queue);

  // 2 completed (send+fetch+complete each, no other jobs in queue yet)
  for (let i = 0; i < 2; i++) {
    const id = await h.boss.send(queue, {});
    await h.boss.fetch(queue);
    await h.boss.complete(queue, id!, {});
  }
  // 1 retried-then-completed -> current state is 'completed', not 'retry'
  const retried = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, retried!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, retried!, {});
  // 1 created — sent last so the fetch+complete calls above cannot race with it
  await h.boss.send(queue, {});

  const counts = await countByState(h.pool, { queue });
  expect(counts).toEqual({
    created: 1, active: 0, retry: 0, completed: 3, cancelled: 0, failed: 0,
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `countByState` is not exported.

- [ ] **Step 3: Append `countByState` to `src/read.ts`**

```typescript
const ALL_STATES: readonly JobState[] = [
  'created', 'active', 'retry', 'completed', 'cancelled', 'failed',
];

/** Job counts by current state. Zero-fills all six states. */
export async function countByState(
  pool: Pool,
  filter: JobFilter = {},
): Promise<Record<JobState, number>> {
  const { clause, params } = buildWhere(filter);
  const { rows } = await pool.query<{ state: JobState; count: number }>(
    `WITH ${RECORD_CURRENT}
     SELECT state, count(*)::int AS count
     FROM current
     ${clause}
     GROUP BY state`,
    params,
  );
  const result = Object.fromEntries(
    ALL_STATES.map((s) => [s, 0]),
  ) as Record<JobState, number>;
  for (const row of rows) result[row.state] = row.count;
  return result;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add countByState read method"
```

---

### Task 7: `countByQueue`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/read.test.ts` (add `countByQueue` to the import):
```typescript
test('countByQueue counts jobs per queue, with a state filter', async () => {
  const qa = 'read-cbq-a';
  const qb = 'read-cbq-b';
  await h.boss.createQueue(qa);
  await h.boss.createQueue(qb);
  // qa: 2 failed, 1 created
  for (let i = 0; i < 2; i++) {
    const id = await h.boss.send(qa, {}, { retryLimit: 0 });
    await h.boss.fetch(qa);
    await h.boss.fail(qa, id!, { err: 'x' });
  }
  await h.boss.send(qa, {});
  // qb: 1 failed
  const id = await h.boss.send(qb, {}, { retryLimit: 0 });
  await h.boss.fetch(qb);
  await h.boss.fail(qb, id!, { err: 'x' });

  const counts = await countByQueue(h.pool, {
    queues: [qa, qb],
    states: ['failed'],
  });
  expect(counts).toEqual({ [qa]: 2, [qb]: 1 });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `countByQueue` is not exported.

- [ ] **Step 3: Append `countByQueue` to `src/read.ts`**

```typescript
/** Job counts by queue. */
export async function countByQueue(
  pool: Pool,
  filter: JobFilter = {},
): Promise<Record<string, number>> {
  const { clause, params } = buildWhere(filter);
  const { rows } = await pool.query<{ queue: string; count: number }>(
    `WITH ${RECORD_CURRENT}
     SELECT queue, count(*)::int AS count
     FROM current
     ${clause}
     GROUP BY queue`,
    params,
  );
  const result: Record<string, number> = {};
  for (const row of rows) result[row.queue] = row.count;
  return result;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add countByQueue read method"
```

---

### Task 8: `listLongRunning`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `test/read.test.ts` (add `listLongRunning` to the import):
```typescript
test('listLongRunning returns active jobs older than the threshold', async () => {
  const queue = 'read-llr';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active

  // threshold 0: any active job (started in the past) qualifies
  const running = await listLongRunning(h.pool, { queue, longerThanSeconds: 0 });
  expect(running.map((r) => r.jobId)).toContain(jobId);
  expect(running.every((r) => r.state === 'active')).toBe(true);
});

test('listLongRunning excludes a freshly-started job under a large threshold', async () => {
  const queue = 'read-llr-fresh';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active, started just now

  const running = await listLongRunning(h.pool, { queue, longerThanSeconds: 3600 });
  expect(running).toHaveLength(0);
});

test('listLongRunning query is served by record_active_idx, not a seq scan', async () => {
  const client = await h.pool.connect();
  try {
    // SET LOCAL is transaction-scoped, so this runs inside an explicit
    // transaction; disabling seq scans makes the assertion deterministic on a
    // tiny test table, where the planner would otherwise prefer a seq scan.
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT * FROM pgbossier.record
       WHERE state = 'active' AND queue = $1
         AND started_on < now() - make_interval(secs => $2)
       ORDER BY started_on ASC, job_id
       LIMIT 100`,
      ['read-llr', 0],
    );
    const plan = JSON.stringify(rows[0]!['QUERY PLAN']);
    expect(plan).toContain('record_active_idx');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/read.test.ts`
Expected: FAIL — `listLongRunning` is not exported.

- [ ] **Step 3: Append `listLongRunning` to `src/read.ts`**

```typescript
const DEFAULT_LONG_RUNNING_SECONDS = 900;

/** Active jobs whose started_on is older than a threshold (default 900s). */
export async function listLongRunning(
  pool: Pool,
  opts: { queue?: string; longerThanSeconds?: number; limit?: number } = {},
): Promise<JobRecord[]> {
  const limit = resolveLimit(opts.limit);
  const seconds = opts.longerThanSeconds ?? DEFAULT_LONG_RUNNING_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `longerThanSeconds must be a non-negative number, got ${String(seconds)}`,
    );
  }
  const params: unknown[] = [seconds];
  let queueClause = '';
  if (opts.queue !== undefined) {
    params.push(opts.queue);
    queueClause = `AND queue = $${params.length}`;
  }
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM pgbossier.record
     WHERE state = 'active' ${queueClause}
       AND started_on < now() - make_interval(secs => $1)
     ORDER BY started_on ASC, job_id
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return rows.map((r) => mapRecord(r));
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/read.test.ts`
Expected: PASS — all three tests green, including the index-use assertion.

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat: add listLongRunning read method"
```

---

### Task 9: Wire the methods onto the `bossier` client + export types

**Files:**
- Modify: `src/client.ts`
- Modify: `src/index.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Add the failing client test**

Append to `test/client.test.ts`:
```typescript
test('the client exposes the read methods bound to its pool', async () => {
  const queue = 'client-read';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { via: 'client' });

  const client = bossier({ boss: h.boss, pool: h.pool });
  const job = await client.findById(jobId!);
  expect(job!.jobId).toBe(jobId);

  const listed = await client.listJobs({ queue });
  expect(listed.total).toBe(1);

  expect(typeof client.getRetryHistory).toBe('function');
  expect(typeof client.latestPerQueue).toBe('function');
  expect(typeof client.countByState).toBe('function');
  expect(typeof client.countByQueue).toBe('function');
  expect(typeof client.listLongRunning).toBe('function');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/client.test.ts`
Expected: FAIL — `client.findById` is not a function.

- [ ] **Step 3: Wire the methods in `src/client.ts`**

Replace the entire contents of `src/client.ts` with:
```typescript
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
} from './read.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
}

export interface BossierClient {
  /** The underlying pg-boss instance — its queue ops are used unchanged. */
  boss: PgBoss;
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
  /** A job's latest attempt, across all queues. `null` if never captured. */
  findById: <TInput = unknown, TOutput = unknown>(
    jobId: string,
  ) => Promise<JobRecord<TInput, TOutput> | null>;
  /** Every attempt of a job, oldest first. */
  getRetryHistory: <TInput = unknown, TOutput = unknown>(
    jobId: string,
  ) => Promise<JobRecord<TInput, TOutput>[]>;
  /** Filtered, paginated job list with an exact total. */
  listJobs: <TInput = unknown, TOutput = unknown>(
    opts?: ListJobsOpts,
  ) => Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }>;
  /** The most recent job in each queue, at its current state. */
  latestPerQueue: (
    queues: string[],
    opts?: { states?: JobState[] },
  ) => Promise<JobRecord[]>;
  /** Job counts by current state (all six keys present). */
  countByState: (filter?: JobFilter) => Promise<Record<JobState, number>>;
  /** Job counts by queue. */
  countByQueue: (filter?: JobFilter) => Promise<Record<string, number>>;
  /** Active jobs running longer than a threshold. */
  listLongRunning: (
    opts?: { queue?: string; longerThanSeconds?: number; limit?: number },
  ) => Promise<JobRecord[]>;
}

/**
 * The pg-bossier client: the pg-boss instance for queue ops, `recordPatch` for
 * the app-hook columns, and the Goal 5 operational read methods. All reads run
 * on the supplied `pool`.
 */
export function bossier(options: BossierOptions): BossierClient {
  const { boss, pool } = options;
  return {
    boss,
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, jobId, attempt, patch),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(pool, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(pool, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(pool, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(pool, queues, opts),
    countByState: (filter) => countByState(pool, filter),
    countByQueue: (filter) => countByQueue(pool, filter),
    listLongRunning: (opts) => listLongRunning(pool, opts),
  };
}
```

- [ ] **Step 4: Re-export the new types from `src/index.ts`**

Replace the entire contents of `src/index.ts` with:
```typescript
export { install, uninstall } from './install.js';
export { bossier } from './client.js';
export type { BossierClient, BossierOptions } from './client.js';
export type { RecordPatch } from './record.js';
export type { JobRecord, JobState, JobFilter, ListJobsOpts } from './read.js';
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -- test/client.test.ts`
Expected: PASS — all client tests green.

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "feat: wire read methods onto the bossier client and export types"
```

---

### Task 10: Final verification

**Files:** none — verification only.

- [ ] **Step 1: Verify the build compiles**

Run: `npm run build`
Expected: `tsc` exits 0; `dist/` contains `read.js` + `read.d.ts` alongside the existing modules.

- [ ] **Step 2: Verify lint passes**

Run: `npm run lint`
Expected: exits 0. If `no-floating-promises` flags anything, every `pool.query` / `client.query` call must be `await`ed.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: every test file passes — smoke, harness, install, capture, backfill, uninstall, client, read.

- [ ] **Step 4: Commit (only if Steps 1–3 produced fixes)**

If a fix was needed:
```bash
git add -A
git commit -m "fix: address build/lint/test issues in the read API"
```
If nothing changed, skip this step.

---

## Done condition

- `npm run lint && npm run build && npm test` all pass.
- `bossier({ boss, pool })` exposes `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning` alongside `boss` and `recordPatch`.
- Reads come only from `pgbossier.record`; `JobRecord` is a discriminated union on `state`.
- `install()` creates `record_active_idx`; `listLongRunning` uses it.
- Public types `JobRecord` / `JobState` / `JobFilter` / `ListJobsOpts` are exported from the package root.

## After this plan

Per `CLAUDE.md`'s worktree workflow: from the main checkout, `git checkout main && git merge --no-ff feat/goal-5-read-api`. Goal 5 is a feature → **minor** version bump: `0.1.1` → `0.2.0`. Bump `package.json` (use `npm version 0.2.0 --no-git-tag-version` so `package-lock.json` stays in sync) and add the `CHANGELOG.md` entry — rename `[Unreleased]` to `[0.2.0] - <date>`, open a fresh `[Unreleased]` — in the merge commit. Push, then `git worktree remove .worktrees/feat-goal-5-read-api` and `git branch -d feat/goal-5-read-api`.

Then update issue #6 (mark Goal 5's read API delivered) and issue #1's Implementation progress. The remaining Goal 5 work — `search()`, `peek`, `getActiveWorkers` — is deferred per the design doc and is not part of this plan.

## Notes for the executor

- **Docker must be running** — every test file except `smoke` starts a Postgres container.
- **Every `read.test.ts` test uses a unique queue and filters its reads by that queue.** The shared `pgbossier.record` table accumulates rows across tests in the file; an unfiltered `listJobs()` / `countByState()` would see other tests' jobs.
- **`count(*) OVER ()`** returns `bigint`, which `pg` delivers as a string — hence `Number(rows[0].total_count)`. `count(*)::int` returns a JS number directly.
- The single `as` cast in `mapRecord` is deliberate (see its doc comment) — the state-to-`output` correlation is a runtime invariant `tsc` cannot prove. Do not scatter more casts; map through `mapRecord`.
- If a read returns unexpected rows, suspect a missing queue filter in the *test*, not the method.
- `make_interval(secs => $1)` takes the threshold as a number parameter — never interpolate it.

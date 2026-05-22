# pg-bossier Goal 5 — Operational Read API — Buildable Spec

- **Status:** Draft — buildable spec, awaiting review
- **Date:** 2026-05-21
- **Author:** elfensky, with claude-code
- **Builds on:** `2026-05-21-goal-5-read-api-design.md` (the approved design, v2) and the shipped substrate (v0.1.1)
- **Implements:** sub-issue [#6](https://github.com/elfensky/pg-bossier/issues/6) — Goal 5, New APIs

## Scope

The **buildable** spec — exact SQL, exact types, file layout — for the seven operational read methods. The design doc settled *what* and *why*; this settles *how to build it*.

**In scope:** the `JobRecord` type module, the row mapper, the exact SQL of all seven methods, the one schema addition (a partial index), client wiring, input validation, the test matrix.

**Out of scope:** `search()` / `peek` (deferred per the design); `getActiveWorkers` (dropped — worker identity is out of scope); the `Job<TInput,TOutput>` registration system (#13); lifecycle events (#8).

## File layout

| File | Change |
|---|---|
| `src/read.ts` | **new** — the seven query functions, the `JobRecord` / `JobState` / `JobFilter` / `ListJobsOpts` types, the row mapper |
| `src/sql.ts` | **edit** — add `record_active_idx` to `RECORD_INDEXES_SQL` |
| `src/client.ts` | **edit** — `bossier()` wires the seven methods onto the returned client, bound to its `pool` (exactly as it already wires `recordPatch`) |
| `src/index.ts` | **edit** — re-export the public types (`JobRecord`, `JobState`, `JobFilter`, `ListJobsOpts`) |
| `test/read.test.ts` | **new** — integration tests, one block per method |

No new DB schema object beyond the one index — the per-job "current view" is an **inline CTE**, not a SQL view (keeps all query logic in `src/`, nothing extra for `uninstall` to drop, no schema-versioning question).

## Schema addition

One index, appended to `RECORD_INDEXES_SQL` in `src/sql.ts` so the idempotent `install()` creates it (existing v0.1.1 installs pick it up on the next `install()` run):

```sql
CREATE INDEX IF NOT EXISTS record_active_idx
  ON pgbossier.record (queue, started_on)
  WHERE state = 'active';
```

A **partial** index — it only ever holds currently-active rows, so it stays small forever even though `pgbossier.record` grows unbounded. It serves `listLongRunning` and `listJobs` filtered to `active`.

## The current-view CTE

Most methods need one row **per job** (its latest attempt), not per attempt. This is a shared SQL fragment, defined once as a TS constant in `src/read.ts`:

```sql
WITH current AS (
  SELECT DISTINCT ON (job_id) *
  FROM pgbossier.record
  ORDER BY job_id, attempt DESC
)
```

`DISTINCT ON (job_id) … ORDER BY job_id, attempt DESC` is an index-ordered scan of the PK `(job_id, attempt)` — no sort node. `findById`, `getRetryHistory`, and `listLongRunning` do **not** use it (see each method); the other four do.

**Invariant worth recording** (a future optimization lever, tracked in #12): rows in state `created` / `active` / `completed` / `cancelled` / `failed` are *always* their job's latest attempt — only a `retry` row can be non-latest. So a query filtered to non-`retry` states is correct against the raw table without the CTE. v1 keeps the single CTE-based code path for simplicity; #12 may push the filter down later.

## Types — `src/read.ts`

```ts
export type JobState =
  | 'created' | 'active' | 'retry' | 'completed' | 'cancelled' | 'failed';

interface RecordShared<TInput> {
  jobId: string;
  queue: string;
  attempt: number;            // 0 = first try
  data: TInput | null;        // pg-boss permits a job with no data
  progress: unknown;          // app-hook column; Goal 6 (#7) refines
  inputSnapshot: unknown;     // app-hook column; Goal 4 (#5) refines
  createdOn: Date | null;
  startedOn: Date | null;
  completedOn: Date | null;
  capturedAt: Date;           // first capture of THIS attempt row — not a freshness signal
}

/** One attempt's row. Discriminated on `state` — `output` differs per state. */
export type JobRecord<TInput = unknown, TOutput = unknown> =
  | (RecordShared<TInput> & { state: 'created' | 'active'; output: null;           terminalDetail: null })
  | (RecordShared<TInput> & { state: 'retry' | 'failed';   output: unknown;        terminalDetail: unknown })  // output = this attempt's error
  | (RecordShared<TInput> & { state: 'completed';          output: TOutput | null; terminalDetail: unknown })
  | (RecordShared<TInput> & { state: 'cancelled';          output: unknown;        terminalDetail: unknown });

/** WHERE-able filters, shared by listJobs / countByState / countByQueue. */
export interface JobFilter {
  queue?: string;             // single queue; takes precedence over `queues`
  queues?: string[];          // any-of queues
  states?: JobState[];        // any-of states
  createdAfter?: Date;   createdBefore?: Date;
  completedAfter?: Date; completedBefore?: Date;
}

export interface ListJobsOpts extends JobFilter {
  orderBy?: 'createdOn' | 'completedOn' | 'capturedAt';  // default 'createdOn'; always DESC
  limit?: number;             // default 100; hard cap 1000
  offset?: number;            // default 0
}
```

`terminalDetail` stays `unknown` — Goal 2 (#3) defines the discriminated `TerminalDetail` type, which `JobRecord` adopts later without a signature change.

### The row mapper

node-postgres returns rows with snake_case keys, `jsonb` → JS value, `timestamptz` → `Date`, `uuid` → string, `integer` → number. One mapper at the DB boundary:

```ts
interface RawRecordRow {
  job_id: string; queue: string; attempt: number; state: JobState;
  data: unknown; output: unknown; progress: unknown;
  terminal_detail: unknown; input_snapshot: unknown;
  created_on: Date | null; started_on: Date | null;
  completed_on: Date | null; captured_at: Date;
}

function mapRecord(r: RawRecordRow): JobRecord {
  return {
    jobId: r.job_id, queue: r.queue, attempt: r.attempt, state: r.state,
    data: r.data, output: r.output, progress: r.progress,
    terminalDetail: r.terminal_detail, inputSnapshot: r.input_snapshot,
    createdOn: r.created_on, startedOn: r.started_on,
    completedOn: r.completed_on, capturedAt: r.captured_at,
  } as JobRecord;  // single controlled cast: the state↔output correlation is a DB invariant TS cannot verify
}
```

## The seven methods — signatures and exact SQL

Each method is `function name(pool: Pool, …args): Promise<…>` in `src/read.ts`; `bossier()` binds `pool` and exposes the rest. Parameters are always passed positionally (`$1`, `$2`, …) — never string-interpolated.

### `findById`

```ts
findById<TInput = unknown, TOutput = unknown>(jobId: string)
  : Promise<JobRecord<TInput, TOutput> | null>
```

```sql
SELECT * FROM pgbossier.record
WHERE job_id = $1
ORDER BY attempt DESC
LIMIT 1;
```

Served by the PK `(job_id, attempt)` (leading-column predicate + index-ordered `attempt DESC`). 0 rows → `null`. A returned `state: 'retry'` is valid — it means "this attempt failed; the job awaits its next attempt." **Validation:** if `jobId` does not match the UUID shape, return `null` without querying (avoids leaking a Postgres cast error).

### `getRetryHistory`

```ts
getRetryHistory<TInput = unknown, TOutput = unknown>(jobId: string)
  : Promise<JobRecord<TInput, TOutput>[]>
```

```sql
SELECT * FROM pgbossier.record
WHERE job_id = $1
ORDER BY attempt ASC;
```

All attempt rows, oldest first. Satisfies success criterion #2 in one query — current state is `result.at(-1)`. Unknown id → `[]`. Non-UUID `jobId` → `[]`. One row per attempt, each at that attempt's final captured state; intra-attempt transitions are not separate rows.

### `listJobs`

```ts
listJobs<TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts)
  : Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }>
```

Build a `WHERE` from `opts` (see Filter construction). `total` comes from a window aggregate, so it is one round-trip:

```sql
WITH current AS (
  SELECT DISTINCT ON (job_id) * FROM pgbossier.record ORDER BY job_id, attempt DESC
)
SELECT *, count(*) OVER () AS total_count
FROM current
WHERE <conditions>            -- omitted entirely when no filters
ORDER BY <order_col> DESC NULLS LAST, job_id
LIMIT $L OFFSET $O;
```

`<order_col>`: `created_on` (default) / `completed_on` / `captured_at`. The trailing `job_id` makes paging deterministic. `total` = `total_count` of any returned row; if 0 rows, `total = 0`. `count(*) OVER ()` is computed over the full filtered set before `LIMIT`, so the total is exact.

### `latestPerQueue`

```ts
latestPerQueue(queues: string[], opts?: { states?: JobState[] })
  : Promise<JobRecord[]>
```

The single most-recently-created job in each queue, at its current state:

```sql
WITH current AS (
  SELECT DISTINCT ON (job_id) * FROM pgbossier.record ORDER BY job_id, attempt DESC
)
SELECT DISTINCT ON (queue) *
FROM current
WHERE queue = ANY($1)
  [AND state = ANY($2)]
ORDER BY queue, created_on DESC, job_id;
```

Empty `queues` → `[]` (no query). Returns at most one row per queue; a queue with no jobs is simply absent.

### `countByState`

```ts
countByState(filter?: JobFilter): Promise<Record<JobState, number>>
```

```sql
WITH current AS (
  SELECT DISTINCT ON (job_id) * FROM pgbossier.record ORDER BY job_id, attempt DESC
)
SELECT state, count(*)::int AS count
FROM current
WHERE <conditions>
GROUP BY state;
```

Each job counted once, by its **current** state. The result is **zero-filled** in JS to all six `JobState` keys so the `Record<JobState, number>` return type is honest.

### `countByQueue`

```ts
countByQueue(filter?: JobFilter): Promise<Record<string, number>>
```

```sql
WITH current AS (
  SELECT DISTINCT ON (job_id) * FROM pgbossier.record ORDER BY job_id, attempt DESC
)
SELECT queue, count(*)::int AS count
FROM current
WHERE <conditions>
GROUP BY queue;
```

Each job counted once, by queue. `descent-app`'s 24h-failure-count maps to `countByQueue({ states: ['failed','cancelled'], completedAfter: <24h ago> })`.

### `listLongRunning`

```ts
listLongRunning(opts?: { queue?: string; longerThanSeconds?: number; limit?: number })
  : Promise<JobRecord[]>
```

```sql
SELECT * FROM pgbossier.record
WHERE state = 'active'
  [AND queue = $Q]
  AND started_on < now() - make_interval(secs => $S)
ORDER BY started_on ASC, job_id
LIMIT $L;
```

`active` rows are always latest → no CTE. Served by `record_active_idx`. `now()` is evaluated in Postgres (no client-clock skew). `longerThanSeconds` default 900; `limit` default 100, cap 1000. `started_on ASC` → longest-running first.

## Filter construction (`listJobs` / `countByState` / `countByQueue`)

A condition builder turns `JobFilter` into a parameterized `WHERE`:

| Filter field | Clause |
|---|---|
| `queue` | `queue = $n` |
| `queues` (only if `queue` unset) | `queue = ANY($n)` |
| `states` | `state = ANY($n)` |
| `createdAfter` / `createdBefore` | `created_on >= $n` / `created_on < $n` |
| `completedAfter` / `completedBefore` | `completed_on >= $n` / `completed_on < $n` |

Clauses are joined with ` AND `; an empty filter yields no `WHERE`. `queue` and `queues` are mutually exclusive — if both are supplied, `queue` wins (documented). Every value is a positional parameter.

## Client wiring

`bossier({ boss, pool })` returns the existing `{ boss, recordPatch }` plus the seven methods, each closing over `pool` — the same pattern `recordPatch` already uses. No new pool; reads share the client's pool.

## Validation, errors, edge cases

- **Reads throw.** Fail-open governs *capture writes*, not reads — a query error rejects the promise.
- **`limit`:** `undefined` → default; `≤ 0` or non-integer → `throw`; `> 1000` → capped at 1000.
- **`offset`:** `undefined` → 0; `< 0` or non-integer → `throw`.
- **`jobId`:** validated against the UUID shape in JS; malformed → `null` (`findById`) / `[]` (`getRetryHistory`), never a raw `pg` cast error.
- **Empty results:** `listJobs` → `{ rows: [], total: 0 }`; `getRetryHistory` / `latestPerQueue` / `listLongRunning` → `[]`; `countByState` → all six keys at `0`; `countByQueue` → `{}`.
- **`statement_timeout`:** v1 does not impose one in code (KISS). The buildable spec recommends consumers set `statement_timeout` on the `pg.Pool` they pass to `bossier()` so a pathological read cannot pin a pooled connection that capture writes also need. Documented in the README; revisit a built-in if pool contention is observed (#12).
- **Backfilled / dead-lettered jobs:** queryable like any other; a dead-lettered job carries a new `job_id` and is not linked to its origin by these methods (lineage is #4).

## Decisions taken

| Decision | Resolution |
|---|---|
| Current view | Inline CTE, not a SQL view — no new schema object. |
| Schema change | One partial index `record_active_idx`, appended to `RECORD_INDEXES_SQL`. |
| `listJobs` total | `count(*) OVER ()` window aggregate — one round-trip. |
| Code location | New `src/read.ts`; `client.ts` wires; `index.ts` re-exports types. |
| `JobRecord` | Discriminated union on `state`; `output` typed per state; one cast in `mapRecord`. |
| `statement_timeout` | Consumer-configured on the pool; not built into v1. |
| `limit` cap | Default 100, hard cap 1000. |

## What this spec does NOT decide

- `search()` / `peek` — deferred (design doc); `getActiveWorkers` — dropped (worker identity is out of scope).
- The `Job<TInput,TOutput>` registration/inference system (#13).
- The discriminated `TerminalDetail` type (#3) — `terminalDetail` stays `unknown` until then.
- Cursor pagination — `limit`/`offset` for v1.

## Testing — `test/read.test.ts`

Integration tests against real pg-boss via `@testcontainers/postgresql`, no mocks (same harness as the substrate). One block per method; each must prove:

- **`findById`** — populated job (latest attempt returned); unknown id → `null`; malformed id → `null`; a retried job returns the current attempt, not attempt 0.
- **`getRetryHistory`** — a fail-twice-then-complete job → 3 rows, `attempt` `0,1,2`, ascending; unknown id → `[]`.
- **`listJobs`** — `queue` / `queues` / `states` / time-window filters; `total` correct and independent of `limit`; pagination stability (page 1 ∪ page 2 has no overlap and no gap); empty → `{ rows: [], total: 0 }`; one job with retries appears **once** (current view).
- **`latestPerQueue`** — one row per queue, the most recent job, at current state; `states` filter; empty `queues` → `[]`.
- **`countByState`** — each job counted once by current state; all six keys present; a retried-then-completed job counts as `completed`, not `retry`.
- **`countByQueue`** — counts per queue; the `states` + `completedAfter` combination (the descent-app 24h-failure shape).
- **`listLongRunning`** — an active job past the threshold is returned; a fresh active job is not; `now()` is server-side.
- **Index use** — one `EXPLAIN`-style assertion that `listJobs(states:['active'])` / `listLongRunning` use `record_active_idx`, not a sequential scan.

## Next step

On approval: `superpowers:writing-plans` turns this into a task-by-task plan — scaffold `src/read.ts` + the types, the index, then each method test-first against a real pg-boss container, then the `client.ts` wiring and `index.ts` exports.

# pg-bossier Goal 5 — Operational Read API — Design

- **Status:** Draft v2 — revised after multi-reviewer review, awaiting re-review
- **Date:** 2026-05-21
- **Author:** elfensky, with claude-code
- **Builds on:** `2026-05-20-storage-architecture-design.md`, `2026-05-20-substrate-spec.md`, and the shipped substrate (v0.1.1)
- **Target:** sub-issue [#6](https://github.com/elfensky/pg-bossier/issues/6) — Goal 5, New APIs

## Revision note (v2 — 2026-05-21)

v1 of this spec was reviewed by two independent reviewers (architecture + database) via `/octo:spec`. v2 folds in their findings:

- **The method set is now triage-driven.** v1 designed methods top-down from the substrate's columns. v2 triages descent-app's *actual* ~10 query functions (its `src/lib/jobs/queries.js`) against the method set — see the new triage section. The result reshapes the surface: a general `listJobs` and a `latestPerQueue` are added (descent-app's core needs); `search` and `peek` are **deferred** (the primary consumer needs neither, and both had defects v1 carried).
- `JobRecord` is now a **discriminated union on `state`** — v1's flat `output: TOutput` was wrong for 5 of 6 states.
- `findById` / `countByState` semantics are defined precisely against the multi-row-per-job table.
- `captured_at` corrected to first-capture (v1 inherited the architecture doc's wrong "last write" wording).
- Total `ORDER BY`, the trigger/app-hook write race, an edge-case matrix, and a partial index are added.

## Scope

Decide the **operational read API** — the typed methods that replace descent-app's raw SQL against `pgboss.*` and make "what happened to job X" a one-call answer. This is the biggest step from "substrate captures data" to "library is operational."

**In scope:** the method set (validated against the primary consumer's real queries), signatures, the `JobRecord` type, pagination, ordering, error/edge-case semantics, the generics approach for v1, one small index addition.

**Out of scope:** write-path methods (#3/#5/#7), lifecycle events (#8), the `Job<TInput,TOutput>` registration/inference system (#13), CI (#9), the exact SQL (that is the buildable spec).

## What the substrate already gives us

- **`pgbossier.record`** — one row per `(job_id, attempt)`, transactionally complete (the capture trigger mirrors every `pgboss.job` transition). Columns: `job_id`, `queue`, `attempt`, `state`, `data`, `output`, `progress`, `terminal_detail`, `input_snapshot`, `created_on`, `started_on`, `completed_on`, `captured_at`.
- **Indexes:** `(queue, state)`, `(captured_at)`, GIN on `data` / `output` / `terminal_detail`.
- **The `bossier({ boss, pool })` client** — holds a `pg.Pool`. Read methods are added to it and run on that pool.
- `captured_at` is the **first-capture** time of an attempt row — it is never re-stamped (`src/sql.ts`). It is *not* a last-updated/freshness signal; `record` has no last-updated column.

**Single source, confirmed.** Every read is `SELECT … FROM pgbossier.record` — no `pgboss.job` read, no multi-source merge. The trigger keeps `record` a transactionally-consistent superset of `pgboss.job`, so a record-only read is current *and* forensic (it still answers after pg-boss TTL-deletes the job row).

### The "current view" — the conceptual backbone

`pgbossier.record` has one row **per attempt**. Almost every read wants one row **per job** — the job's *latest* attempt. Define:

> **current view** = the latest-attempt row of each `job_id` — `DISTINCT ON (job_id) … ORDER BY job_id, attempt DESC`.

The current view of `pgbossier.record` is conceptually **`pgboss.job` plus the jobs pg-boss has already deleted** — exactly the surface descent-app's raw queries assume. The PK `(job_id, attempt)` serves the `DISTINCT ON` as an index-ordered scan. The buildable spec may materialize this as a SQL view (`pgbossier.record_current`) or an inline CTE.

`getRetryHistory` is the **only** method that reads all attempt rows; every other method reads the current view.

## descent-app query triage

Goal 5's done-criterion (issue #1) is *"descent-app's raw-SQL count against `pgboss.*` drops to zero."* This triages descent-app's `src/lib/jobs/queries.js` (the consumer's actual queries) against the proposed methods:

| descent-app function | What it does | Goal 5 method |
|---|---|---|
| `getJobById` | one job by id | **`findById`** ✅ |
| `getJobsPaginated` | paginated list, filter by queue + state, with total | **`listJobs`** ✅ |
| `getRecentJobs` | latest N jobs across queues, by `created_on` | **`listJobs`** ✅ |
| `getLatestSuccessfulCatalogJob` | latest `completed` job in one queue | **`listJobs`** (`states:['completed']`, `limit:1`) ✅ |
| `getQueueSummaries` (last job per queue) | `DISTINCT ON (name)` latest per queue | **`latestPerQueue`** ✅ |
| `getLastJobPerSchedule` | latest `completed`/`failed` per queue | **`latestPerQueue`** ✅ |
| `getJobStatsByState` | counts grouped by state, multi-queue | **`countByState`** ✅ |
| `getQueueSummaries` (24h failure count) | count `failed`/`cancelled`, time-windowed, per queue | **`countByState`** (with `completedAfter`) ✅ |
| `getJobCountsByQueue` | counts grouped by queue | **`countByQueue`** ✅ |
| `updateJobOutput`, `mergeJobOutput` | **writes** progress into `pgboss.job.output` | ➡️ **Goal 6** (`recordPatch`/progress) — not a read |

**Findings that reshaped the method set:**

1. descent-app's backbone is a **general filtered+paginated list with a total count** (`getJobsPaginated`, `getRecentJobs`) and **latest-per-queue** (`getQueueSummaries`, `getLastJobPerSchedule`). v1 had neither — it had `listActive`/`peek`, which are too narrow (state-pinned). Both are added in v2.
2. descent-app uses **no JSONB content search** and **no queue-peek** in its current queries. v1's `search` and `peek` are speculative for the primary consumer — both are **deferred** (see Decisions).
3. `countByState` must accept **multiple queues** and a **time window** — `getQueueSummaries`'s 24h failure count needs `completedAfter`.
4. `updateJobOutput`/`mergeJobOutput` are descent-app's progress-fallback **writes** (descent-app#342); they belong to Goal 6, not Goal 5 — noted so the "raw-SQL → zero" criterion accounts for them under the right goal.

This triage means the v2 method set is verified bottom-up against the success criterion, not assumed.

## The read surface

All methods are on the `bossier` client, run on its pool.

```ts
type JobState = 'created' | 'active' | 'retry' | 'completed' | 'cancelled' | 'failed';

interface RecordBase<TInput> {
  jobId: string;
  queue: string;
  attempt: number;                 // 0 = first try
  data: TInput | null;             // pg-boss allows a job with no data
  progress: unknown;               // app-hook column; Goal 6 refines the type
  inputSnapshot: unknown;          // app-hook column; Goal 4 refines the type
  createdOn: Date | null;
  startedOn: Date | null;
  completedOn: Date | null;
  capturedAt: Date;                // first capture of THIS attempt row — not a freshness signal
}

/** Discriminated on `state` — `output` means different things per state. */
type JobRecord<TInput = unknown, TOutput = unknown> =
  | (RecordBase<TInput> & { state: 'created' | 'active'; output: null;            terminalDetail: null })
  | (RecordBase<TInput> & { state: 'retry' | 'failed';   output: unknown;         terminalDetail: unknown })  // output = this attempt's error
  | (RecordBase<TInput> & { state: 'completed';          output: TOutput | null;  terminalDetail: unknown })
  | (RecordBase<TInput> & { state: 'cancelled';          output: unknown;         terminalDetail: unknown });

interface ListJobsOpts {
  queue?: string;
  queues?: string[];
  states?: JobState[];
  createdAfter?: Date;  createdBefore?: Date;
  completedAfter?: Date; completedBefore?: Date;
  orderBy?: 'createdOn' | 'completedOn' | 'capturedAt';  // default 'createdOn', always DESC
  limit?: number;       // default + hard cap (e.g. 100 / 1000)
  offset?: number;
}

interface BossierClient {
  // ...existing: boss, recordPatch

  /** A job's latest attempt, across all queues. null if never captured. */
  findById<TInput = unknown, TOutput = unknown>(
    jobId: string,
  ): Promise<JobRecord<TInput, TOutput> | null>;

  /** Every attempt of a job, oldest first. One query — satisfies success
   *  criterion #2 (current state = the last element). [] if unknown. */
  getRetryHistory<TInput = unknown, TOutput = unknown>(
    jobId: string,
  ): Promise<JobRecord<TInput, TOutput>[]>;

  /** General filtered, paginated job list over the current view, with a total
   *  count. The workhorse — replaces descent-app's getJobsPaginated/getRecentJobs. */
  listJobs<TInput = unknown, TOutput = unknown>(
    opts?: ListJobsOpts,
  ): Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }>;

  /** Latest job per queue for a set of queues, optionally state-filtered. */
  latestPerQueue(
    queues: string[],
    opts?: { states?: JobState[] },
  ): Promise<JobRecord[]>;

  /** Job counts by current state — over the current view, every job counted once.
   *  Zero-fills all six states so the return type is honest. */
  countByState(opts?: {
    queue?: string; queues?: string[];
    createdAfter?: Date; completedAfter?: Date;
  }): Promise<Record<JobState, number>>;

  /** Job counts by queue — over the current view. */
  countByQueue(opts?: {
    queues?: string[]; states?: JobState[];
    createdAfter?: Date; completedAfter?: Date;
  }): Promise<Record<string, number>>;

  /** Active jobs whose started_on is older than a threshold. See note. */
  listLongRunning(opts?: {
    queue?: string; longerThanSeconds?: number; limit?: number;
  }): Promise<JobRecord[]>;
}
```

**Method notes:**

- **`findById`** — current view, `WHERE job_id = $1`. The PK `(job_id, attempt)` is a composite btree; a leading-column `job_id` predicate is an index range scan and `ORDER BY attempt DESC` is free from index order — so this is indexed without a separate `job_id` index. A returned `state: 'retry'` is a valid current answer meaning *"this attempt failed; the job is awaiting its next attempt"* — the discriminated union forces the caller to handle it.
- **`getRetryHistory`** — all attempt rows, `WHERE job_id = $1 ORDER BY attempt ASC`. One row per attempt, each reflecting that attempt's **final captured state** — intra-attempt transitions (`created`→`active`) are *not* preserved as separate rows (`ON CONFLICT DO UPDATE` overwrites in place). This is attempt-granularity history, which is what Goal 3 specifies.
- **`listJobs`** — current view, dynamic `WHERE` from the opts, `ORDER BY <orderBy> DESC, job_id` (the `job_id` tiebreaker makes paging deterministic), `LIMIT/OFFSET`, plus a parallel `COUNT(*)` over the same `WHERE` for `total`.
- **`countByState` / `countByQueue`** — `GROUP BY` over the **current view** (each job counted once by its latest state/queue), not over raw attempt rows. Counting raw rows would tally every historical retry attempt — a cumulative lifetime number, not an operational count. `countByState` zero-fills all six `JobState` keys.
- **`listLongRunning`** (was `listStalled`) — `WHERE state = 'active' AND started_on < now() - <threshold>`, `now()` evaluated in Postgres. Renamed because pg-boss resolves genuine stalls itself (`failJobsByHeartbeat`); this heuristic surfaces *long-running* jobs, healthy or not — the honest name. Default threshold e.g. 900s.

## Generics — v1 approach

Methods are generic with `unknown` defaults. Inline call-site generics (`findById<TIn, TOut>(id)`); no type registration in v1. The registration/inference system is #13's job and is **not a blocker** — when it lands it supplies these type arguments as defaults without changing the signatures. `terminalDetail` is typed `unknown` pending Goal 2 (#3), which defines the discriminated `TerminalDetail` type that `JobRecord` will then adopt.

## Pagination, ordering, errors, edge cases

- **Pagination — `limit` + `offset`**, default `limit` and a hard cap. `listJobs` returns `{ rows, total }` so a caller always knows the full size and never mistakes a truncated page for the whole set. Deep `offset` degrades (scan-and-discard) — acceptable at descent-app's scale; cursor pagination deferred until a consumer's result set demands it.
- **Ordering** — every list method specifies a **total** `ORDER BY` ending in `job_id`, so `limit/offset` pages are stable even as the trigger writes concurrently.
- **Errors — reads throw.** The fail-open constraint governs *capture writes*, not reads; a failed query rejects the promise.
- **Edge cases:**
  - `findById` validates the `jobId` is a UUID in JS and returns `null` for a malformed id (rather than leaking a Postgres cast error). Unknown id → `null`.
  - `getRetryHistory` unknown id → `[]`. Attempt numbers are assumed contiguous; a fail-open capture gap could leave a hole — documented as a known forensic limitation.
  - `listJobs` no matches → `{ rows: [], total: 0 }`. Negative/zero `limit`/`offset` → rejected.
  - `countByState` → all six keys present (zero-filled).
  - **Backfilled jobs** are queryable identically (single-source pays off), but a job backfilled mid-retry has only the single `pgboss.job` snapshot taken at install — its pre-install attempts are not reconstructable.
  - **Dead-lettered jobs** carry a *new* `job_id`; `findById`/`getRetryHistory` on the original id do not surface the dead-letter job. Dead-letter lineage is #4's scope; the methods document the boundary.
  - **Trigger/app-hook write race:** `terminal_detail` / `progress` / `input_snapshot` are written by the app-hook in a *separate* transaction from the trigger's `state` capture. A read can legitimately see `state: 'failed'` with `terminalDetail: null` for a brief window — these columns are eventually-populated, hence typed `unknown` (which admits the not-yet-written case).

## Performance notes

- **One index addition:** `CREATE INDEX record_active_idx ON pgbossier.record (queue, started_on) WHERE state = 'active'`. A *partial* index — it only ever holds currently-active rows, so it stays small forever even though `record` grows unbounded. It serves `listLongRunning` and `listJobs(states:['active'])`.
- The current-view `DISTINCT ON (job_id) … ORDER BY job_id, attempt DESC` is served index-ordered by the PK. It still scans all `job_id`s ever; for very large historical tables, `createdAfter`/`completedAfter` windowing bounds it. Hard optimization (e.g. a "is-latest" flag, materialization) is deferred to the performance-budget issue (#12).
- Reads share the `bossier` client's pool with the capture app-hook. The buildable spec should set a `statement_timeout` on read queries so a pathological read fails fast instead of starving capture writes.

## Decisions taken

| Decision | Resolution |
|---|---|
| Read source | Single source — `pgbossier.record` only; the **current view** is the per-job basis. |
| Method set (v1) | `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`. Validated against descent-app's real queries. |
| `JobRecord` | Discriminated union on `state`; `output` typed per state; `data: TInput \| null`; `terminalDetail: unknown` pending #3. |
| Generics | Inline generics, `unknown` default; registration deferred to #13, non-blocking. |
| Pagination | `limit`+`offset`; `listJobs` returns `{ rows, total }`; total `ORDER BY` on every list method. |
| Errors | Reads throw; fail-open is for capture writes only. |
| `listStalled` → `listLongRunning` | Renamed — the heuristic measures long-running, not pg-boss-dead, jobs. |
| Index | Add the partial `record_active_idx`. |

## Decisions deferred / open

1. **`search()` — deferred from Goal 5 v1.** descent-app's current queries need no JSONB content search; v1's `search` also carried a dedup correctness bug and depends on three GIN indexes whose write cost lands on the hot capture path. The GIN indexes already shipped, so `search` can be added later without a schema change. Recommendation: defer to a follow-up issue, add when a consumer needs it.
2. **`peek` — deferred from Goal 5 v1.** "Preview the queue" is covered by `listJobs({ states: ['created'] })`, descent-app does not use it, and it had the deferred-jobs ambiguity (`record` has no `start_after`). Deferring it also avoids a substrate schema change. Add later if a real need appears.
3. **`getActiveWorkers` — out of Goal 5.** `record` captures no worker identity; a real version needs a *worker-identity capture* feature. Open a dedicated issue. ⚠️ **This de-scopes "worker context" from issue #1's success criterion #2** — that de-scope must be acknowledged by editing issue #1 (the charter changes only there).
4. **Triage completeness — checked 2026-05-21.** Beyond `src/lib/jobs/queries.js` (triaged above), descent-app has raw `pgboss.*` access in a few more files, now characterized:
   - `src/lib/jobs/flush-progress.js` — *writes* progress into `pgboss.job.output` (`UPDATE pgboss.job SET output … WHERE state='active'`). This is the descent-app#342 progress fallback — **Goal 6** scope, not Goal 5.
   - `src/lib/space-track/sync.js` — one `SELECT output FROM pgboss.job` *read* — covered by `findById`.
   - `check-jobs.js` — a dev/ops script reading `pgboss.job` — covered by `listJobs` / `findById`.
   - The engine files (`stale-recovery.js`, `pgboss-bridge.js`, `api/engine/*` routes) use pg-boss's **JS API** (`import boss`), not raw `pgboss.*` SQL — out of scope; pg-bossier extends pg-boss's queue ops, never replaces them.

   **Conclusion:** the v2 Goal 5 method set needs **no additional method** — the extra reads map to `findById` / `listJobs`, the extra writes belong to Goal 6. The "raw-SQL → zero" criterion (issue #1) therefore spans Goals 5 **and** 6; Goal 5 alone does not zero it, and that should be reflected when measuring the criterion.

## What this design does NOT decide

- Exact SQL per method, the column→camelCase mapping, the `JobRecord` type module — that is the buildable spec.
- The `Job<TInput,TOutput>` registration/inference system (#13).
- Dead-letter lineage (#4); the discriminated `TerminalDetail` type (#3).
- A worker-identity capture mechanism (future `getActiveWorkers`).
- `search()` and `peek` (deferred — see above).

## Testing

Integration tests against real pg-boss via `@testcontainers/postgresql`, no mocks. Per method: populated, empty, `queue`/`state`/time-window filters, pagination stability (page 1 vs page 2 do not overlap), and the discriminated-union narrowing. `findById`/`getRetryHistory` tested across a multi-attempt retry job. At least one `EXPLAIN`-style assertion that `listJobs`/`listLongRunning` use indexes rather than sequential scans. When #13's typed surface lands, add `*TypeTest.ts` type-level tests (#16).

## Next step

On approval: a buildable spec (exact SQL per method, the `record_current` view decision, the `JobRecord` module), then `superpowers:writing-plans` for the task breakdown — each method built test-first against a real pg-boss container.

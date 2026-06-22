# descent-app fit — success-criterion-#1 scorecard

> **Updated 2026-06-23 (post-reposition, on `develop`).** The two "residual raw" rows below are now closed by typed methods: **`heartbeat_on`** (and live `expire_seconds` / current state) is read via **`getLiveState(jobId)` / `getLiveHeartbeat(jobId)`** (WS-C), so the conditional raw `pgboss.job` lookup is eliminated — the scorecard's raw-SQL count drops further toward zero. Also: the lifecycle method is now `subscribeEvents()` (was `subscribe`), and `bossier()`'s `pool` is optional (BYO connection). The two `pgboss.job.output` *writers* remain raw by design (live queue-op writes pg-bossier won't replace). See CLAUDE.md § "General-purpose reposition".

**Purpose.** Success criterion #1 (issue #1) is: *descent-app's raw-SQL count against `pgboss.*` drops to zero, or to a documented short list with stated reasons.* This file is that scorecard — the artifact the descent-app validation trial measures against.

**Method.** Produced by mapping descent-app's actual `src/lib/jobs/queries.js` against the **current** pg-bossier API, then adversarially verifying each row against both codebases (`src/read.ts`, `src/client.ts`, `src/progress.ts`, `src/sql.ts`). Reflects the pre-trial decisions in CLAUDE.md (`recordPatch` removed, `setProgress` read-side, `latestPerQueue` `orderBy` option) **as amended**: three of the five `pgboss.job` metadata columns — `priority`, `retry_limit`, `singleton_key` (immutable job config) — are now captured into `pgbossier.record` and exposed on `JobRecord`, reopening pre-trial decision (b) per [#26](https://github.com/elfensky/pg-bossier/issues/26). The remaining two stay uncaptured: `heartbeat_on` (live runtime state the `UPDATE OF state` trigger can't track; only meaningful for in-flight jobs, whose `pgboss.job` row still exists) and `expire_seconds` (selected-but-never-rendered). Reconcile against descent-app's queries.js at port time — this was a point-in-time read of ~10 SQL-bearing exported functions / 12 raw statements.

**Legend.**

| | meaning |
|---|---|
| ✅ **Replaced** | raw SQL eliminated. Uses a pg-bossier method, possibly plus a pure-JS shape adapter (descent-app's existing `normalizeJob` layer, re-pointed at `JobRecord`). A JS adapter is **not** raw SQL. |
| 🔶 **Replaced + residual raw** | the query/list is replaced, but a deliberately-uncaptured column (`heartbeat_on` / `expire_seconds`) needs a small raw lookup **iff** the UI renders it. |
| ❌ **Raw by design** | stays raw. pg-bossier deliberately does not replace it (writes to the live `pgboss.job` — a pg-boss queue op). |

## The mapping

| descent-app function | raw SQL today (against `pgboss.job`) | pg-bossier replacement | status |
|---|---|---|---|
| `getLastJobPerSchedule` | `DISTINCT ON(name)` … `state IN(completed,failed)` `ORDER BY completed_on DESC NULLS LAST` | `latestPerQueue(names, { states:['completed','failed'], orderBy:'completedOn' })` | ✅ (+ field-rename adapter `queue→name`) |
| `getLatestSuccessfulCatalogJob` | `SELECT output … state='completed' ORDER BY completed_on DESC LIMIT 1` | `latestPerQueue(['sync-catalog'], { states:['completed'], orderBy:'completedOn' })` → `rows[0]?.output` | ✅ (+ cast `output`) |
| `getQueueSummaries` (a) latest/queue | `DISTINCT ON(name) … ORDER BY name, created_on DESC` | `latestPerQueue(queues)` | ✅ (+ re-key to `Record<name,…>`) |
| `getQueueSummaries` (b) 24h fail count | `GROUP BY name … state IN(failed,cancelled) AND completed_on > now()-24h` | `countByQueue({ queues, states:['failed','cancelled'], completedAfter })` — **one call** | ✅ |
| `getJobStatsByState` | `GROUP BY state` | `countByState({ queues })` | ✅ (+ `Record→array[]` adapter) |
| `getJobCountsByQueue` | `GROUP BY name` | `countByQueue({ queues })` | ✅ (+ `Record→array[]` adapter) |
| `getJobById` | `SELECT … WHERE id=$1 AND name IN(6 queues)` | `findById(jobId)` (+ app-side queue filter, normalize) — now carries `priority`/`retryLimit`/`singletonKey` | 🔶 (`heartbeat_on` live, in-flight only) |
| `getRecentJobs` | full cols, `ORDER BY created_on DESC LIMIT n` | `listJobs({ queues, orderBy:'createdOn', limit })` — now carries `priority`/`retryLimit`/`singletonKey` | ✅ |
| `getJobsPaginated` | full cols + `COUNT(*)` (2 statements) | `listJobs({ queue\|queues, states, orderBy:'createdOn', limit, offset })` → `{ rows, total }` | ✅ |
| `updateJobOutput` | `UPDATE pgboss.job SET output=$::jsonb` | — (writes the live `pgboss.job.output`) | ❌ |
| `mergeJobOutput` | `UPDATE pgboss.job SET output=COALESCE(output,'{}') \|\| patch` | — | ❌ |

`getJobsPaginated` is the strongest fit: `listJobs` folds its **two** statements (page + exact total) into one call via `count(*) OVER ()`, eliminating the two-query `Promise.all`.

## The documented short list (criterion #1)

Raw SQL against `pgboss.*` does **not** drop to literally zero. The honest short list of what stays raw, and why:

1. **`updateJobOutput`** — raw by design. Writes the **live** `pgboss.job.output`; that's a pg-boss queue-op write, and the *"Don't replace pg-boss queue ops"* non-goal applies. pg-bossier's `setProgress` is read-side (writes `pgbossier.record.progress`, never `pgboss.job`).
2. **`mergeJobOutput`** — raw by design, same reason (`setProgress` also *overwrites* rather than JSONB-merges, so it isn't even semantically equivalent).
3. **(Conditional) one residual `SELECT`** for the two still-uncaptured `pgboss.job` columns — `heartbeat_on` and `expire_seconds` — **only if** the detail view actually renders them. `heartbeat_on` is live runtime state (the `UPDATE OF state` trigger can't track it, and it's only meaningful for an in-flight job, whose `pgboss.job` row is still present — so the residual read is naturally scoped to active jobs). `expire_seconds` is selected-but-never-rendered today. The other three (`priority`, `retry_limit`, `singleton_key`) are **now captured** — see the amended method note above. See [#26](https://github.com/elfensky/pg-bossier/issues/26).

Everything else eliminates its raw SQL: of the 12 raw statements, only the two output-writers stay raw by design, plus the now-narrower conditional `heartbeat_on` lookup.

## Porting notes (not raw SQL — JS work descent-app owns)

- **Shape adapter.** Every read replacement returns camelCase `JobRecord` (and `Record<…,number>` for counts), not descent-app's snake_case `normalizeJob` shape / `StateBucket[]` / `QueueBucket[]`. descent-app re-points its existing `normalizeJob` / `STATE_TO_STATUS` / `extractError` layer on top of `JobRecord`. This is a pure-JS transform, not raw SQL.
- **Count population.** `countByState` / `countByQueue` count over `pgbossier.record`'s current-attempt-per-job view (`recordCurrent`), which **retains jobs pg-boss has already deleted** — so counts can be a *superset* of the live `pgboss.job` query. Constrain with `createdAfter` / `completedAfter`, or accept the historical superset. (For forensic dashboards this is usually the desired behavior — it's Goal 1, not a bug.)
- **Forensic upside.** `findById` / `getRetryHistory` answer **after** pg-boss's `deletion_seconds` has deleted the row — the raw queries cannot. That's success criterion #2, and it's the reason to port `getJobById` even though it's a shim.

## Migration option (a behavior change, not a drop-in)

The two ❌ output-writers could move onto `setProgress` / `getProgress` — but that's a **behavior change** (different table/column, overwrite vs JSONB-merge, different reader), only worth it if descent-app wants durable display/resume progress rather than a live `pgboss.job.output` IPC channel. If the live channel is load-bearing, it stays pg-boss's domain. Decide during the trial.

## Scope note

`input_snapshot` (`recordInputSnapshot`) maps to **no** descent-app function — descent-app's own domain audit-trail table owns provenance ("which job + inputs → which result"). The slot stays opt-in and unused here by design.

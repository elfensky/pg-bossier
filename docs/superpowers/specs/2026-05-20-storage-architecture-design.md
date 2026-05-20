# pg-bossier Storage Architecture — Design

- **Status:** Approved direction, awaiting spec review
- **Date:** 2026-05-20
- **Author:** elfensky, with claude-code (brainstorming)
- **Target:** [elfensky/pg-bossier#1](https://github.com/elfensky/pg-bossier/issues/1) — the storage / capture / query layer beneath Goals 1–7
- **Builds on:** `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`

## Context

Issue #1 frames nine goals. Five of them — Goal 1 (permanent history), Goal 2 (terminal-state detail), Goal 3 (retry history), Goal 4 (input-snapshot), Goal 6 (progress) — each implied its own storage decision, and the issue #1 sub-issue split treated them as five independent design problems.

This design is the output of a brainstorm that asked one cross-cutting question: **can those five share one storage substrate?** The answer is yes. This document specifies that substrate — one table, one capture mechanism, one query source — so the per-goal sub-issues inherit a settled storage answer instead of each re-deriving one.

It decides *where job data lives, how it is captured, and how it is read.* It does **not** decide per-goal API method signatures or column-level DDL; those stay in their sub-issues.

## Verified pg-boss 12.18.2 facts

The architecture rests on pg-boss's actual behavior. All facts below were verified by reading `node_modules/pg-boss/dist/plans.js` against pg-boss 12.18.2 (pinned in `package.json` `peerDependencies`).

| Transition | pg-boss mechanism | Row effect |
|---|---|---|
| `send()` → `created` | `INSERT` | new row; `id` = caller-supplied or `gen_random_uuid()` |
| fetch → `active` | in-place `UPDATE` | `started_on` set; `retry_count++` when picking up a `retry` job |
| `complete()` | in-place `UPDATE` | `state → completed`, `output` set |
| `cancel()` | in-place `UPDATE` | `state → cancelled` |
| fail, retries remain | `DELETE` + `INSERT`, **same `id`** | active row destroyed; fresh row reuses the id, `state → retry`, `output` = this attempt's error |
| fail, retries exhausted | `DELETE` + `INSERT`, **same `id`** | active row destroyed; fresh row reuses the id, `state → failed` |
| dead-letter (terminal fail + `dead_letter` set) | `INSERT`, **new `id`** | a new job in the dead-letter queue |
| TTL cleanup (`deletion`) | `DELETE` | row removed `deletion_seconds` after `completed_on` |

Decisive facts:

1. **A job's `id` is stable for its entire retry lifecycle.** The retry path reuses the id; retries are same-id row-versions, not a chain of new ids. `retry_count` orders the attempts.
2. **`data` is carried verbatim through the retry `DELETE`+`INSERT`; `output` is overwritten** with each attempt's failure output. Prior attempts' outputs are lost from `pgboss.job`.
3. `pgboss.job` has exactly **two JSONB columns**: `data` (consumer payload) and `output` (result/error).
4. `completed` / `cancelled` are **in-place `UPDATE`s** (the row persists); `failed` / `retry` go through `DELETE`+`INSERT`; terminal rows are removed by the `deletion_seconds` TTL.
5. There is **no `pgboss.archive` table**. The terminal states are exactly `completed` / `cancelled` / `failed` — there is no `expired` or `superseded` state.
6. Dead-lettering is the **only** case that mints a new `id`.

## Architecture

### The table: `pgbossier.record`

One pg-bossier-owned table, **one row per `(job_id, attempt)`**. Two ownership zones:

| Column | Owner | Source / purpose |
|---|---|---|
| `job_id` | trigger | pg-boss `id` — stable across the job's life |
| `queue` | trigger | pg-boss `name` |
| `attempt` | trigger | derived from pg-boss `retry_count`; `0` = first try |
| `state` | trigger | captured pg-boss state (`created` / `active` / `retry` / `completed` / `cancelled` / `failed`) |
| `data` | trigger | preserved input payload, mirrored from `pgboss.job.data` |
| `output` | trigger | preserved result / error, mirrored from `pgboss.job.output` |
| `created_on` / `started_on` / `completed_on` | trigger | timestamps mirrored from `pgboss.job` |
| `progress` | app-hook | live progress for this attempt (mutable while the attempt runs) |
| `terminal_detail` | app-hook | failure `class` + pg-bossier-derived `expired` / `superseded` markers |
| `input_snapshot` | app-hook | opt-in consumer-supplied "what data did this job consume" manifest |
| `captured_at` | both | when pg-bossier last wrote this row |

Primary key `(job_id, attempt)`. Exact column types, nullability, indexes, and constraints are deferred to the audit-table sub-issue (#2) — this design fixes the column *set* and *ownership*, not the DDL minutiae.

**Why one table — the mutable-head-row model.** The current attempt's row is mutable: progress updates land on it, and `terminal_detail` is written when the attempt ends. Once the attempt reaches a terminal-ish state, its row freezes and becomes a permanent forensic record; a retry inserts a fresh row for the next attempt. "Live metadata" and "append-only history" are the same data at two points in time, so they are one table, not two. This single table covers Goals 1, 2, 3, 4, and 6.

**Why its own `pgbossier` schema.** The table, its indexes, and the trigger function all live in a dedicated `pgbossier` schema (default name `pgbossier`, configurable like pg-boss's own schema option):

- Symmetric uninstall (Goal 9) *is* `DROP SCHEMA pgbossier CASCADE` — one statement removes everything pg-bossier owns.
- pg-boss runs its own migrations on `pgboss.*`; schema isolation protects `pgbossier.record` from being clobbered or colliding with a future pg-boss table.
- Permissions can grant pg-bossier write on `pgbossier.*` and read-only on `pgboss.*`, so a pg-bossier bug cannot corrupt pg-boss's data.

**Why named `record`, not `archive`.** "Archive" collides with a pg-boss term that no longer exists (pre-v12 `pgboss.archive`) — naming pg-bossier's table `archive` would make every reader assume it mirrors pg-boss's nonexistent archive. "Archive" also mischaracterizes the table: its current-attempt row is live and mutable, not cold storage. `pgbossier.record` reads as "pg-bossier's system of record" and carries no pg-boss baggage.

`data` is stored on every attempt row for v1, even though it is identical across a job's attempts. The store-once optimization is deferred — tracked as backlog issue #14.

### Capture: app-hook + thin trigger

`pgbossier.record` has **two writers**, owning disjoint column sets (no write conflict):

**The trigger** — `AFTER INSERT OR UPDATE OR DELETE ON pgboss.job`, with its function defined in the `pgbossier` schema.
- Mirrors the trigger-owned columns from each `pgboss.job` row-version into `pgbossier.record`.
- Provides *completeness*: it fires on every state change, including pg-boss's internal maintenance transitions (`failJobsByTimeout`, `failJobsByHeartbeat`, `deletion`) and any out-of-band or other-process change — none of which the app layer can observe.
- Runs inside pg-boss's transaction. It **swallows its own exceptions** (PL/pgSQL exception handling) so a capture failure can never abort the underlying pg-boss operation — honoring the fail-open constraint.
- Kept *thin* to bound its in-transaction overhead.

**The app-hook** — pg-bossier's wrapping client, intercepting `fail` / `complete` / `touch` / `send`.
- Writes the app-hook-owned columns (`progress`, `terminal_detail`, `input_snapshot`) — data that does not exist in `pgboss.job` and therefore no trigger can capture.
- `UPSERT`s onto the `(job_id, attempt)` row the trigger created.
- Naturally fail-open: the metadata write happens in pg-bossier's code after the pg-boss op, wrapped in `try/catch`.

The trigger alone is insufficient (it cannot see `class` / `progress` / `input_snapshot`); the app-hook alone is insufficient (it is blind to pg-boss's internal maintenance transitions — exactly the timeout/stall cases with the highest forensic value). Both are required; this is decision **C** from the brainstorm.

**Known sub-issue detail (capture wiring).** At a retry, pg-boss `DELETE`s the stale `active` row (which carries no failure information) and `INSERT`s the new `retry`/`failed` row (which carries the failure `output`). The trigger must therefore capture failure detail from the `INSERT`, not the `DELETE`. The exact trigger event wiring, the handling of the retry `DELETE`+`INSERT` pair, and `attempt` numbering across the `retry → active` `retry_count` increment are left to the audit-table sub-issue (#2). The "thin trigger" sub-choice — a direct `INSERT` versus a minimal write to a `pgbossier`-owned outbox drained asynchronously by a pg-bossier background worker — is also a #2 decision.

### Write paths

The app-hook write paths, by goal:

- **Progress (Goal 6)** — the worker calls a pg-bossier progress method (a `touch`-adjacent call); pg-bossier `UPDATE`s the current `pgbossier.record` row's `progress`. On retry, the worker reads the *previous* attempt's frozen `progress` to resume.
- **`terminal_detail` (Goal 2)** — pg-bossier's wrapped `fail()` / `complete()` `UPSERT`s the failure `class` and derived markers onto the record row.
- **`input_snapshot` (Goal 4)** — pg-bossier's wrapped `send()` or a job-start hook `UPSERT`s the consumer-supplied manifest.

The exact API shape of each write path — overloading the pg-boss method via new optional parameters versus a new sibling pg-bossier method — is deferred per write-feature, per issue #1's API-shape principle. This design fixes only the *destination* (the `pgbossier.record` row) and the *owner* (the app-hook).

### Query: single source

Because the trigger mirrors every `pgboss.job` change into `pgbossier.record` transactionally, `pgbossier.record` is a complete, transactionally-consistent superset of `pgboss.job` — current state plus all history. **Read methods consult only `pgbossier.record`.** There is no multi-source merge and no dedup.

The Goal 5 read surface (method signatures, pagination, and TypeScript generics deferred to sub-issues #6 and #12):

- `findById`, `peek`, `listActive`, `listStalled`, `getActiveWorkers`, state-bucket counts.
- `getRetryHistory(jobId)` — `SELECT * FROM pgbossier.record WHERE job_id = $1 ORDER BY attempt`.
- `search(criteria)` — content search across the `data` / `output` / `terminal_detail` JSONB columns, deduped to one hit per `job_id`. A new Goal 5 method added during this brainstorm.

### Install and uninstall

**Install** — one migration:
1. `CREATE SCHEMA pgbossier`.
2. `CREATE TABLE pgbossier.record (...)` plus its indexes.
3. `CREATE FUNCTION pgbossier.capture()` (name illustrative) and `CREATE TRIGGER` on `pgboss.job`.
4. **Backfill** — copy the current contents of `pgboss.job` into `pgbossier.record`, so the mirror is complete from install and the query layer is unconditionally single-source. (Backfill performance — chunking, locking, throttling — is sub-issue #11.)

**Uninstall** — `DROP SCHEMA pgbossier CASCADE` + `npm uninstall`. The `CASCADE` drops the schema, the table, and the trigger function; dropping the function cascades to drop the trigger on `pgboss.job`. No residue, no orphaned objects — `pgboss` is left exactly as it was.

## Constraints honored (from issue #1)

- **Fail-open audit writes.** The app-hook wraps its writes in `try/catch`; the trigger swallows its own exceptions. A pg-bossier capture failure never blocks a pg-boss operation.
- **Per-event overhead budget.** The trigger adds a synchronous write inside pg-boss's transaction — this is the cost the per-event budget (cross-cutting #12) must bound. The "thin trigger" requirement and the outbox option exist to keep it within budget.
- **API-shape principle: composition, not replacement.** Read methods are new pg-bossier methods on `pgbossier.record`. Write-path API shapes are explored per write-feature in their sub-issues.
- **Symmetric uninstall.** Single `DROP SCHEMA pgbossier CASCADE`.
- **Compatibility tiers (Goal 8).** The app-hook depends only on pg-boss's public JS API — **Stable** tier. The trigger references `pgboss.job` columns and is DDL attached to that table — **Transitional** tier, and a heavier dependency than a plain read; sub-issue #9 (compat tier) must name it explicitly.

## Decisions taken

| Decision | Resolution |
|---|---|
| Storage location | One pg-bossier-owned table. **Rejected:** co-mingling pg-bossier metadata into `pgboss.job.data`, and the "envelope" variant (pg-bossier owns `data`'s top level) — the envelope breaks pg-boss's `data` contract (forces wrapping `send`+`work`) and breaks symmetric uninstall (enveloped `data` survives uninstall and breaks plain-pg-boss workers). |
| One table vs two (live + history) | **One table**, mutable-head-row model. Live metadata and append-only history are the same data at two points in time. |
| Capture mechanism | **C — app-hook + thin trigger.** Trigger-alone cannot capture `class`/`progress`/`input_snapshot`; app-hook-alone is blind to pg-boss's internal maintenance transitions (timeout / heartbeat-stall / TTL-delete). |
| Query sources | **Single source** — `pgbossier.record` only. The trigger makes it a complete current+historical mirror, so no multi-source merge or dedup. |
| Pre-install jobs | **Backfill at install** — keeps the chronicle complete and the query single-source from day one. |
| Table name | **`pgbossier.record`.** Rejected `archive` (collides with the defunct pre-v12 `pgboss.archive`; mischaracterizes a table whose head row is live). |
| Schema | Dedicated **`pgbossier`** schema (configurable), never `pgboss`. |
| `data` duplication | Store `data` on every attempt row for v1. Store-once optimization deferred — backlog issue #14. |
| `search()` method | Added to the Goal 5 read surface — content search across `data`/`output`/`terminal_detail`, deduped per `job_id`. |

## What this design does NOT decide

Deferred to sub-issues:

- Exact `pgbossier.record` DDL — column types, nullability, indexes, constraints (#2).
- Thin-trigger sub-choice — direct `INSERT` vs outbox + asynchronous drainer (#2).
- Trigger event wiring — which of `INSERT`/`UPDATE`/`DELETE`, retry `DELETE`+`INSERT` pair handling, `attempt` numbering edge cases, the fail-open PL/pgSQL exception block (#2).
- Write-path API shape per feature — overload pg-boss method vs new pg-bossier method (#3 / #5 / #7).
- Read-method signatures, pagination, worker-identity model (#6); TypeScript generics (#13).
- `search(criteria)` filter/criteria language (#6).
- Dead-letter lineage and singleton-supersession representation (#4).
- Backfill performance — chunking, locking, throttling (#11).
- The numeric per-event overhead budget (#12).
- Lifecycle event mechanism (#8) — though it can reuse the same capture points.

## Impact on the published sub-issues

This architecture does not change the *number* of sub-issues; it shrinks the *risk* in most of them, because the cross-cutting "where does data live / how is it captured" question is now answered once.

| Sub-issue | Effect |
|---|---|
| #2 — audit table | Becomes "the `pgbossier.record` schema + DDL + the capture trigger". Scope sharpened. |
| #3 — terminal detail | Reduced to the `terminal_detail` column shape + its app-hook write path. |
| #4 — retry history | Already corrected; now nearly trivial — `SELECT … ORDER BY attempt` + dead-letter / supersession edge cases. |
| #5 — input snapshot | Reduced to the `input_snapshot` column + its app-hook write path. |
| #6 — new APIs | Read methods (single-source) + the new `search()` method. |
| #7 — progress | Reduced to the `progress` column + its `touch`-adjacent write path. |
| #8 — lifecycle events | Can reuse the capture points (trigger / app-hook) as event sources. |
| #9 — compatibility tier | Must now tier the capture trigger explicitly (Transitional — DDL on `pgboss.job`). |
| #10 — install/uninstall | Concrete: one migration (schema + table + trigger + backfill); `DROP SCHEMA CASCADE`. |
| #11 — backfill | Resolved in principle (backfill-at-install); performance detail remains. |
| #12 — performance budget | Concrete target: the trigger's in-transaction overhead. |
| #13 — TS generics surface | Unaffected — the `Job<TInput, TOutput>` type pattern is orthogonal to storage. |

Sub-issue bodies #2 / #3 / #5 / #7 / #8 should be updated to reference this design doc once it is approved.

## Testing considerations

The architecture's correctness depends on pg-boss's actual runtime behavior — especially the retry `DELETE`+`INSERT` and the internal maintenance transitions. It must be verified against a real pg-boss instance, not mocks: the capture trigger interacting with pg-boss's actual SQL, retry capture producing correctly-ordered `attempt` rows, backfill producing a complete mirror, and `DROP SCHEMA pgbossier CASCADE` leaving zero residue. This feeds the Goal 8 CI matrix (run against each supported pg-boss version). Test-runner choice remains deferred per `CLAUDE.md`.

## Next step

Once this spec is approved, `superpowers:writing-plans` generates the implementation plan. The natural first buildable increment is the **substrate**: the `pgbossier` schema, the `pgbossier.record` table, the capture trigger + app-hook skeleton, the install migration, and backfill — i.e. sub-issue #2 plus the capture mechanism. The per-goal write-path and query-method sub-issues each get their own plan afterward, inheriting this architecture.

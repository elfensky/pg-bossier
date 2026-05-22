# pg-bossier Goal 6 — Persistent Progress API — Design

- **Status:** Draft v2 — revised after a 4-way adversarial debate review
- **Date:** 2026-05-21
- **Author:** elfensky, with claude-code
- **Builds on:** `2026-05-20-storage-architecture-design.md`, `2026-05-21-goal-5-read-api-design.md`, and the shipped substrate
- **Target:** sub-issue [#7](https://github.com/elfensky/pg-bossier/issues/7) — Goal 6, Persistent job progress

## Revision note (v2 — 2026-05-21)

v1 was reviewed by a 4-way adversarial debate (Gemini, Codex, Sonnet, Opus; 2 rounds, cross-critique). v2 folds in the findings:

- **`getProgress` now returns `{ progress, attempt }`, not a bare value** — the unanimous finding of all four reviewers. A bare value cannot tell a resuming worker whether it received its own current-attempt checkpoint or a value carried forward from a prior attempt. Returning the source `attempt` resolves the ambiguity at zero query cost.
- **Honest zombie-worker framing.** v1 called the zombie write "transient, self-correcting." It is not — a stale write can *persist* and be consumed as a resume checkpoint. Corrected in §1, §3, §10.
- **`setProgress` is the sole writer of `progress`.** v1 left `recordPatch` as a second, divergent write path to the same column. v2 removes `progress` from `RecordPatch`.
- Minor: edge-case matrix split (malformed vs nonexistent id), fail-open rationale corrected, a test-determinism note, two compatibility/timing clarifications.

One debate finding was **dismissed**: "partitioned queues break the capture trigger" — refuted against pg-boss source. `pgboss.job` is `PARTITION BY LIST (name)`; the `job_common` default partition and every `partition: true` queue's table are `ATTACH PARTITION`-ed to it, and a `FOR EACH ROW` trigger on the partitioned parent propagates to all partitions (PostgreSQL 11+). The capture trigger fires for every queue.

The four core design decisions are unchanged; only `getProgress`'s return *shape* is enriched.

## Scope

Decide the **write API and read API** for pg-bossier's persistent job-progress slot — one mechanism that serves both the resumable-job and the non-resumable-job usage patterns from issue #1, with the consumer choosing the semantics.

**In scope:** the `setProgress` write method, the `getProgress` read method, their signatures, attempt resolution, retry-resume read semantics, payload marshalling and validation, error-handling behavior, retention, code layout, the pg-boss compatibility-tier classification, and the API-shape (a)/(b) trade-off write-up issue #1 mandates.

**Out of scope:** the `pgbossier.record` table itself (delivered — Goal 1 / #2); retry-history reconstruction (Goal 3 / #4); the `Job<TInput, TOutput>` generics registration/inference system (#13 — `getProgress` exposes a call-site generic but no registration mechanism); lifecycle events (#8); the exact buildable SQL (that is the buildable spec).

## What the substrate already gives us

The storage half of Goal 6 is **already shipped** — issue #7's storage-location decision is settled.

- **`pgbossier.record.progress jsonb`** — an app-hook-owned column, one value per `(job_id, attempt)`. The capture trigger never writes it, so it is never clobbered by a later state-transition re-fire.
- **Survival across retry is structural.** pg-boss's retry path is a `DELETE`+`INSERT` on `pgboss.job` that reuses the job id and increments `retry_count`. The capture trigger mirrors each attempt into its own permanent `(job_id, attempt)` row, where `attempt = pgboss.job.retry_count`. Attempt N's `progress` stays on attempt N's row forever; the retry creates a fresh `(job_id, N+1)` row with `progress = NULL`.
- **`recordPatch(pool, jobId, attempt, patch)`** — the existing UPDATE-only patch write for the app-hook columns. v2 narrows it (see §7).
- **`JobRecord`** (Goal 5) already carries `progress: unknown`, and `getRetryHistory(jobId)` already returns every attempt's row — so per-attempt forensic progress is queryable today.

**Goal 6 adds zero schema changes** — no migration, no new column, no new index. It is purely code: two functions, client wiring, type exports, and one small narrowing of `recordPatch`. The PK `(job_id, attempt)` index serves every query this feature issues.

## Two findings that shaped the design

Issue #7's "Decisions to make" framed the write API around overloading `boss.touch`. Inspection of pg-boss 12.18.2's published type surface reshaped that:

1. **`boss.touch` cannot carry a payload.** pg-boss 12's signature is `touch(name, id, options?)` where `options` is `ConnectionOptions` (`{ db }`) only — there is no payload slot, and no other pg-boss public method has a worker-callable mid-flight data slot. Issue #1's API-shape option (a) — "overload a pg-boss method" — is therefore *structurally unavailable* for progress; it would have to become a wrapping client (option (c)). See §9.

2. **A worker does not know its `attempt` by default.** The job object a `work()` handler receives is `Job<T>` — `{ id, name, data, expireInSeconds, heartbeatSeconds, signal, groupId?, groupTier? }`. It has **no `retryCount`**. `retryCount` lives on `JobWithMetadata<T>`, available only when the worker opts into `work(..., { includeMetadata: true })` (default `false`). A write API keyed on an explicit `attempt` argument would force every progress consumer to enable `includeMetadata`. The design resolves the attempt server-side instead, so the worker only ever needs `job.id`.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Write-API surface | Sibling method on the `bossier` client — `bossier.setProgress(...)`. Not a wrapping client. |
| 2 | `setProgress` signature | `setProgress(jobId, progress)` — attempt resolved server-side as `max(attempt)`. |
| 3 | `getProgress` retry-resume semantics | Most-recent non-null `progress` across all attempts, returned as `{ progress, attempt }`. |
| 4 | Payload shape | Any JSON-serializable value; `setProgress` marshals internally. |
| 5 | Error handling | Fail-open on runtime errors (log + swallow); throw only on argument validation. |
| 6 | Retention | Keep forever — no clearing mechanism. |

## 1. Write API — `bossier.setProgress(jobId, progress)`

```ts
setProgress(jobId: string, progress: unknown): Promise<void>
```

A single SQL statement — the attempt is resolved server-side in a subquery, so there is no read-then-write round-trip and no time-of-check/time-of-use race:

```sql
UPDATE pgbossier.record
SET progress = $2::jsonb
WHERE job_id = $1
  AND attempt = (SELECT max(attempt) FROM pgbossier.record WHERE job_id = $1)
```

- `$1` is `jobId`; `$2` is `JSON.stringify(progress)` (see §4).
- The worker calls `setProgress(job.id, value)`. `job.id` is always present on pg-boss's `Job<T>` — no `includeMetadata` required.
- The PK `(job_id, attempt)` index serves both the `max(attempt)` subquery and the `UPDATE` predicate.
- Multiple `setProgress` calls within one attempt are last-write-wins. One worker owns one active attempt, so there is no intra-attempt concurrency.

**Why the target row exists.** The capture trigger runs `FOR EACH ROW` *inside pg-boss's own INSERT/UPDATE transaction*, and that transaction commits before pg-boss hands the job to a worker. So by the time a worker calls `setProgress`, the current attempt's `record` row provably exists and the `UPDATE` matches it — this is not a timing assumption, it is a consequence of the trigger being synchronous in pg-boss's transaction.

**Why server-side attempt resolution is safe — and its one failure mode.** During a worker's execution its attempt *is* the maximum: a higher attempt row appears only after the current attempt reaches a terminal/retry state, which the live worker has not yet done. The exception is a **zombie worker** — a worker whose job already expired (`expireInSeconds`) and was retried elsewhere, but whose original process is still alive and still calling `setProgress`. The zombie's write lands on the *newest* attempt's row rather than its own.

This is **not** "transient, self-correcting." If the live worker writes again it overwrites the stale value — but if the live worker crashes before its next `setProgress`, the zombie's stale value *persists* as the most-recent non-null progress and can be **consumed as a resume checkpoint by the next retry**, causing redundant re-work. It never corrupts the trigger-owned chronicle columns (`state`, timing, `data`, `output`) — the damage is confined to the app-hook `progress` value. The `attempt` field that `getProgress` returns (§2) is the mitigation: a worker can see which attempt a value came from. Well-configured `expireInSeconds` plus heartbeats keep the window small. Explicit-attempt addressing would eliminate the failure mode entirely but would force `includeMetadata: true` on every consumer — the trade the design Q&A weighed and rejected (Decision 2).

## 2. Read API — `bossier.getProgress(jobId)`

```ts
interface ProgressResult<TProgress = unknown> {
  progress: TProgress;   // the most-recent non-null progress value
  attempt: number;       // the attempt that value was written on
}

getProgress<TProgress = unknown>(jobId: string): Promise<ProgressResult<TProgress> | null>
```

```sql
SELECT progress, attempt FROM pgbossier.record
WHERE job_id = $1 AND progress IS NOT NULL
ORDER BY attempt DESC
LIMIT 1
```

- Returns `{ progress, attempt }`, or `null` when the job is unknown to pg-bossier or no attempt has ever written progress.
- **`attempt` is load-bearing, not decorative.** "Most-recent non-null across attempts" is otherwise *lossy*: a bare value cannot tell a caller whether it is the current attempt's own checkpoint or a value carried forward from a prior attempt — and those are semantically different for the resumable pattern (§3). Returning the source `attempt` lets the caller distinguish them. The column is already on the row, so it costs nothing. (This was the unanimous finding of the v1 design review.)
- `jobId` is UUID-validated with the same `UUID_RE` guard the Goal 5 readers use; a malformed id short-circuits to `null` without a query.
- `TProgress` is a **call-site generic**, mirroring `findById<TInput, TOutput>`. The mechanism for *registering* a per-queue progress type is issue #13 and stays out of scope — a caller declares the type inline (`getProgress<MyProgress>(id)`) or accepts `unknown`.
- The PK index serves `WHERE job_id = $1 ... ORDER BY attempt DESC`; a job has few attempts (bounded by `retryLimit`, in practice well under ~20), so filtering `progress IS NOT NULL` over them is cheap. No new index.

`getProgress` is the **effective current-value** convenience. Per-attempt progress for forensic reads is already available via `getRetryHistory(jobId)` — `getProgress` deliberately does not duplicate that.

## 3. Retry-resume semantics

The most-recent-non-null query makes pg-bossier **mode-agnostic** — it never needs to know whether a job is resumable. One read serves both issue #1 patterns:

- **Non-resumable (display value).** A worker writes a display value — `"Step 3 of 5"`, `{ pct: 40 }`. The job fails and retries; attempt N+1's row starts `NULL`. A dashboard calling `getProgress` keeps returning the last display value *through the retry gap*, until the new worker's first `setProgress` overwrites it. No blank flicker. The dashboard ignores the `attempt` field.
- **Resumable (structured position).** A worker writes a position — `{ processed: 1200, total: 5000, cursor: "..." }`. On retry the new worker calls `getProgress(job.id)` at startup and receives `{ progress, attempt }`. Because its own attempt's row is still `NULL`, the returned `attempt` is *lower* than the new worker's current attempt — an unambiguous signal that this is a **prior attempt's final position** to resume from, not a stale read of its own row. The worker resumes from `progress`. A worker that has its own attempt number (via `work({ includeMetadata: true })`) can compare the two directly; that comparison is what makes the resume decision deterministic rather than a guess.

pg-bossier persists what the worker writes and returns the most-recent non-null value plus its `attempt`; the *worker* decides whether to act on it (resume) or ignore it (display-only). No mode flag, no configuration.

**Accepted edge case** (the consequence of Decision 2's server-side resolution): a zombie worker whose job already expired and retried elsewhere writes to the *newest* attempt's row. Per §1 this is **not** self-correcting in the worst case — a stale value can persist and be read as a resume checkpoint, causing re-work (never chronicle corruption). The `attempt` field returned by `getProgress` is the provenance mitigation. Documented as a known, bounded limitation.

## 4. Payload marshalling & validation

`setProgress` accepts any JSON-serializable value and marshals it itself: `JSON.stringify(progress)`, bound to the query with a `::jsonb` cast. This makes every shape work uniformly — a bare string (`"Step 3 of 5"`), a number, an object, an array — so the non-resumable display-string pattern needs no `{ label: ... }` wrapping. (A bare JS string bound directly to a `jsonb` parameter is otherwise rejected by Postgres, which tries to parse it as JSON; explicit `JSON.stringify` turns it into the valid JSON document `"Step 3 of 5"`.)

**Argument validation throws.** A misused call is a programmer error and should surface at development time, so `setProgress` throws a clear `Error` — *before* any database call — when `progress` is:

- `undefined` or `null` — progress must be a meaningful value. This preserves a clean invariant: a non-`NULL` `progress` column always means *a worker wrote a real value*, which is what `getProgress`'s `IS NOT NULL` filter relies on. To represent "no progress," a worker simply does not call `setProgress`.
- non-serializable — a function, `BigInt`, or a value that makes `JSON.stringify` throw or return `undefined` (e.g. a circular structure).

This throw-on-bad-argument behavior matches the established pattern in `read.ts` (`resolveLimit` / `resolveOffset` throw on invalid input).

## 5. Error handling — fail-open on runtime errors

Issue #1's constraint: *"Audit writes are best-effort, never block pg-boss. Default: log and continue."* A DB/runtime error inside `setProgress` is **caught, logged via `console.warn`, and swallowed**. A failed progress write must never fail the consumer's job — for a *display* job progress is mere telemetry, and even for a *resumable* job (where progress is a resume checkpoint, not telemetry) a lost write only costs re-work on a later retry, which is strictly better than failing the running job. Fail-open holds for both patterns, for different reasons. Therefore:

- A **runtime error** during the `UPDATE` — connection lost, or a *malformed (non-UUID) `jobId`* producing a Postgres uuid-syntax error — is caught, logged via `console.warn`, and swallowed; `setProgress` still resolves `void`. `setProgress` does **not** pre-validate the UUID: unlike `getProgress` (which validates so it can return a meaningful `null`), `setProgress` would no-op regardless, so a pre-check buys nothing.
- An `UPDATE` that matches **zero rows** — a syntactically valid `jobId` not known to pg-bossier (a bogus id, or pg-bossier not installed) — is also a `console.warn` and a resolve, never a throw. (The capture trigger creates a job's row at `pgboss.job` INSERT, before any worker runs, so a live worker's `setProgress` normally always matches.)
- **Argument validation** (§4) is the *only* path that throws.

`console.warn` is the v1 logger — the JS-side counterpart of the capture trigger's Postgres `RAISE WARNING`. A pluggable logger / `onError` hook on `BossierOptions` is intentionally **not** added in v1 (KISS); it can be introduced later without an API break.

`getProgress` is a read — a runtime error there propagates normally (the fail-open constraint governs *writes* on the pg-boss hook path, not reads).

## 6. Retention / cleanup

**No clearing mechanism.** `progress` stays on the permanent `pgbossier.record` row through and past terminal state. This is deliberate forensic continuity — *"what was the last reported progress when job X failed six months ago?"* must stay answerable — and it respects issue #1's "No bounded retention tooling" non-goal (retention is consumer-owned). This confirms issue #7's open cleanup question in favor of keep-forever.

## 7. Code layout

A new file **`src/progress.ts`**, holding `setProgress(pool, jobId, progress)` and `getProgress(pool, jobId)` as standalone pool-taking functions — mirroring how `src/read.ts` is structured.

- `src/client.ts` wires both onto `BossierClient` (closing over the client's `pool`, exactly as the Goal 5 read methods are wired).
- `src/index.ts` re-exports the new `ProgressResult` type alongside the existing exports.
- **`recordPatch` is narrowed — `progress` is removed from it.** Today `RecordPatch` carries a `progress?` slot *and* `setProgress` writes the same column — two public writers with contradictory behavior (`recordPatch` no-ops on a `null` patch and rejects bare strings; `setProgress` throws on `null` and marshals bare strings). v2 removes `progress` from the `RecordPatch` interface and from `recordPatch`'s `UPDATE`, leaving `recordPatch` with only `terminal_detail` and `input_snapshot` (the Goal 2 / Goal 4 write paths). `setProgress` becomes the **sole** writer of `progress`. This is a small, safe change to not-yet-released substrate code (version is `0.0.0`).

`setProgress` is *not* implemented by calling `recordPatch`. `recordPatch` requires an explicit `attempt`; `setProgress` resolves the attempt server-side in one statement. Routing through `recordPatch` would mean a separate `SELECT max(attempt)` first — an extra round-trip and a TOCTOU window. The one-statement `UPDATE` with the subquery is simpler and atomic.

## 8. pg-boss compatibility tier

Goal 6 introduces **no new pg-boss surface**:

- `setProgress` and `getProgress` read and write only `pgbossier.record` — pg-bossier's own table — and make no pg-boss calls.
- The worker's use of `job.id` is the already-classified **Stable** pg-boss public `Job` API.

`COMPATIBILITY.md` needs no new tier entry for Goal 6. One **inherited** dependency is worth a one-line note in the implementation spec: `setProgress`'s "the current attempt = `max(attempt)`" model rests on the capture trigger's `attempt = pgboss.job.retry_count` mapping — a surface already classified **Transitional**. Goal 6 adds no *new* dependency on pg-boss's retry mechanics; it inherits the existing Transitional one. (The "a worker's attempt is the maximum during its execution" property is a PostgreSQL transaction-visibility fact, not a pg-boss surface — it belongs in a code comment, not the tier table.)

## 9. API-shape principle — (a) overload vs (b) sibling method

Issue #1's API-shape principle requires each write-feature sub-issue to prototype both an overload of a pg-boss method (a) and a new sibling method (b), then document the trade-off and pick one.

- **(a) Overload a pg-boss method.** The only worker-callable, mid-flight pg-boss method is `touch`. In pg-boss 12.18.2 `touch(name, id, options?)` takes `options: ConnectionOptions` only — there is no payload slot, and no other public pg-boss method exposes one mid-flight. "Overloading `touch` to accept progress" is therefore not possible by passing an option; it would require a **wrapping client** that intercepts `touch` calls (issue #1's option (c)) — putting pg-bossier in the queue-op call path and changing how consumers obtain their pg-boss instance.
- **(b) Sibling method.** `bossier.setProgress` is a new method on pg-bossier's own client, built on the shipped `pgbossier.record` substrate. It composes cleanly, requires no change to how consumers use pg-boss, keeps pg-bossier out of the queue-op path, and is consistent with the Goal 5 read methods already on the same client.

**Decision: (b).** Option (a) is structurally unavailable for a mid-flight payload — `touch` carries no data — and the wrapping-client form of it is heavier on every axis. The trade-off is one-sided.

## 10. Edge-case matrix

| Case | Behavior |
|---|---|
| `setProgress` on a job with one attempt (no retries) | Writes to attempt 0's row. |
| `setProgress` after a retry | Writes to the current (highest) attempt's row. |
| `setProgress`, `progress` is `undefined` / `null` | Throws (argument validation). |
| `setProgress`, `progress` non-serializable (function, `BigInt`, circular) | Throws (argument validation). |
| `setProgress`, bare string / number | Marshalled and stored as a JSON scalar; round-trips. |
| `setProgress` on a valid UUID not known to pg-bossier | Zero rows updated → `console.warn`, resolves `void`. |
| `setProgress` on a malformed (non-UUID) `jobId` | Postgres uuid-syntax error → caught by the fail-open path → `console.warn`, resolves `void`. |
| `setProgress`, DB error during `UPDATE` | Caught → `console.warn`, resolves `void` (fail-open). |
| `setProgress` from a zombie worker (job already expired + retried) | Writes to the newest attempt's row. Usually overwritten by the live worker; if the live worker crashes first, the stale value persists and can be read as a resume checkpoint → re-work on the next retry. Never corrupts the trigger-owned chronicle columns. `getProgress`'s `attempt` field exposes the provenance. |
| `getProgress` on a malformed (non-UUID) id | Returns `null`, no query issued. |
| `getProgress` on a job that never wrote progress | Returns `null`. |
| `getProgress` mid-retry-gap (new attempt's row still `NULL`) | Returns `{ progress, attempt }` for the previous attempt — `attempt` is below the current attempt, marking it a carry-forward. |
| `getProgress` after the current attempt has written | Returns `{ progress, attempt }` for the current attempt. |
| Per-attempt forensic progress | Available via `getRetryHistory(jobId)` — each `JobRecord.progress`. |

## 11. Testing

Integration tests only — `vitest` + `@testcontainers/postgresql`, real Postgres + pg-boss 12.18.2, no mocks — consistent with the existing suite and reusing the retried-job harness already present in `read.test.ts`:

- `setProgress` → `getProgress` round-trip: a structured object, and a bare display string. Assert the returned `{ progress, attempt }` shape.
- Retry-resume: write progress on attempt 0; force a fail + retry; assert attempt 1's row is `NULL` (via `getRetryHistory`); assert `getProgress` returns `{ progress: <attempt-0 value>, attempt: 0 }`; have attempt 1 write; assert `getProgress` flips to `{ progress: <new value>, attempt: 1 }`.
- Unknown / malformed job id: `getProgress` returns `null`; `setProgress` is a logged no-op that does not throw.
- Job that never wrote progress: `getProgress` returns `null`.
- Argument validation: `setProgress` with `undefined`, `null`, and a non-serializable value each throw.
- Forensic continuity: per-attempt progress remains visible via `getRetryHistory` after the job reaches a terminal state.

**Forcing a deterministic retry.** "Force a fail + retry" is not implicit. The test sets up a queue with `retryLimit >= 1` and `retryDelay: 0`, and a handler that throws on attempt 0 and succeeds on attempt 1. After the throw the test must **wait** for the new attempt row rather than assume timing — poll `getRetryHistory(jobId)` until it returns two rows, under a bounded timeout, then assert. This mirrors how `read.test.ts`'s existing retried-job test synchronizes; the implementation plan reuses that helper rather than a fixed `sleep`.

## Summary of the public surface added

```ts
// on BossierClient
setProgress(jobId: string, progress: unknown): Promise<void>;
getProgress<TProgress = unknown>(jobId: string): Promise<ProgressResult<TProgress> | null>;

// new exported type
interface ProgressResult<TProgress = unknown> { progress: TProgress; attempt: number }
```

Two methods, one new file (`src/progress.ts`), one new exported type, no schema change, no `COMPATIBILITY.md` tier change. One narrowing of existing code: `progress` is removed from `RecordPatch`.

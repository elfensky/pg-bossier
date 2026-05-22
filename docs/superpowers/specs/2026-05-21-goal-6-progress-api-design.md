# pg-bossier Goal 6 — Persistent Progress API — Design

- **Status:** Draft v1 — awaiting review
- **Date:** 2026-05-21
- **Author:** elfensky, with claude-code
- **Builds on:** `2026-05-20-storage-architecture-design.md`, `2026-05-21-goal-5-read-api-design.md`, and the shipped substrate
- **Target:** sub-issue [#7](https://github.com/elfensky/pg-bossier/issues/7) — Goal 6, Persistent job progress

## Scope

Decide the **write API and read API** for pg-bossier's persistent job-progress slot — one mechanism that serves both the resumable-job and the non-resumable-job usage patterns from issue #1, with the consumer choosing the semantics.

**In scope:** the `setProgress` write method, the `getProgress` read method, their signatures, attempt resolution, retry-resume read semantics, payload marshalling and validation, error-handling behavior, retention, code layout, the pg-boss compatibility-tier classification, and the API-shape (a)/(b) trade-off write-up issue #1 mandates.

**Out of scope:** the `pgbossier.record` table itself (delivered — Goal 1 / #2); retry-history reconstruction (Goal 3 / #4); the `Job<TInput, TOutput>` generics registration/inference system (#13 — `getProgress` exposes a call-site generic but no registration mechanism); lifecycle events (#8); the exact buildable SQL (that is the buildable spec).

## What the substrate already gives us

The storage half of Goal 6 is **already shipped** — issue #7's storage-location decision is settled.

- **`pgbossier.record.progress jsonb`** — an app-hook-owned column, one value per `(job_id, attempt)`. The capture trigger never writes it, so it is never clobbered by a later state-transition re-fire.
- **Survival across retry is structural.** pg-boss's retry path is a `DELETE`+`INSERT` on `pgboss.job` that reuses the job id and increments `retry_count`. The capture trigger mirrors each attempt into its own permanent `(job_id, attempt)` row, where `attempt = pgboss.job.retry_count`. Attempt N's `progress` stays on attempt N's row forever; the retry creates a fresh `(job_id, N+1)` row with `progress = NULL`.
- **`recordPatch(pool, jobId, attempt, patch)`** — the existing UPDATE-only patch write for the three app-hook columns. It requires an explicit `attempt` and is not used by this feature (see §7).
- **`JobRecord`** (Goal 5) already carries `progress: unknown`, and `getRetryHistory(jobId)` already returns every attempt's row — so per-attempt forensic progress is queryable today.

**Goal 6 adds zero schema changes** — no migration, no new column, no new index. It is purely code: two functions, client wiring, and type exports. The PK `(job_id, attempt)` index serves every query this feature issues.

## Two findings that shaped the design

Issue #7's "Decisions to make" framed the write API around overloading `boss.touch`. Inspection of pg-boss 12.18.2's published type surface reshaped that:

1. **`boss.touch` cannot carry a payload.** pg-boss 12's signature is `touch(name, id, options?)` where `options` is `ConnectionOptions` (`{ db }`) only — there is no payload slot, and no other pg-boss public method has a worker-callable mid-flight data slot. Issue #1's API-shape option (a) — "overload a pg-boss method" — is therefore *structurally unavailable* for progress; it would have to become a wrapping client (option (c)). See §9.

2. **A worker does not know its `attempt` by default.** The job object a `work()` handler receives is `Job<T>` — `{ id, name, data, expireInSeconds, heartbeatSeconds, signal, groupId?, groupTier? }`. It has **no `retryCount`**. `retryCount` lives on `JobWithMetadata<T>`, available only when the worker opts into `work(..., { includeMetadata: true })` (default `false`). A write API keyed on an explicit `attempt` argument would force every progress consumer to enable `includeMetadata`. The design resolves the attempt server-side instead, so the worker only ever needs `job.id`.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Write-API surface | Sibling method on the `bossier` client — `bossier.setProgress(...)`. Not a wrapping client. |
| 2 | `setProgress` signature | `setProgress(jobId, progress)` — attempt resolved server-side as `max(attempt)`. |
| 3 | `getProgress` retry-resume semantics | Most-recent non-null `progress` across all attempts. |
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

**Why server-side attempt resolution is safe.** During a worker's execution its attempt *is* the maximum — a higher attempt row appears only after the current attempt reaches a terminal/retry state, which the live worker has not yet done. The one exception is a **zombie worker**: a worker whose job already expired (`expireInSeconds`) and was retried on another worker, but whose original process is still alive and still calling `setProgress`. The zombie's write would land on the *newest* attempt's row rather than its own. This is an accepted, documented edge case — the consequence is a transient wrong value on the app-hook `progress` column only (the trigger-owned `state`/timing columns stay correct), and the live worker's next `setProgress` overwrites it. Well-configured `expireInSeconds` plus heartbeats make it rare. Explicit-attempt addressing would avoid it but would force `includeMetadata: true` on every consumer — the worse trade.

## 2. Read API — `bossier.getProgress(jobId)`

```ts
getProgress<TProgress = unknown>(jobId: string): Promise<TProgress | null>
```

```sql
SELECT progress FROM pgbossier.record
WHERE job_id = $1 AND progress IS NOT NULL
ORDER BY attempt DESC
LIMIT 1
```

- `jobId` is UUID-validated with the same `UUID_RE` guard the Goal 5 readers use; a malformed id short-circuits to `null` without a query.
- Returns `null` when the job is unknown to pg-bossier or no attempt has ever written progress.
- `TProgress` is a **call-site generic**, mirroring `findById<TInput, TOutput>`. The mechanism for *registering* a per-queue progress type is issue #13 and stays out of scope — a caller declares the type inline (`getProgress<MyProgress>(id)`) or accepts `unknown`.
- The PK index serves `WHERE job_id = $1 ... ORDER BY attempt DESC`; a job has few attempts (bounded by `retryLimit`), so filtering `progress IS NOT NULL` over them is cheap. No new index.

`getProgress` is the **effective current-value** convenience. Per-attempt progress for forensic reads is already available via `getRetryHistory(jobId)` — `getProgress` deliberately does not duplicate that.

## 3. Retry-resume semantics

The most-recent-non-null query makes pg-bossier **mode-agnostic** — it never needs to know whether a job is resumable. One read serves both issue #1 patterns:

- **Non-resumable (display value).** A worker writes a display value — `"Step 3 of 5"`, `{ pct: 40 }`. The job fails and retries; attempt N+1's row starts `NULL`. A dashboard calling `getProgress` keeps returning the last display value *through the retry gap*, until the new worker's first `setProgress` overwrites it. No blank flicker.
- **Resumable (structured position).** A worker writes a position — `{ processed: 1200, total: 5000, cursor: "..." }`. On retry the new worker calls `getProgress(job.id)` at startup; its own attempt's row is still `NULL`, so the query returns the **previous attempt's final position**, and the worker resumes from it.

pg-bossier persists what the worker writes and returns the most-recent non-null value; the *worker* decides whether to act on it (resume) or ignore it (display-only). No mode flag, no configuration.

## 4. Payload marshalling & validation

`setProgress` accepts any JSON-serializable value and marshals it itself: `JSON.stringify(progress)`, bound to the query with a `::jsonb` cast. This makes every shape work uniformly — a bare string (`"Step 3 of 5"`), a number, an object, an array — so the non-resumable display-string pattern needs no `{ label: ... }` wrapping. (A bare JS string bound directly to a `jsonb` parameter is otherwise rejected by Postgres, which tries to parse it as JSON; explicit `JSON.stringify` turns it into the valid JSON document `"Step 3 of 5"`.)

**Argument validation throws.** A misused call is a programmer error and should surface at development time, so `setProgress` throws a clear `Error` — *before* any database call — when `progress` is:

- `undefined` or `null` — progress must be a meaningful value. This preserves a clean invariant: a non-`NULL` `progress` column always means *a worker wrote a real value*, which is exactly what `getProgress`'s `IS NOT NULL` filter relies on. To represent "no progress," a worker simply does not call `setProgress`.
- non-serializable — a function, `BigInt`, or a value that makes `JSON.stringify` throw or return `undefined` (e.g. a circular structure).

This throw-on-bad-argument behavior matches the established pattern in `read.ts` (`resolveLimit` / `resolveOffset` throw on invalid input).

## 5. Error handling — fail-open on runtime errors

Issue #1's constraint: *"Audit writes are best-effort, never block pg-boss. Default: log and continue."* `setProgress` writes pg-bossier's audit table, and progress is non-critical telemetry — a failed progress write must never fail the consumer's job. Therefore:

- A **runtime error** during the `UPDATE` (connection lost, etc.) is caught, logged via `console.warn`, and swallowed — `setProgress` still resolves `void`.
- An `UPDATE` that matches **zero rows** (unknown job id, or pg-bossier not installed) is also a `console.warn` and a resolve — never a throw. (The capture trigger creates a job's row at `pgboss.job` INSERT, before any worker runs, so a live worker's `setProgress` normally always matches; zero rows signals a bogus id or a missing install.)
- **Argument validation** (§4) is the *only* path that throws.

`console.warn` is the v1 logger — the JS-side counterpart of the capture trigger's Postgres `RAISE WARNING`. A pluggable logger / `onError` hook on `BossierOptions` is intentionally **not** added in v1 (KISS); it can be introduced later without an API break.

`getProgress` is a read — a runtime error there propagates normally (the fail-open constraint governs *writes* on the pg-boss hook path, not reads).

## 6. Retention / cleanup

**No clearing mechanism.** `progress` stays on the permanent `pgbossier.record` row through and past terminal state. This is deliberate forensic continuity — *"what was the last reported progress when job X failed six months ago?"* must stay answerable — and it respects issue #1's "No bounded retention tooling" non-goal (retention is consumer-owned). This confirms issue #7's open cleanup question in favor of keep-forever.

## 7. Code layout

A new file **`src/progress.ts`**, holding `setProgress(pool, jobId, progress)` and `getProgress(pool, jobId)` as standalone pool-taking functions — mirroring how `src/read.ts` is structured.

- `src/client.ts` wires both onto `BossierClient` (closing over the client's `pool`, exactly as the Goal 5 read methods are wired).
- `src/index.ts` re-exports any new public type.
- `src/record.ts` / `recordPatch` is **untouched** — it still serves the Goal 2 / Goal 4 write paths (`terminal_detail`, `input_snapshot`).

`setProgress` is *not* implemented by calling `recordPatch`. `recordPatch` requires an explicit `attempt`; `setProgress` resolves the attempt server-side in one statement. Routing through `recordPatch` would mean a separate `SELECT max(attempt)` first — an extra round-trip and a TOCTOU window. The one-statement `UPDATE` with the subquery is simpler and atomic.

## 8. pg-boss compatibility tier

Goal 6 introduces **no new pg-boss surface**:

- `setProgress` and `getProgress` read and write only `pgbossier.record` — pg-bossier's own table — and make no pg-boss calls.
- The worker's use of `job.id` is the already-classified **Stable** pg-boss public `Job` API.

`COMPATIBILITY.md` therefore needs no update for Goal 6. The implementation spec will state this explicitly so the Goal 8 audit trail stays complete.

## 9. API-shape principle — (a) overload vs (b) sibling method

Issue #1's API-shape principle requires each write-feature sub-issue to prototype both an overload of a pg-boss method (a) and a new sibling method (b), then document the trade-off and pick one.

- **(a) Overload a pg-boss method.** The only worker-callable, mid-flight pg-boss method is `touch`. In pg-boss 12.18.2 `touch(name, id, options?)` takes `options: ConnectionOptions` only — there is no payload slot, and no other public pg-boss method exposes one mid-flight. "Overloading `touch` to accept progress" is therefore not possible by passing an option; it would require a **wrapping client** that intercepts `touch` calls (issue #1's option (c)). That puts pg-bossier in the queue-op call path, changes how consumers obtain their pg-boss instance, and sits in tension with the "compose with pg-boss, never replace its queue ops" boundary.
- **(b) Sibling method.** `bossier.setProgress` is a new method on pg-bossier's own client, built on the shipped `pgbossier.record` substrate. It composes cleanly, requires no change to how consumers use pg-boss, keeps pg-bossier out of the queue-op path, and is consistent with the Goal 5 read methods already on the same client.

**Decision: (b).** Option (a) is structurally unavailable for a mid-flight payload, and the wrapping-client form of it is heavier on every axis. The trade-off is one-sided.

## 10. Edge-case matrix

| Case | Behavior |
|---|---|
| `setProgress` on a job with one attempt (no retries) | Writes to attempt 0's row. |
| `setProgress` after a retry | Writes to the current (highest) attempt's row. |
| `setProgress`, `progress` is `undefined` / `null` | Throws (argument validation). |
| `setProgress`, `progress` non-serializable (function, `BigInt`, circular) | Throws (argument validation). |
| `setProgress`, bare string / number | Marshalled and stored as a JSON scalar; round-trips. |
| `setProgress` on an unknown / bogus job id | Zero rows updated → `console.warn`, resolves `void`. |
| `setProgress`, DB error during `UPDATE` | Caught → `console.warn`, resolves `void` (fail-open). |
| `setProgress` from a zombie worker (job already expired + retried) | Writes to the newest attempt's row; transient, self-correcting; documented. |
| `getProgress` on a malformed (non-UUID) id | Returns `null`, no query issued. |
| `getProgress` on a job that never wrote progress | Returns `null`. |
| `getProgress` mid-retry-gap (new attempt's row still `NULL`) | Returns the previous attempt's last non-null value. |
| `getProgress` after the current attempt has written | Returns the current attempt's value. |
| Per-attempt forensic progress | Available via `getRetryHistory(jobId)` — each `JobRecord.progress`. |

## 11. Testing

Integration tests only — `vitest` + `@testcontainers/postgresql`, real Postgres + pg-boss 12.18.2, no mocks — consistent with the existing suite and reusing the retried-job harness already present in `read.test.ts`:

- `setProgress` → `getProgress` round-trip: a structured object, and a bare display string.
- Retry-resume: write progress on attempt 0; force a fail + retry; assert attempt 1's row is `NULL` (via `getRetryHistory`); assert `getProgress` still returns attempt 0's value; have attempt 1 write; assert `getProgress` flips to the new value.
- Unknown / malformed job id: `getProgress` returns `null`; `setProgress` is a logged no-op that does not throw.
- Job that never wrote progress: `getProgress` returns `null`.
- Argument validation: `setProgress` with `undefined`, `null`, and a non-serializable value each throw.
- Forensic continuity: per-attempt progress remains visible via `getRetryHistory` after the job reaches a terminal state.

## Summary of the public surface added

```ts
// on BossierClient
setProgress(jobId: string, progress: unknown): Promise<void>;
getProgress<TProgress = unknown>(jobId: string): Promise<TProgress | null>;
```

Two methods, one new file (`src/progress.ts`), no schema change, no `COMPATIBILITY.md` change.

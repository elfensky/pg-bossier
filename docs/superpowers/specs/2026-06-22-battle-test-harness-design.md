# Battle-test (chaos) harness (design)

**Status:** v1 — brainstormed, pre-implementation.
**Tracking issue:** none yet (test-only; open a follow-up if the harness surfaces a real defect).
**Charter rubric:** cross-cutting hardening — exercises the Goal 1 capture substrate, the Goal 2/3 detail/lineage writers, the Goal 5 reads, and the Goal 7 events under randomized, concurrent, adversarial load. Not a new charter goal; a confidence instrument for the descent-app trial.
**Lands:** directly on `develop` (test-only — no `src/` change except a backward-compatible `startHarness` options param), per CLAUDE.md's "bugfixes, chores, refactors, and docs may be committed directly."

## What ships

A seeded, randomized, concurrent chaos harness that drives N jobs of varied shape through varied outcomes, throws four kinds of "monkey" at the system, and asserts pg-bossier's `pgbossier.record` chronicle stays faithful.

1. **`test/battle/engine.ts`** — pure functions over `{ pool, boss }` (no vitest imports): a seeded PRNG (`mulberry32`), a workload planner, push/pull job drivers, the four chaos injectors, and the oracle assertions. Reusable and independently readable.
2. **`test/battle/battle.test.ts`** — the vitest orchestrator: runs the phases in order, gates the inherently-flaky monkeys behind an env flag, prints the seed.
3. **One tiny edit to `test/harness.ts`** — `startHarness(opts?: { supervise?: boolean; schedule?: boolean })`, defaulting to the current `false`/`false`, so the cron phase can request a supervise-on instance. Backward-compatible; every existing caller is unaffected.

No new runtime dependency. The seeded PRNG is ~5 lines. No new `src/` surface.

## Why

The existing tests are **deterministic, per-feature, single-threaded**: `capture.test.ts` drives one job through one lifecycle and checks one chronicle. They prove each codepath works in isolation. They do **not** prove the chronicle stays faithful when hundreds of jobs of mixed shape race through concurrent workers, nor that pg-bossier honors its load-bearing constraint — *audit writes are fail-open, they never block pg-boss ops* — when the audit path is actually broken, nor that the chronicle survives pg-boss deleting its source rows mid-flight.

Ahead of the descent-app validation trial, the useful question is: *does pg-bossier hold up under a real, messy, concurrent production workload?* That is what this harness answers, repeatably and in CI.

## Core idea: an oracle, not a smoke test

The harness keeps **ground truth** for every job it creates: queue, config (`retryLimit` / `priority` / `singletonKey` / optional `deadLetter`), the outcome sequence it drove, the expected number of attempt rows, and the expected terminal state. It then asserts the chronicle matches that ground truth.

Key property that makes exactness compatible with concurrency: **concurrency changes only interleaving, never a job's outcome.** A job planned to `fail→retry→complete` ends `completed` with 2 retry rows whether it ran alone or amid a storm. So the main workload can be driven fully concurrently and *still* assert exact per-job results.

Chaos that genuinely loses or perturbs data — fail-open outage, connection kill, background cron inserts — necessarily relaxes to **invariant-only** assertions (defined per phase below).

## Reproducibility

- Seeded PRNG (`mulberry32`). Seed resolved from `BATTLE_SEED` (default a fixed constant so CI is deterministic; `BATTLE_SEED=random` for local fuzzing).
- The seed is **printed at start and re-printed on any failure**, so any flake is reproducible by re-running with that exact seed.
- Scale knobs (env, with defaults): `BATTLE_N` (≈200 jobs), queue count (≈5), concurrent `work()` workers (≈4).

Note: `Math.random()` / `Date.now()` are fine here — the workflow-script ban on them does not apply to vitest tests. The PRNG is for *reproducibility*, not because randomness is unavailable.

## Workload variety (seeded, per job)

- **Consumption pattern** — both, racing on shared queues:
  - **push / worker**: a real `boss.work(queue, handler)`. The handler decides throw-vs-return from `job.retryCount` vs the job's plan, so the push path is deterministic regardless of poll timing.
  - **pull**: manual `send` → `fetch` → `complete`/`fail`.
- **Config**: randomized `retryLimit` (0–3), `priority`, a **unique** `singletonKey` per job (exercises the captured config columns without dedup muddying the oracle), and some jobs configured with a `deadLetter` queue.
- **Outcome plan**: one of `complete` / `fail-terminal` / `fail→retry→…→complete` / `fail→exhaust` / `cancel` / `sendAfter`-delayed.
- **Dedicated mini-cases** (not part of the randomized body, to keep that oracle exact): one singleton-dedup case (two sends, same key, one job) and one dead-letter case (`recordDeadLetter` → `findDeadLetterSource`/`findDeadLetterTarget` round-trip).

## Phases

| Phase | What it does | Assertion tier | Default CI |
|---|---|---|---|
| **A — Concurrency storm + oracle** | Build N planned jobs; drive them **all concurrently** (push handlers + pull drivers + `send` floods racing). This *is* the concurrency monkey. | **Exact** per job: row count == attempts; every non-final attempt state == `retry`; final state == expected terminal; `data` == sent; `priority`/`retry_limit`/`singleton_key` == sent config. **Global**: no duplicate `(job_id, attempt)`; all `seq` values distinct (the trigger consumes a fresh `nextval` on every fire) and `max(seq)` advances across the run — gaps are allowed, since `nextval` is consumed even on a caught trigger exception. **Events**: a `subscribe()` listener sees a terminal event for every terminal job (catch-up via `getEventsSince` tolerated). | ✅ |
| **B — Forensic-delete** | `DELETE` a seeded sample of `pgboss.job` rows (simulates `deletion_seconds` maintenance and the retry `DELETE`+`INSERT`). | **Survival**: `findById` / `getRetryHistory` still return the deleted jobs, with `data` / `output` / attempt history intact. | ✅ |
| **C — Fail-open** | Mid-run, **rename `pgbossier.record` away** (`ALTER TABLE … RENAME TO record__chaos`) so the trigger's INSERT fails and is swallowed by its `EXCEPTION WHEN OTHERS`. Drive a batch of jobs. Rename back. | **Invariant**: no pg-boss op throws or blocks during the outage; every job reaches its terminal state in `pgboss.job`; capture **resumes** — a fresh job created and driven *after* restore gets a complete, faithful chronicle. Rows for the outage window are legitimately absent — that is what fail-open *means*, and the test asserts that absence is tolerated, not that it doesn't happen. | ✅ |
| **D — Connection / pool kill** | `SELECT pg_terminate_backend(pid)` against the pool's and pg-boss's backends mid-batch, several rounds, then let it settle. | **Invariant**: no chronicle corruption (no duplicate PK; `seq` monotonic); **recovery** — a fresh `send → fetch → complete` after the storm is captured normally. | `BATTLE_CHAOS_FULL=1` |
| **E — Cron / scheduled** | A **separate `supervise:true, schedule:true`** harness on its own container (so background inserts can't perturb A–D's counts). `sendAfter(queue, data, opts, seconds)` delayed job asserted to run and be captured (fast). A real `boss.schedule(queue, '* * * * *')` registration asserted to fire and be captured, behind a >70 s wait. | **Exact** for the `sendAfter` job. **Loose** for real cron: every cron-fired job that reached a terminal state and still exists in `pgboss.job` has a faithful chronicle row. | sendAfter: ✅ · real cron: `BATTLE_CHAOS_FULL=1` |

## CI tiering

A `develop`/PR gate must not be flaky. So:

- **Default (`npm test`)** runs A, B, C, and the `sendAfter` part of E — all stable, ~30–60 s on top of the testcontainer.
- **`BATTLE_CHAOS_FULL=1`** (nightly / manual / local) additionally runs D (connection kill) and real cron in E — invariant-only, slower, occasionally retried.

Every monkey the user asked for is **built**. The flag governs only *where each runs*, keeping the gate green.

## Decisions locked

### 1. Fail-open break = rename the table, not drop the sequence

Renaming `pgbossier.record` away makes the trigger's `INSERT … VALUES` fail on a missing relation — caught by the function's inner `EXCEPTION WHEN OTHERS`. Fully reversible (`RENAME` back) and it **preserves `seq` and existing rows**, so the global `seq`-monotonic invariant still holds across the whole run. Dropping `record_seq` would also break capture, but recreating it resets `seq` to 1 and would falsely trip the monotonicity assertion. Rename wins.

### 2. Push path determinism via `job.retryCount`, not call ordering

The `work()` handler must produce a deterministic outcome without depending on poll timing. It looks up the job's plan and compares `job.retryCount` to the planned number of failures: `retryCount < plannedFails` → throw (pg-boss auto-retries/fails); else → return the planned output (pg-boss auto-completes). This makes the push path's chronicle exactly predictable even under the storm.

### 3. Unique `singletonKey` in the randomized body; dedup tested separately

Singleton dedup means same-key sends collapse to one job — a `send` can return `null`. Threading that through the per-job oracle would complicate every assertion for a behavior that one dedicated mini-case covers cleanly. So the randomized body uses unique keys (exercising the captured `singleton_key` column), and dedup gets its own focused case.

### 4. Cron on a separate container

Phases A–D assert exact counts and rely on `supervise:false, schedule:false` (the reason `harness.ts` sets them today — maintenance and cron loops would insert jobs mid-test and flake `count(*)`). Real cron needs both on. Running it against a **fresh, isolated** harness keeps the deterministic phases deterministic.

### 5. Exact vs invariant is a per-phase property, not a global mode

Phase A is exact *because* it runs chaos-free with respect to the audit path. The moment a phase breaks the audit path (C), kills connections (D), or invites background inserts (E), the assertions drop to the documented invariants. The harness never claims exactness it can't honor.

## Out of scope (and why)

- **Expiration / stalled-job enforcement** — needs `supervise` plus wall-clock timing; pg-bossier treats `expired` as a derived `terminal_detail` marker, not a pg-boss state. Could fold loosely into Phase E later if the trial asks for it; not built now.
- **Real cron under the default gate** — 1-minute cron granularity can't be a fast gate; hence the `BATTLE_CHAOS_FULL` long-timeout path.
- **Container kill / restart** — heavier than backend termination and mostly re-tests pg-boss's own durability, not pg-bossier's chronicle. Phase D's `pg_terminate_backend` is the proportionate connection-chaos monkey.
- **A standalone soak/CLI runner** — the user chose the seeded-CI-test form. `BATTLE_N` is the scale lever for manual hammering; a separate runner is a follow-up only if soak runs become routine.

## Verification

`npm run lint && npm run build && npm test` must pass (default tier). A separate manual run of `BATTLE_CHAOS_FULL=1 npm test` exercises the full monkey suite. Report actual output; never claim green on red.

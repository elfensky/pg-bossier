# Battle-test (chaos) harness (design)

**Status:** v2 — post-debate. Incorporates the eight named changes from the 5-way `/octo:debate` (Gemini, Codex, Copilot, Sonnet, Opus; 2 rounds), transcript at `~/.claude-octopus/debates/pg-bossier/001-consistent-testing-practices/`. Verdict was unanimous SHIP-WITH-NAMED-CHANGES.
**Tracking issue:** none yet (test-only; open a follow-up if the harness surfaces a real defect).
**Charter rubric:** cross-cutting hardening — exercises the Goal 1 capture substrate, the Goal 2/3 detail/lineage writers, the Goal 5 reads, and the Goal 7 events under randomized, concurrent, adversarial load. Not a new charter goal; a confidence instrument for the descent-app trial.
**Lands:** directly on `develop` (test-only — no `src/` change at all), per CLAUDE.md's "bugfixes, chores, refactors, and docs may be committed directly."

## What ships

A seeded, randomized, concurrent chaos harness that drives N jobs of varied shape through varied outcomes, throws chaos "monkeys" at the system, and asserts pg-bossier's `pgbossier.record` chronicle stays faithful.

1. **`test/battle/engine.ts`** — pure functions over `{ pool, boss }` (no vitest imports): a seeded PRNG (`mulberry32`), a workload planner, the plan-applying job drivers, the chaos injectors, the oracle assertions, and the failure-diagnostics emitter. Reusable and independently readable.
2. **`test/battle/battle.test.ts`** — the vitest orchestrator: runs the phases in order, gates the flaky monkey behind an env flag, prints the seed.

No new runtime dependency. The seeded PRNG is ~5 lines. No new `src/` surface, and no change to `test/harness.ts` — every phase runs on the existing `supervise:false, schedule:false` harness (real cron is cut; `sendAfter` needs no supervise).

## Why

The existing tests are **deterministic, per-feature, single-threaded**: `capture.test.ts` drives one job through one lifecycle and checks one chronicle. They prove each codepath works in isolation. They do **not** prove the chronicle stays faithful when hundreds of jobs of mixed shape race through concurrent workers, nor that pg-bossier honors its load-bearing constraint — *audit writes are fail-open, they never block pg-boss ops* — when the audit path is actually broken, nor that the chronicle survives pg-boss deleting its source rows mid-flight.

Ahead of the descent-app validation trial, the useful question is: *does pg-bossier hold up under a real, messy, concurrent production workload?* That is what this harness answers, repeatably and in CI.

## Tier placement (what this is and isn't)

Per the debate's tooling survey, this harness sits in the **"library correctness under load"** tier (Tokio / Crossbeam / vitest-suite style) — **not** the deterministic-simulation tier (FoundationDB / TigerBeetle VOPR / madsim / turmoil) and **not** the distributed-chaos tier (Jepsen / Toxiproxy). We don't own the runtime, so byte-level execution replay is impossible by construction. We also don't reach for property-based frameworks (`fast-check` / Hypothesis) — see Decision 7. And it is **not** a benchmark: performance lives in the existing `tinybench`-based `test/perf/chronicle-scale.bench.ts` (criterion/JMH-style fixed-fixture sampling). Correctness-under-load and performance stay separate suites; this doc cross-references the bench, does not merge with it.

## Core idea: an oracle, with bounded exactness

The harness keeps **ground truth** for every job it creates: queue, config (`retryLimit` / `priority` / `singletonKey` / optional `deadLetter`), the outcome sequence it drove, the expected number of attempt rows, and the expected terminal state. It then asserts the chronicle matches that ground truth.

The property that makes exactness compatible with concurrency, **stated precisely**: concurrency changes interleaving and *cross-job ordering*, but **not a single job's own outcome**, *provided the drivers act on the job they were handed and retry transient DB errors* (Drivers, below). So:

- **Per-`job_id` facts are asserted exactly** — that job's own attempt count, the state of each of its attempts, its `data`, its captured config. These are interleaving-invariant.
- **Cross-job facts are asserted as invariants, never exactly** — no duplicate `(job_id, attempt)`, all `seq` values distinct, `max(seq)` advances. There are **no** assertions about cross-job ordering, relative timestamps between different jobs, or array position. (Those *are* nondeterministic under a real concurrent Postgres workload — the debate's central correction. Asserting them would flake; we don't write them.)
- Chaos that genuinely loses data — fail-open outage, connection kill — relaxes even per-job assertions to the documented invariants for that phase.

## Reproducibility — and its honest boundary

- Seeded PRNG (`mulberry32`). Seed from `BATTLE_SEED` (default a fixed constant so CI is deterministic; `BATTLE_SEED=random` to fuzz locally). Scale knobs: `BATTLE_N` (≈200 jobs), queue count (≈5), concurrent `work()` workers (≈4).
- **The boundary, stated in the harness header so nobody loses an afternoon to it:** the seed reproduces the **job plan set** (which jobs get which config and outcome), *not* the execution interleaving. pg-boss polling, the Node event loop, and Postgres lock/commit ordering are nondeterministic; re-running the same seed gives the same *planned outcomes*, not the same *schedule*. That is exactly enough for the bounded-exact oracle above and no more.
- **Replay diagnostics (hard requirement, not optional).** On any assertion failure the harness emits a full **fingerprint** — `BATTLE_SEED`, `BATTLE_N`, worker count, phase, queue, `jobId`, `attempt`, and expected-vs-actual — **and** persists the failing job's plan (and the run's plan set) to a file. A single-case replay mode (`BATTLE_ONLY_JOB=<jobId>` / load a persisted plan JSON) re-runs one job's plan in isolation. This recovers ~90% of what property-based shrinking would give us (Decision 7) and is the difference between a useful and a useless chaos test.

Note: `Math.random()` / `Date.now()` are fine here — the workflow-script ban on them does not apply to vitest tests. The PRNG is for *reproducibility*, not because randomness is unavailable.

## Drivers (the linchpin)

Under the storm, `boss.fetch(queue)` returns an **arbitrary available job, never "this driver's job."** So a per-job pull loop that assumes its `fetch` returned its own job is broken by construction. Both consumption patterns therefore **apply the plan to whatever job they receive**, keyed on the received job's `id` + `retryCount`:

- **push / worker**: a real `boss.work(queue, handler)`. The handler looks up the received job's plan and compares `job.retryCount` to its planned failure count: `retryCount < plannedFails` → throw (pg-boss auto-retries/fails); else → return the planned output (auto-completes). Deterministic per job regardless of poll timing or which worker wins.
- **pull**: `fetch` a batch, then for **each fetched job** look up *its* plan (by `id`) and `complete`/`fail` per that plan and its `retryCount` — identical decision logic to the handler. Never assumes identity.

**Transient-error handling.** Driver operations (`fetch` / `complete` / `fail`) retry on transient Postgres errors — `40001` serialization failure, lock timeout, connection reset, pool exhaustion — with bounded backoff. Critically, a retry **reads back the job's current state first** and reconciles, so an ambiguous commit (connection lost *after* Postgres committed) does not double-apply. With this, a transient error is a *driver* hiccup, not a changed job *outcome*, and the per-job exact assertions hold honestly.

## Workload variety (seeded, per job)

- **Consumption pattern**: push/worker and pull, racing on shared queues (see Drivers).
- **Config**: randomized `retryLimit` (0–3), `priority`, a **unique** `singletonKey` per job (exercises the captured config columns without dedup muddying the oracle), some jobs with a `deadLetter` queue.
- **Outcome plan**: one of `complete` / `fail-terminal` / `fail→retry→…→complete` / `fail→exhaust` / `cancel` / **`sendAfter`-delayed** (short delay, e.g. 1 s — the scheduled/delayed shape; becomes fetchable after the delay and is then driven to its planned outcome like any other job; needs no `supervise`).
- **Dedicated mini-cases** (outside the randomized body, to keep that oracle clean): a singleton-dedup case (two sends, same key → one job) and a dead-letter case (`recordDeadLetter` → `findDeadLetterSource`/`findDeadLetterTarget` round-trip).

## Phases

| Phase | What it does | Assertion tier | Default CI |
|---|---|---|---|
| **A — Concurrency storm + oracle** | Build N planned jobs (incl. `sendAfter`-delayed); drive them **all concurrently** via the plan-applying push handlers + pull drivers + `send` floods racing. This *is* the concurrency monkey. | **Exact, per `job_id` only**: that job's row count == attempts; each non-final attempt state == `retry`; final state == expected terminal; `data` == sent; `priority`/`retry_limit`/`singleton_key` == sent config. **Invariants (cross-job)**: no duplicate `(job_id, attempt)`; all `seq` distinct; `max(seq)` advances. **No** cross-job ordering / timestamp / array-position assertions. **Events**: assert via `getEventsSince` **catch-up** (the authority) that every terminal job has a terminal event; the live `subscribe()` listener is exercised but its delivery is **not** asserted exactly (NOTIFY isn't guaranteed under load). | ✅ |
| **B — Forensic-delete** | `DELETE` a seeded sample of `pgboss.job` rows (simulates `deletion_seconds` maintenance and the retry `DELETE`+`INSERT`). | **Survival**: `findById` / `getRetryHistory` still return the deleted jobs, with `data` / `output` / attempt history intact. | ✅ |
| **C — Fail-open** | Mid-run, **rename `pgbossier.record` away** (`ALTER TABLE … RENAME TO record__chaos`) so the trigger's INSERT fails and is swallowed by its `EXCEPTION WHEN OTHERS`. Drive a batch. Rename back. | **Invariant**: no pg-boss op throws or blocks during the outage; every job reaches its terminal state in `pgboss.job`; capture **resumes** — a fresh job created and driven *after* restore gets a complete, faithful chronicle. Outage-window rows are legitimately absent (that is what fail-open *means*); the test asserts that absence is tolerated. | ✅ |
| **D — Connection / pool kill** | `SELECT pg_terminate_backend(pid)` against the pool's and pg-boss's backends mid-batch, several rounds, then settle. | **Fail-open atomicity contract only** (the sole pg-bossier-specific signal): for every job, the chronicle holds **a complete row or no row — never a partial/orphan**; and capture **recovers** (a fresh `send → fetch → complete` after the storm is captured normally). **No** job-outcome, timing, or NOTIFY-completeness assertions — those test Postgres/pg-boss, not pg-bossier. Carries `test.retry(2)` to separate infra noise from real failures. | `BATTLE_CHAOS_FULL=1` |

## CI tiering

A `develop`/PR gate must not be flaky. So:

- **Default (`npm test`)** runs A, B, C — all stable (the `sendAfter`-delayed shape is folded into A; it needs no wall-clock sleep beyond ~1 s and no `supervise`). ~30–60 s on top of the testcontainer.
- **`BATTLE_CHAOS_FULL=1`** (nightly / manual / local) adds D (connection kill) — contract-scoped, `test.retry(2)`.

## Decisions locked

### 1. Fail-open break = rename the table, not drop the sequence
Renaming `pgbossier.record` away makes the trigger's `INSERT … VALUES` fail on a missing relation — caught by the function's inner `EXCEPTION WHEN OTHERS`. Fully reversible (`RENAME` back) and it **preserves `seq` and existing rows**, so the global `seq` invariant still holds across the run. Dropping `record_seq` would reset `seq` to 1 and falsely trip the distinctness/advance invariant. Rename wins.

### 2. Drivers apply the plan to the job they receive; never assume `fetch` identity
The debate's linchpin. `fetch` returns an arbitrary available job under concurrency, so both push and pull decide outcome from the *received* job's `id` + `retryCount` (see Drivers). This is what makes per-job exact assertions achievable concurrently — without it, a per-job pull loop would complete/fail the wrong job and the oracle would be meaningless.

### 3. Transient DB errors are retried with read-back reconciliation
Driver ops retry `40001` / lock-timeout / connection-reset / pool-exhaustion, reading back state before re-applying so an ambiguous commit can't double-fire. This keeps a transient error a *driver* hiccup rather than a changed *outcome* — the precondition under which Phase A's exact assertions are honest rather than flaky.

### 4. Exact is per-`job_id`; cross-job is invariant-only
Per-job own facts are interleaving-invariant and asserted exactly. Cross-job ordering, relative timestamps, and array position are nondeterministic under real concurrency and are **never** asserted. Cross-job structural facts (no dup PK, `seq` distinct + advancing) are invariants. This is the bounded form of the original "outcome-invariant" claim, corrected by R2.

### 5. Events asserted via `getEventsSince` catch-up, not live delivery
`pg_notify` delivery to a live `LISTEN` connection is best-effort and can drop under load. So the event assertion uses the durable `getEventsSince(seq)` catch-up read as the authority (every terminal job has a terminal event there); the live `subscribe()` path is exercised for smoke but not asserted for exact delivery.

### 6. Connection-kill kept (gated), scoped to the fail-open contract; real cron cut
Phase D's only pg-bossier-specific signal is the trigger's atomicity-under-transport-failure: a complete chronicle row or none, never a partial, plus recovery. That *is* pg-bossier's contract (the trigger fires inside pg-boss's transaction), so it's worth keeping — gated, contract-scoped, `test.retry(2)`. **Real cron is cut entirely**: a `* * * * *` tick needs a >60 s CI sleep (a "cardinal sin") and tests pg-boss's scheduler, not pg-bossier's chronicle. The `sendAfter`-delayed outcome variant covers the scheduled/delayed path with no sleep and no separate container.

### 7. Keep `mulberry32`; do not adopt `fast-check`
The only thing a property-based framework buys here is automatic shrinking. Our "input" is structured ~200-job semantic plans, which don't shrink cleanly with generic generators (risk of misleading minimized cases), and the persisted-failing-plan + fingerprint (Reproducibility) recovers ~90% of shrinking's value at this scale. Adding a dependency for the rest violates KISS / no-new-deps. Revisit only if repeated painful triage proves it pays.

## Out of scope (and why)

- **Real cron / `* * * * *` ticks** — cut per Decision 6 (CI-sleep cardinal sin; tests pg-boss's scheduler). `sendAfter`-delayed covers the scheduled shape.
- **Expiration / stalled-job enforcement** — needs `supervise` plus wall-clock timing; pg-bossier treats `expired` as a derived `terminal_detail` marker, not a pg-boss state. Not built now.
- **Container kill / restart** — heavier than backend termination and mostly re-tests pg-boss's durability, not pg-bossier's chronicle. Phase D's `pg_terminate_backend` is the proportionate connection-chaos monkey.
- **`fast-check` / property-based shrinking** — Decision 7.
- **Benchmarking** — separate suite (`test/perf/chronicle-scale.bench.ts`); this is correctness-under-load.
- **A standalone soak/CLI runner** — the user chose the seeded-CI-test form. `BATTLE_N` is the scale lever; a separate runner is a follow-up only if soak runs become routine.

## Verification

`npm run lint && npm run build && npm test` must pass (default tier: A, B, C). A separate manual run of `BATTLE_CHAOS_FULL=1 npm test` exercises Phase D. Report actual output; never claim green on red.

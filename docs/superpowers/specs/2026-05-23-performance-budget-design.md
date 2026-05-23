# Performance budget — first measurement: design

**Date:** 2026-05-23
**Sub-issue:** [#12](https://github.com/elfensky/pg-bossier/issues/12)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design — pre-implementation. Builds on the substrate (PR #15), Goal 5 read API (PR #17), and Goal 8 compat-doc tightening (PR #20).

---

## Summary

pg-bossier gains its first published performance numbers. A new vitest file populates 1,000 jobs through pg-boss's real public API in two testcontainers — one with `pgbossier.install` and one without — measures the per-state-transition overhead the capture trigger introduces, then samples each of the seven Goal 5 read methods 100 times against the populated chronicle, recording mean and p99 latency. The first run's p99 (times a 2× headroom factor, rounded) becomes the published budget per method, recorded in a new `PERFORMANCE.md` at the repo root. The test runs via `npm run test:perf`, separate from the default fast suite (`npm test`). Issue [#12](https://github.com/elfensky/pg-bossier/issues/12) closes by decision; a follow-up sub-issue carries the larger-scale extensions, CI gating, and violation-policy work.

---

## Context — what is already built

- **`pgbossier.record`** chronicle table — one row per `(job_id, attempt)`. Six indexes (3 GIN on `data`/`output`/`terminal_detail`, 2 btree on `(queue, state)` and `captured_at`, 1 partial btree on `(queue, started_on) WHERE state = 'active'`). The trigger's cost is dominated by GIN maintenance.
- **`pgbossier.capture()`** trigger function + `pgbossier_capture` trigger on `pgboss.job` — fires AFTER INSERT OR UPDATE OF state, inside a PL/pgSQL subtransaction (`BEGIN … EXCEPTION WHEN OTHERS …`). One `INSERT … ON CONFLICT DO UPDATE` into `pgbossier.record` per invocation.
- **Goal 5 operational read API** (PR #17) — `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning` on the `bossier` client. These are exactly what descent-app's raw-SQL queries will migrate onto, per [descent-app#343](https://github.com/drunikbe/descent-app/issues/343).
- **`test/harness.ts`** — existing testcontainer harness providing `withTestEnv` helper that spins up Postgres + pg-boss + (optionally) pg-bossier. Reusable as-is.
- **CI** (`.github/workflows/ci.yml`) — runs `npm run lint && npm run build && npm test` on every push and PR. The Goal 8 tripwire job is separate. The perf test will NOT be in the default CI run in v1.

---

## Goals and non-goals

### What this design ships

1. A vitest perf test file at `test/perf-chronicle-scale.test.ts` that runs the full populate-then-measure sequence end-to-end.
2. An `npm run test:perf` script that runs only this file (matching vitest's filter or naming convention).
3. A new `PERFORMANCE.md` at the repo root with: methodology, first-measurement numbers, published budgets per method, how to run, how to interpret, and the list of deferred follow-ups.
4. A `CHANGELOG.md` `## [Unreleased]` → `## Added` entry naming the perf test surface.
5. Closure of issue #12 (by decision, with a follow-up sub-issue opened for the larger work).

### What this design deliberately does NOT ship

- **Scale beyond 1,000 jobs.** 10k/100k/1M extensions are explicit follow-ups in the new sub-issue.
- **Failure-injection / retry-path measurement.** Happy-path populate only — every job completes successfully on first attempt.
- **Active-jobs scenarios.** `listLongRunning` is measured but returns `[]` (no active jobs after populate); no scenario keeps jobs active.
- **Multi-queue cardinality.** All 1k jobs land in a single queue (`perf-queue`).
- **Concurrent workers.** Sequential single-process populate and sampling.
- **CI integration.** The perf test does NOT run in the default `npm test` invocation, is NOT a job in `.github/workflows/ci.yml`. It's opt-in via `npm run test:perf`.
- **Hard budget assertions in v1.** Vitest assertions are sanity-only (e.g. p99 < 1000ms, per-state-change overhead < 50ms). The published budget numbers in `PERFORMANCE.md` are human-readable targets, not test failures.
- **Per-feature budget allocation.** No "Goal 7 gets X% of the overhead budget" math. The budget is per-method, not per-goal.
- **Violation policy.** No documented rule for "if a PR exceeds the budget, what happens."

---

## Locked decisions

### Decision 1 — Two-container populate strategy

Phase 1: install pg-boss schema only (no `pgbossier.install`). Send/fetch/complete 1k jobs. Record total wall-clock = `T_baseline_lifecycle`. Tear container down.

Phase 2: fresh testcontainer, install pg-boss schema **and** `pgbossier.install`. Send/fetch/complete the same 1k jobs. Record `T_with_trigger`. Container stays alive for phase 3.

Per-state-transition overhead = `(T_with_trigger − T_baseline_lifecycle) / 3000`. The 3000 divisor reflects 3 trigger fires per happy-path job (created, active, completed). This is the published "capture-trigger overhead" number.

**Why two containers and not one with uninstall/reinstall:** uninstall drops the `pgbossier` schema; reinstalling and re-populating in the same container would have warm OS caches and PG buffer state from phase 1. Two cold containers give a cleaner comparison. The cost is a few extra seconds of testcontainer startup.

### Decision 2 — Single-queue happy-path populate

All 1k jobs land in `perf-queue`. All complete successfully on first attempt. No failures, no retries. After populate, all 1k chronicle rows have `state = 'completed'` and `attempt = 1`.

**Why:** keeps the populate simple and reproducible. Variants (multi-queue, retries, mixed states) are explicit follow-ups, not in this branch.

### Decision 3 — Sampling: 100 samples per method, `performance.now()`, mean + p99

Each measurement is 100 sequential calls of the method, each wrapped in `performance.now()` deltas. Compute mean and p99 over the 100-sample array. Median included in the printed table for diagnostic value (catches multimodal distributions) but not part of the published budget.

**Why mean + p99:** mean for stability/reproducibility checking across runs; p99 for the tail-aware budget number. Full distribution (p50/p95/p99) is deferred — adds reporting verbosity without clear v1 value.

### Decision 4 — Budget rule: first-measurement p99 × 2.0, rounded

The published budget per method = first-measurement p99 × 2.0, rounded to one significant figure. Generous headroom because we don't yet know the run-to-run variance.

**Why 2×:** a 2× regression on a CI-noisy metric is unambiguously a real problem; smaller regressions are probably noise. When we extend to 10k+ in a follow-up and observe stddev, we tighten — likely to ~1.3×.

### Decision 5 — Loose vitest assertions, doc-only published budgets

The perf test's vitest `expect()` calls assert only obviously-broken bounds:

```ts
expect(samples.length).toBe(100);
expect(p99).toBeLessThan(1000); // 1 sec per call = broken
expect(triggerOverheadPerStateChange).toBeLessThan(50); // 50ms = broken
```

The published budget numbers in `PERFORMANCE.md` are NOT test assertions in v1. Why: the perf test runs on varying local hardware (contributor laptops differ); CI integration with a stable runner is a follow-up. Hard-asserting on absolute numbers would flake.

### Decision 6 — Methodology lives in `PERFORMANCE.md` at the repo root

New file, not a section in `COMPATIBILITY.md` or `README.md`. Reasons:
- Performance and compatibility are distinct concerns.
- `README.md` already has install / usage focus; perf numbers don't belong there.
- Future scenarios (10k/100k/1M, retry-path, CI integration) accumulate in one place over time.

---

## What this branch ships

### `test/perf-chronicle-scale.test.ts` — the perf vitest file

Pseudocode shape:

```ts
import { describe, beforeAll, it, expect } from 'vitest';
import { withTestEnv } from './harness';
import { bossier } from '../src/index';
// (additional imports for pg-boss public API and crypto.randomUUID)

describe('Perf — chronicle scale (1k jobs)', () => {
  let knownJobId: string;
  let bench: BenchHarness; // collects samples, computes mean/p99

  beforeAll(async () => {
    // Phase 1: baseline populate, no trigger
    const tBaseline = await withTestEnv({ installPgbossier: false }, async ({ boss }) => {
      const t0 = performance.now();
      await populateLifecycle(boss, 1000);
      return performance.now() - t0;
    });

    // Phase 2: with-trigger populate
    const env = await withTestEnv({ installPgbossier: true });
    const t0 = performance.now();
    const jobIds = await populateLifecycle(env.boss, 1000);
    const tWithTrigger = performance.now() - t0;

    bench.recordTriggerOverhead({
      tBaseline,
      tWithTrigger,
      stateTransitions: 3000,
    });

    knownJobId = jobIds[500]; // median-position pick

    // Phase 3: query measurements (against env.bossier)
    const b = bossier({ boss: env.boss, pool: env.pool });
    await bench.sampleMethod('findById(known)', 100, () => b.findById(knownJobId));
    await bench.sampleMethod('findById(unknown)', 100, () => b.findById(crypto.randomUUID()));
    await bench.sampleMethod('getRetryHistory(known)', 100, () => b.getRetryHistory(knownJobId));
    await bench.sampleMethod('listJobs(no filter)', 100, () => b.listJobs({}));
    await bench.sampleMethod("listJobs(state='completed')", 100, () => b.listJobs({ state: 'completed' }));
    await bench.sampleMethod("listJobs(queue='perf-queue')", 100, () => b.listJobs({ queue: 'perf-queue' }));
    await bench.sampleMethod("latestPerQueue(['perf-queue'])", 100, () => b.latestPerQueue(['perf-queue']));
    await bench.sampleMethod('countByState({})', 100, () => b.countByState({}));
    await bench.sampleMethod('countByQueue({})', 100, () => b.countByQueue({}));
    await bench.sampleMethod('listLongRunning({900})', 100, () => b.listLongRunning({ olderThanSeconds: 900 }));

    // Print markdown table to stdout
    bench.report();
  }, /* timeout */ 5 * 60_000);

  it('captures the 1k populate and 10 query samples without obvious breakage', () => {
    expect(bench.allMeasurements().length).toBeGreaterThanOrEqual(11); // trigger + 10 methods
    for (const m of bench.allMeasurements()) {
      expect(m.p99).toBeLessThan(1000);
    }
    expect(bench.triggerOverheadPerStateChange()).toBeLessThan(50);
  });
});
```

`BenchHarness` is a small in-file helper class (not a separate module) — encapsulates the sample-array bookkeeping, percentile math, and the markdown-table printer. Pure data-in/data-out, easy to test by inspection.

`populateLifecycle(boss, n)` creates the queue, sends `n` jobs (one at a time or in small batches — pg-boss API decides), fetches them all, completes them all. Returns the array of job IDs. Uses default pg-boss config.

### `package.json` — new script

```json
"test:perf": "vitest run test/perf-chronicle-scale.test.ts"
```

### `PERFORMANCE.md` — repo root

Sections:
1. **What this measures** — paragraph naming the 7 read methods + the trigger-overhead calc, the 1k-job populate via full pg-boss lifecycle, single-process.
2. **What this does NOT measure** — explicit list (scale beyond 1k, concurrent workers, retry-path, multi-queue, etc.) cross-referencing the follow-up sub-issue.
3. **First measurement (YYYY-MM-DD, `<hardware caveat>`)** — markdown table with the raw numbers from running the perf test once, in a clean state.
4. **Published budgets** — table with one budget number per method = first-measurement p99 × 2 (rounded).
5. **How to run** — `npm run test:perf`. Hardware caveats (contributor laptop variation).
6. **How to interpret** — when a number from a fresh run exceeds the published budget by >50%, treat as a likely real regression and investigate before merging.
7. **Future scenarios** — bulleted follow-up list (links to the new sub-issue).

The first-measurement and published-budget tables are populated by running the test once locally during implementation; the actual numbers are not in this design (they don't exist yet).

### `CHANGELOG.md` — `## [Unreleased]` → `### Added`

Single entry:

> A first-measurement performance bench at `test/perf-chronicle-scale.test.ts`, runnable via `npm run test:perf`. Populates 1,000 jobs through pg-boss's full lifecycle, measures the capture trigger's per-state-transition overhead, samples each of the seven Goal 5 read methods 100 times, and reports mean + p99. Published per-method budgets recorded in `PERFORMANCE.md`. Resolves issue [#12](https://github.com/elfensky/pg-bossier/issues/12); scale extensions, CI integration, and budget violation policy continue as follow-up #\<FOLLOW_UP\>.

### Follow-up sub-issue (opened in this branch, scoped here)

Title: "Goal 8 / Performance follow-up: scale extensions, CI integration, and budget violation policy."

Body covers:
- **Scale extensions** — 10k, 100k, 1M-job perf tests (likely as separate `test/perf-chronicle-NNk.test.ts` files). Naming and split decision live there.
- **Failure-injection variants** — populate with mid-lifecycle failures so `getRetryHistory` and the retry-path are measured.
- **Multi-queue cardinality** — multi-queue populates exercise `latestPerQueue` and `countByQueue` at realistic cardinality.
- **Active-jobs scenarios** — populate that keeps some jobs in `active` so `listLongRunning` returns non-empty.
- **CI integration** — a separate GitHub Actions workflow (probably manually-triggered or release-tagged) that runs `npm run test:perf` on a stable runner and uploads the result table as an artifact.
- **Hard budget assertions** — once CI runs on a stable runner, tighten the test assertions to gate on published-budget numbers instead of sanity-only bounds.
- **Per-feature budget allocation** — if and when it earns its keep.
- **Violation policy** — what happens when CI sees a >2× regression. Block PR merge? Comment with the regression? TBD.

### `CLAUDE.md` — post-merge sync (separate commit on develop)

Same pattern as Goal 8: mention #12's closure and the follow-up issue in the Project-status paragraph and update the Implementation-progress table row (this one's a cross-cutting row, not a goal row).

---

## Verification

Before claiming the branch complete:

- `npm run lint && npm run build && npm test` — pass. No src/ changes; should be identical to baseline.
- `npm run test:perf` — completes within a few minutes, prints the markdown table, no test failures.
- The first-measurement numbers from a clean local run are pasted into `PERFORMANCE.md`'s "First measurement" section.
- Published budgets in `PERFORMANCE.md` are first-measurement p99 × 2, rounded.
- `<FOLLOW_UP>` is substituted everywhere with the real issue number opened during implementation.
- Visual check: every link in `PERFORMANCE.md`, the new sub-issue, and the #12 closing comment resolves.

---

## Parallel-track rationale

Touches: `test/perf-chronicle-scale.test.ts` (new), `package.json` (new script line), `PERFORMANCE.md` (new), `CHANGELOG.md` (one line), `CLAUDE.md` (post-merge on develop).

Does NOT touch any `src/` file, the trigger function, the install path, any existing test file, or `.github/workflows/ci.yml`.

Net merge-conflict surface area with Goal 7 (in flight in parallel): essentially `CHANGELOG.md` and `CLAUDE.md` line-adds only. Acceptable.

---

## Workflow

Per CLAUDE.md's "large features go through a worktree → branch → `--no-ff` merge":

1. `git worktree add .worktrees/performance-budget -b feature/performance-budget develop`
2. Implement per the implementation plan (writing-plans skill).
3. Run `npm run test:perf` locally; paste numbers into `PERFORMANCE.md`.
4. Open follow-up sub-issue on GitHub; substitute `<FOLLOW_UP>` everywhere.
5. Open PR from `feature/performance-budget` → `develop`.
6. After PR merge: post #12 closing comment, close #12, sync `CLAUDE.md` on develop, clean up worktree.

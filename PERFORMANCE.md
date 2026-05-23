# Performance

This file is the published record of pg-bossier's query performance against the chronicle table. It captures the methodology, the first measured numbers, and the per-method published budgets. The design decisions that produced this methodology — including how budgets are set, what the bench covers, and what is explicitly out of scope — are documented in `docs/superpowers/specs/2026-05-23-performance-budget-design.md`.

## What this measures

The bench (`test/perf/chronicle-scale.bench.ts`) runs in a single process against a real Postgres instance (via testcontainers). It begins with a warmup phase: 100 jobs are sent, fetched, and completed through pg-boss's normal lifecycle, then discarded — these do not appear in the measurements. After warmup, pg-bossier is installed and 1,000 jobs are populated through the pg-boss happy-path lifecycle (send → fetch → complete), which fires three trigger captures per job into the chronicle table. Each of the ten Goal 5 read methods is then sampled 100 times via vitest's `bench()` (pinned to `iterations: 100, time: 0, warmupIterations: 0` so the sample count is deterministic). vitest's underlying tinybench computes mean, median, p99, sd, and related stats per method. The numbers are surfaced both as a console table (default reporter) and as a structured `perf-output.json` (issue #23 CI history).

> **Note (issue #23):** The bench was restructured from a hand-rolled `it()`-based sampler to vitest's `bench()` blocks on 2026-05-23. The methodology change means the first-measurement numbers below are **soft-invalidated** — they are kept here for historical reference. The new baseline of record is what CI publishes to the `perf-metrics` orphan branch (see "CI-anchored history" below). Per-method published budgets in the next section retain their 2.0×-of-first-measurement headroom and remain the operational guardrail until ≥20 develop runs accumulate, at which point they will be re-derived from the CI baseline.

## What this does NOT measure

- Scale beyond 1,000 jobs (→ follow-up #21).
- Per-state-change trigger overhead — the populate-time-delta methodology was found unreliable at N=1000: JIT compilation and connection-pool cache effects produce noise the same order of magnitude as the trigger's actual contribution, yielding inconsistent and sometimes negative numbers across runs. The real safety net for trigger overhead is direct DB-side timing (e.g. `pg_stat_statements` or per-call `EXPLAIN ANALYZE`), tracked in #21.
- Failure / retry path lifecycles — only the happy-path (send → fetch → complete) is exercised.
- Multi-queue cardinality — a single queue (`perf-queue`) is used throughout.
- Concurrent workers — the bench is single-process and sequential.
- Active-jobs scenarios — all jobs are `completed` by the time queries run; `listLongRunning` returns an empty result set, but its query path is still timed.
- Stable-hardware CI — the bench runs on contributor hardware; CI integration is tracked in #21.

## First measurement (2026-05-23)

Captured on a developer laptop (macOS + Docker Desktop); absolute numbers will differ on other hardware.

| Method                                | mean (ms) | median (ms) | p99 (ms) |
|---------------------------------------|-----------|-------------|----------|
| findById(known)                       |      0.48 |        0.38 |     2.06 |
| findById(unknown)                     |      0.60 |        0.51 |     1.38 |
| getRetryHistory(known)                |      0.56 |        0.51 |     1.21 |
| listJobs({})                          |      2.73 |        2.35 |     7.99 |
| listJobs({state:'completed'})         |      1.91 |        1.78 |     2.89 |
| listJobs({queue:'perf-queue'})        |      1.60 |        1.55 |     2.51 |
| latestPerQueue(['perf-queue'])        |      2.00 |        1.84 |     3.46 |
| countByState({})                      |      0.87 |        0.78 |     1.81 |
| countByQueue({})                      |      0.71 |        0.62 |     1.79 |
| listLongRunning({900})                |      0.27 |        0.25 |     0.50 |

## Published budgets

Published budget per method = first-measurement p99 × 2.0, rounded to a single significant digit. Generous headroom because run-to-run p99 variance at N=1000 with 100 samples is real — a single outlier sample shifts the metric significantly. When the bench extends to higher N in follow-up #21, the variance shrinks and headroom can tighten.

| Method                          | First-measurement p99 | Published budget |
|---------------------------------|-----------------------|------------------|
| findById(known)                 | 2.06 ms               | 5 ms             |
| findById(unknown)               | 1.38 ms               | 3 ms             |
| getRetryHistory(known)          | 1.21 ms               | 3 ms             |
| listJobs({})                    | 7.99 ms               | 20 ms            |
| listJobs({state:'completed'})   | 2.89 ms               | 6 ms             |
| listJobs({queue:'perf-queue'})  | 2.51 ms               | 6 ms             |
| latestPerQueue(['perf-queue'])  | 3.46 ms               | 8 ms             |
| countByState({})                | 1.81 ms               | 5 ms             |
| countByQueue({})                | 1.79 ms               | 5 ms             |
| listLongRunning({900})          | 0.50 ms               | 1 ms             |

## How to run

Run the performance bench with:

```sh
npm run test:perf
```

This invokes `vitest bench --config vitest.perf.config.ts --run`. The default benchmark reporter prints a sorted comparison table to stdout, and the JSON reporter writes `perf-output.json` for downstream tooling.

To inspect the JSON output:

```sh
cat perf-output.json | jq '.files[].groups[].benchmarks[] | {name, mean, median, p99}'
```

## How to interpret

When a fresh run on similar hardware produces numbers more than 2× the published budget across multiple consecutive runs, treat it as a likely real regression and investigate. A single noisy run exceeding the budget is not enough — three runs is the minimum for confidence. Hardware variation means absolute numbers do not transfer across machines; the budgets are calibrated to developer-laptop hardware and should be re-baselined if the bench moves to a different class of runner.

## Observed variance (informational)

Three runs were taken for the first measurement (runs 7, 8, and 9 of the bench). Runs 7 and 9 produced consistent numbers, broadly in line with the table above. Run 8 produced p99s 5–50× higher across the board — likely caused by transient host load during that run rather than any change in the code or schema. This documents what the bench's noise looks like at N=1000 with 100 samples: tail metrics are sensitive to a single outlier, and host-level interference is real. It is the reason the published budget uses a 2.0× multiplier and the interpretation guidance requires three consecutive runs before treating an exceedance as a regression.

## CI-anchored history (issue #23)

The laptop-based first measurement is too noisy and environment-specific to anchor regression detection. Issue #23 layers a CI-anchored history on top of the bench:

- `.github/workflows/perf-history.yml` runs the bench on every `push` to `develop`, then appends one JSONL record to `perf-metrics.jsonl` on the orphan **`perf-metrics`** branch. The record includes the runner fingerprint (image OS, image version, CPU model, Node version, vitest version, package-lock hash) so a runner-image drift can be detected as a separate signal from a code regression.
- `.github/workflows/perf-pr.yml` runs the bench on every pull request, fetches the latest develop record from `perf-metrics`, and writes a Markdown diff to `$GITHUB_STEP_SUMMARY`. The diff applies thresholds — `🟡 elevated` at mean >+50% or p99 >+100%; `🔴 regression` at mean >+100% or p99 >+400%. A 🔴 fails the `perf-regression` status check (non-required in branch protection — visibility without blocking).
- `scripts/perf-write.mjs` and `scripts/perf-compare.mjs` implement the JSONL writer and the PR comparer. Both are stdlib-only Node scripts.
- One-time orphan-branch init: see `docs/perf-metrics-init.md`.

A baseline is considered **stale** when it is older than 14 days or its fingerprint differs from the PR run; in that case the comparison still renders but the summary flags it. Treat 🔴 with a stale-baseline warning as suspect until fresh develop runs replenish the chronicle.

## Future scenarios (follow-up #21)

- 10k / 100k / 1M-job scale extensions (likely separate `test/perf/chronicle-NNk.bench.ts` files).
- **Direct DB-side trigger-overhead measurement** (e.g. `pg_stat_statements` / per-call `EXPLAIN ANALYZE` — the populate-time-delta approach failed at N=1000 because warmup noise dominates; this is the right path forward for measuring per-trigger cost).
- Failure-injection variants so `getRetryHistory` exercises real retry chains.
- Multi-queue cardinality populates.
- Active-jobs scenarios for `listLongRunning`.
- Hard budget assertions (tighten the v1 sanity-only assertions into enforced CI gates).
- Per-feature budget allocation (only if it earns its keep).
- Violation policy (when 🔴 starts blocking merges — needs ≥20 develop runs first to characterize the runner's noise floor).

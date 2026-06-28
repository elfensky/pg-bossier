# Performance

This is the **single authoritative document** for pg-bossier's performance measurement system. It covers: what the bench measures, how to run it, how to read the output, where historical data lives, the regression thresholds, and how to interpret a 🔴 status check on a PR.

The system has two halves:

1. **The bench** — `test/perf/chronicle-scale.bench.ts`. Vitest `bench()` blocks pinned to a deterministic N=100 samples per method against a real Postgres instance with a synthetic **all-states** populate (`PERF_N` jobs, default 1,000 — see §1). Produces `perf-output.json`.
2. **The chronicle** — the orphan `metrics` branch holds `perf-metrics.jsonl`, one record per `develop` push, appended by CI. Every PR is diffed against the latest record and the result is posted to `$GITHUB_STEP_SUMMARY` with a non-required `perf-regression` status check.

Design rationale: see `docs/superpowers/archive/2026-05-23-performance-budget-design.md` (the original methodology) and the issue [#23 thread](https://github.com/elfensky/pg-bossier/issues/23) (CI-anchored history).

---

## 1. How to run the bench

```sh
npm run test:perf
```

This invokes `vitest bench --config vitest.perf.config.ts --run`. It:

- Spins up a `postgres:18-alpine` testcontainer via `test/perf/global-setup.ts` (Docker required locally).
- Installs pg-bossier and populates `PERF_N` jobs (default 1,000) via **one bulk `INSERT … SELECT`** covering **all states** — completed, failed, retried (real multi-attempt chains), active/in-progress, cancelled, created — across 8 queues. Deterministic distribution (keyed off the row index, not RNG) so runs stay comparable; randomized chaos lives in `test/battle/`, not the bench (#21).
- Warms the read query plans once (the bench pins `warmupIterations: 0`).
- Runs each of the ten read-method variants 100 times via tinybench. `getRetryHistory(known)` is benched on a *retried* job; `listLongRunning` sees real active jobs; `latestPerQueue`/`countByQueue` see multi-queue cardinality.
- Writes `perf-output.json` to the repo root; prints a sorted table to stdout.

### Scale (#21)

`PERF_N` scales the populate via the bulk insert, so the same bench runs at 10k / 100k / 1M without a separate file:

```sh
PERF_N=100000 npm run test:perf
```

Large-N runs are **opt-in**, not on every push: the every-push history (`perf-history.yml`) and PR diff (`perf-pr.yml`) run the default `PERF_N=1000` for fast, comparable trend data; on-demand large-N runs go through `.github/workflows/perf-scale.yml` (`workflow_dispatch` with an `n` input → uploads the result as an artifact).

The default run takes ~1 minute on a typical laptop (the bulk insert is far faster than the old per-job `send → fetch → complete` populate). Reliably reproducible if no other CPU-heavy work is running concurrently.

---

## 2. How to read `perf-output.json`

The file follows vitest's benchmark JSON shape:

```js
{
  "files": [{
    "filepath": "test/perf/chronicle-scale.bench.ts",
    "groups": [{
      "fullName": "Perf — chronicle read methods (all-states populate)",
      "benchmarks": [{
        "name": "findById(known)",
        "rank": 1,
        "sampleCount": 100,
        "mean": 0.7577,     // milliseconds
        "median": 0.6532,
        "p99": 1.8274,
        "p995": 2.9147,
        "p999": 2.9147,
        "hz": 1319.6,        // operations/second
        "min": 0.3223,
        "max": 2.9147,
        "sd": 0.4311,        // standard deviation
        "rme": 11.29,        // relative margin of error (%)
        "samples": []         // empty unless benchmark.includeSamples=true
      }, /* … nine more methods … */]
    }]
  }]
}
```

Quick inspection:

```sh
cat perf-output.json | jq '.files[].groups[].benchmarks[] | {name, mean, median, p99}'
```

The three numbers that matter for regression detection are **mean**, **median**, and **p99**. Everything else is informational. `rme` (relative margin of error) is useful for judging how stable a single run was — anything above ~20% means the run was noisy and shouldn't be trusted in isolation.

---

## 3. The ten benched methods

Each row in `perf-output.json` corresponds to one bench, identified by its `name` (the variant label). The bench file also implies a stable **canonical `method_id`** (defined in `scripts/perf-methods.mjs`), which is what's persisted in `perf-metrics.jsonl` — so a future rename of a variant label does not break trend continuity.

| `name` (variant label)          | `method_id` (canonical key) | What it measures                                              |
| ------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `findById(known)`               | `findById:known`            | Single-row lookup, primary index hit                          |
| `findById(unknown)`             | `findById:unknown`          | Single-row lookup, no hit (negative case)                     |
| `getRetryHistory(known)`        | `getRetryHistory:known`     | All attempts for one job (benched on a real multi-attempt retry chain) |
| `listJobs({})`                  | `listJobs:default`          | Latest-attempt view, no filter, paginated                     |
| `listJobs({state:'completed'})` | `listJobs:state-completed`  | Latest-attempt view, single-state filter                      |
| `listJobs({queue:'perf-q-0'})`  | `listJobs:queue`            | Latest-attempt view, queue filter                             |
| `latestPerQueue(['perf-q-0'])`  | `latestPerQueue:single`     | Most recently created job per queue                           |
| `countByState({})`              | `countByState:default`      | GROUP BY state, no filter                                     |
| `countByQueue({})`              | `countByQueue:default`      | GROUP BY queue, no filter                                     |
| `listLongRunning({900})`        | `listLongRunning:900s`      | Active jobs older than threshold (the populate leaves real active jobs, so this returns a non-empty result) |

If a bench is added or removed, `scripts/perf-methods.mjs` must be updated in the same commit — both `perf-write.mjs` and `perf-compare.mjs` import from it.

---

## 4. Where the data lives — the `metrics` branch

The CI-anchored history is on the orphan **`metrics`** branch (one-time init: `docs/metrics-init.md`). It contains exactly one file: `perf-metrics.jsonl`, append-only. Every push to `develop` adds one line.

Each record is a JSON object with this schema (`schema_version: "1.0"`):

```js
{
  "schema_version": "1.0",
  "recorded_at": "2026-05-23T15:46:15.424Z",
  "commit_sha": "8a3cc22f…",
  "branch": "develop",
  "event": "push",
  "pr_number": "",
  "runner": {
    "os": "linux",
    "arch": "x64",
    "cpu_model": "AMD EPYC 7763 64-Core Processor",
    "image_os": "Ubuntu",
    "image_version": "20250101.1.0",
    "runner_os": "Linux"
  },
  "node_version": "v24.x.y",
  "vitest_version": "^4.1.7",
  "package_lock_hash": "sha256:...",
  "methods": [
    {
      "method_id": "findById:known",
      "variant_label": "findById(known)",
      "samples_count": 100,
      "mean_ms": 0.7577,
      "median_ms": 0.6532,
      "p99_ms": 1.8274
    },
    /* … nine more methods … */
  ]
}
```

The **runner fingerprint** (the `runner` object plus `node_version`, `vitest_version`, `package_lock_hash`) is load-bearing — when a PR diff is computed, a fingerprint mismatch flags the baseline as potentially unreliable for that PR. Runner image drift on `ubuntu-latest` is a real source of false-positive regressions; without the fingerprint we couldn't distinguish it from a code regression.

To browse the history locally:

```sh
git fetch origin metrics
git show origin/metrics:perf-metrics.jsonl | jq -s 'sort_by(.recorded_at)' | jq '.[-1]'  # latest record
git show origin/metrics:perf-metrics.jsonl | jq -c '{commit_sha: .commit_sha[0:7], p99: (.methods | map({(.method_id): .p99_ms}) | add)}'  # one-line summary per record
```

### Whole-series report (`npm run perf:report`)

`perf-compare.mjs` diffs a PR against **one** baseline — two points. To read the **whole** series at once (per-method first/last/min/max/median-of-medians + p99 ceiling, plus a step-change detector), run:

```sh
git fetch origin metrics            # once, so the script can read the branch
npm run perf:report                 # auto-reads origin/metrics:perf-metrics.jsonl
node scripts/perf-report.mjs path/to/perf-metrics.jsonl   # or point it at a file
```

The step-change detector flags any method whose median jumps ≥1.5× between consecutive records, and clusters those by commit: a step **shared across ≥3 methods** at one commit is a runner/workload/schema shift (e.g. the #21 all-states populate rebuild, or `ubuntu-latest` reassigning the runner CPU — the series spans several CPU models), **not** a per-method code regression. This is the signal a two-point PR diff structurally can't see. Stdlib-only, like the sibling scripts; `--selftest` runs a built-in self-check.

---

## 5. Regression thresholds — what trips a status check

When a PR's bench output is compared against the latest develop baseline, each method gets a status:

| Status | Trip condition (PR vs baseline)                       | Effect                                              |
| ------ | ----------------------------------------------------- | --------------------------------------------------- |
| 🟢 OK         | mean ≤ +50%   AND p99 ≤ +100%                          | No signal. Quiet pass.                              |
| 🟡 elevated   | mean > +50%   OR  p99 > +100%   (and not 🔴)            | Yellow row in PR summary. **No status check fail.** |
| 🔴 regression | mean > +100%  OR  p99 > +400%                          | Red row. **`perf-regression` check fails (red X).** |

The thresholds are **deliberately loose** for v1. The mean is allowed to double and p99 is allowed to 5× before we flag a regression. Why so loose?

- **Shared-runner noise floor is high.** `ubuntu-latest` runs on a multi-tenant VM. Transient host load can easily 2-5× p99 on a single run with no code change.
- **N=100 samples is small for tail metrics.** A single outlier shifts p99 measurably. The methodology accepts this — tightening to N=1000 would cost too much CI time today.
- **We don't yet know the noise floor for this specific bench.** Need ~20 develop runs on the `metrics` branch before we can statistically derive a tighter threshold.

The plan is to tighten thresholds (and possibly make the check required in branch protection) only after enough develop runs accumulate to characterize the noise floor empirically. Tracked in [#21](https://github.com/elfensky/pg-bossier/issues/21).

### `perf-regression` is intentionally **not** a required status check

A 🔴 result fails the workflow, which makes the `perf-regression` check show a red X on the PR. **This check is not — and should not be — marked Required in branch protection.** Merge is not blocked.

The reasoning: noisy gates train developers to ignore them. A red X without a merge block is visible enough to prompt investigation but cheap enough to merge through when the cause is obvious noise. This is the right enforcement model for the first ~6 months of data collection; the policy will be revisited via #21.

---

## 6. Baseline staleness — when to disbelieve a 🔴

The PR comparer also checks two staleness conditions and flags the summary if either is true:

| Condition                                    | Why it matters                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| Baseline older than **14 days**              | GitHub may have swapped runner images in the meantime; comparison may be apples-to-oranges. |
| Fingerprint mismatch                         | Node version, vitest version, package-lock hash, image OS, or image version differs between PR and baseline. Same risk as age — environment drift, not code drift. |

When either trips, the PR summary leads with a banner: *"⚠ Baseline may be unreliable for this comparison."* In that case, treat a 🔴 as suspect until a fresh develop merge produces a new baseline. The diff is still rendered for context; it's just not actionable as a regression signal.

---

## 7. Known baseline (laptop, 2026-05-23 — soft-invalidated)

> _Note: these frozen labels use the pre-#21 `perf-queue` name; the current bench renamed that queue to `perf-q-0` (see §3)._

The numbers below were captured on a developer laptop (macOS + Docker Desktop) **before** the bench was restructured to use vitest's `bench()` blocks. They are kept here as historical reference but **are no longer the operational baseline** — tinybench uses different warmup/timing primitives than the original hand-rolled sampler, so the absolute numbers shift.

The **new baseline of record** is whatever CI publishes to `origin/metrics`. Until ~20 develop runs accumulate, the laptop numbers below remain a reasonable order-of-magnitude reality check.

| Method                          | mean (ms) | median (ms) | p99 (ms) |
| ------------------------------- | --------- | ----------- | -------- |
| findById(known)                 | 0.48      | 0.38        | 2.06     |
| findById(unknown)               | 0.60      | 0.51        | 1.38     |
| getRetryHistory(known)          | 0.56      | 0.51        | 1.21     |
| listJobs({})                    | 2.73      | 2.35        | 7.99     |
| listJobs({state:'completed'})   | 1.91      | 1.78        | 2.89     |
| listJobs({queue:'perf-queue'})  | 1.60      | 1.55        | 2.51     |
| latestPerQueue(['perf-queue'])  | 2.00      | 1.84        | 3.46     |
| countByState({})                | 0.87      | 0.78        | 1.81     |
| countByQueue({})                | 0.71      | 0.62        | 1.79     |
| listLongRunning({900})          | 0.27      | 0.25        | 0.50     |

### Published budgets (laptop-derived; still operational until CI re-derivation)

Per-method budget = first-measurement p99 × 2.0, rounded to one significant digit. Used as a sanity-check ceiling; **not** wired into CI as a hard gate.

| Method                          | First-measurement p99 | Published budget |
| ------------------------------- | --------------------- | ---------------- |
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

---

## 8. What this does NOT measure

Now measured (#21, was previously out of scope): **scale** beyond 1k (`PERF_N` to 1M), **retry/failure lifecycles** (`getRetryHistory` on real multi-attempt chains), **multi-queue cardinality** (8 queues), and **active-jobs scenarios** (`listLongRunning` returns non-empty) — all via the all-states populate (§1).

Still out of scope:

- Per-state-change trigger overhead — the populate-time-delta methodology was attempted and found unreliable (JIT and OS-cache noise dominate the trigger's contribution). The right path is direct DB-side timing (`pg_stat_statements`, per-call `EXPLAIN ANALYZE`).
- Concurrent workers — the bench is single-process and sequential.
- The v0.3.x+ operational methods — `captureHealth`, `getLiveHeartbeats`, `sendTracked`, and the `{ live: true }` variants of `countByState` / `countByQueue`. The bench covers only the ten read methods listed in § 3; the live `pgboss.job` reads and the capture-health coverage sample are unbenched.

---

## 9. Methodology details

- **Synthetic all-states populate (#21).** The chronicle is built by one bulk `INSERT … SELECT` over `generate_series`, not by driving pg-boss's lifecycle — that's what makes `PERF_N` scale to 1M (per-job `send → fetch → complete` would not). The bench measures *reads*, which don't care how the rows arrived. Job shapes (queue, outcome, attempt count) are a deterministic function of the row index, so the populate is identical across runs (comparable) while still covering every state + retry chains + active jobs.
- **Warmup runs the read plans once** after populate (the bench pins `warmupIterations: 0`), so the first sample of each method doesn't pay a one-off plan-compile tax that distorts p99.
- **The known-id for `findById(known)` / `getRetryHistory(known)` is a job with a retry chain** (`count(*) > 1`), so those are benched on a real multi-attempt job, not a 1-attempt best case.
- **The unknown-id case uses `randomUUID()` per sample.** Forces an actual index miss every time rather than a cached negative result.
- **All ten benches share the same testcontainer and populate.** No re-population between methods, so observed variance reflects query-side noise, not setup variance.
- **Vitest `bench()` is experimental** and its output format is documented as *not* following SemVer. Both `perf-write.mjs` and `perf-compare.mjs` defensively check that `mean`, `median`, and `p99` are numeric — if a future vitest minor changes the field shape, the writer/comparer fail loudly (exit 2) rather than silently emitting `NaN`.

---

## 10. Operational reference

| Concern                                    | Where to look                                                  |
| ------------------------------------------ | -------------------------------------------------------------- |
| The bench code itself                      | `test/perf/chronicle-scale.bench.ts`                           |
| Vitest config for the bench                | `vitest.perf.config.ts`                                        |
| Container + populate setup                 | `test/perf/global-setup.ts`                                    |
| Canonical method IDs (single source of truth) | `scripts/perf-methods.mjs`                                  |
| CI writer                                  | `scripts/perf-write.mjs`                                       |
| PR comparer (two-point diff)               | `scripts/perf-compare.mjs`                                     |
| Whole-series report (`npm run perf:report`) | `scripts/perf-report.mjs`                                     |
| Write workflow (develop)                   | `.github/workflows/perf-history.yml`                           |
| Read workflow (PRs)                        | `.github/workflows/perf-pr.yml`                                |
| On-demand scale run (large `PERF_N`)       | `.github/workflows/perf-scale.yml`                             |
| One-time orphan-branch init                | `docs/metrics-init.md`                                         |
| The historical chronicle                   | `git show origin/metrics:perf-metrics.jsonl`                   |

### #21 follow-up status

- **Scale extensions, realistic shapes** (items 1–4): done — `PERF_N`-scalable, all-states populate (above); on-demand large-N via `perf-scale.yml`.
- **CI integration** (item 5): done — every-push history + PR diff (#23) at the default N; large-N opt-in via `perf-scale.yml`.
- **Violation policy** (item 8): done by #23 — a non-required `perf-regression` status check flags a regression without blocking merge (§5).
- **Hard budget assertions** (item 6): **superseded** — the system gates on *regression vs a fingerprinted baseline*, which is more robust across runners than static PERFORMANCE.md numbers (those stay an informational reference, §7).
- **Per-feature budget split** (item 7): **declined** — speculative; the per-method regression gate already localizes which method regressed.

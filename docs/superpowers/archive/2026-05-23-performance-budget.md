# Performance Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first real per-method performance measurements for pg-bossier — a new vitest perf file, a methodology doc with first-measurement numbers and per-method published budgets — closing issue [#12](https://github.com/elfensky/pg-bossier/issues/12) and opening a follow-up sub-issue for scale extensions, CI integration, and budget violation policy.

**Architecture:** A new vitest file at `test/perf-chronicle-scale.test.ts` uses the existing `startHarness()` pattern. It runs two cold testcontainers in sequence — one without pg-bossier installed (baseline), one with — to derive the capture-trigger's per-state-transition overhead. Then it samples each of the seven Goal 5 read methods 100 times against the populated chronicle and prints a markdown table. A new `npm run test:perf` script invokes only this file. The output table is pasted into a new `PERFORMANCE.md` at the repo root; published budgets = first-measurement p99 × 2.0 (rounded). No `src/` changes.

**Tech Stack:** vitest, `@testcontainers/postgresql` (already in `test/harness.ts`), pg-boss public API (`createQueue` / `send` / `fetch` / `complete`), `performance.now()` for sampling, `node:crypto.randomUUID()` for the "unknown id" lookup variant.

---

## Spec reference

Design spec: `docs/superpowers/specs/2026-05-23-performance-budget-design.md`

## File map

| File | Action | Why |
|---|---|---|
| `test/perf-chronicle-scale.test.ts` | Create | The perf vitest file: populate + measure + markdown table output |
| `package.json` | Modify | Add `test:perf` script |
| `PERFORMANCE.md` | Create | Methodology doc + first-measurement numbers + published budgets |
| `CHANGELOG.md` | Modify | Unreleased / Added entry |
| `CLAUDE.md` | **Modify on develop after merge, NOT in this branch** | Mirrors the Goal 8 pattern (commit `2c2c14d` on develop) |
| New GitHub issue | Create | Follow-up sub-issue: scale extensions, CI integration, violation policy |
| Issue #12 body | Modify | Strike stale claims, add resolved section linking to spec and follow-up |
| Issue #12 status | Close | After PR merge |

---

## Task 1: Create worktree and verify baseline

**Files:**
- Create: `.worktrees/performance-budget/` (worktree, gitignored)

- [ ] **Step 1: Create worktree off develop**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git worktree add .worktrees/performance-budget -b feature/performance-budget develop
cd .worktrees/performance-budget
```

Expected: new branch created off develop's tip.

- [ ] **Step 2: Install deps and verify baseline**

```bash
npm ci
npm run lint && npm run build && npm test
```

Expected: clean install, lint clean, build clean, 55 tests pass.

---

## Task 2: Open follow-up sub-issue on GitHub

**Files:** none (needed before PERFORMANCE.md so the prose can cite the issue number).

- [ ] **Step 1: Draft issue body**

```bash
cat > /tmp/perf-followup-issue.md <<'EOF'
## Why this issue exists

The first-measurement performance bench resolved issue #12 by setting:

- A real numeric budget per method (from first-run p99 × 2.0).
- A vitest harness at `test/perf-chronicle-scale.test.ts` runnable via `npm run test:perf`.
- A methodology doc at `PERFORMANCE.md`.

What the first measurement deliberately does NOT cover — and what this follow-up carries:

## Carried work

1. **Scale extensions.** 10k / 100k / 1M-job perf tests (likely separate `test/perf-chronicle-NNk.test.ts` files). Naming and split decisions live here.
2. **Failure-injection variants.** Populate with mid-lifecycle failures so `getRetryHistory` is measured against jobs with real retry chains.
3. **Multi-queue cardinality.** Multi-queue populates exercise `latestPerQueue` and `countByQueue` at production-shape cardinality.
4. **Active-jobs scenarios.** Populate that leaves jobs in `active` so `listLongRunning` returns non-empty.
5. **CI integration.** A separate GitHub Actions workflow (manually-triggered or release-tagged) that runs `npm run test:perf` on a stable runner and uploads the result table as an artifact.
6. **Hard budget assertions.** Once CI runs on a stable runner, tighten the vitest assertions to gate on published-budget numbers instead of sanity-only bounds.
7. **Per-feature budget allocation.** Open question whether each goal gets a slice of the total budget. Address if it earns its keep.
8. **Violation policy.** What happens when CI sees a >2× regression. Block PR merge? Comment with the regression? TBD.

## Trigger to schedule

Land items 1–4 when a real consumer (descent-app) hits scale that the 1k bench can't represent. Land item 5 (CI integration) sooner if perf regressions start slipping into PRs unnoticed. Items 6–8 land together with 5.

## Related

- Parent goal: pg-bossier issue [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter), Goal 8.
- Predecessor: issue [#12](https://github.com/elfensky/pg-bossier/issues/12) — first measurement; closed when this issue opens.
- Goal 8 compat-doc tightening: issue #9 (closed), PR #20.
- Design spec: `docs/superpowers/specs/2026-05-23-performance-budget-design.md` (on develop after the first-measurement PR merges).
EOF
cat /tmp/perf-followup-issue.md
```

Eyeball the markdown.

- [ ] **Step 2: Open the issue**

```bash
gh issue create \
  --title "Performance follow-up: scale extensions, CI integration, budget violation policy" \
  --body-file /tmp/perf-followup-issue.md
```

Expected: `gh` prints the URL of the new issue. **Capture the issue number** — it goes into PERFORMANCE.md, CHANGELOG, and #12's closing comment.

- [ ] **Step 3: Record the issue number**

```bash
echo "FOLLOW_UP issue number: <NUMBER>"  # replace with the actual number
```

For the rest of this plan, `<FOLLOW_UP>` is the number captured here.

---

## Task 3: Add `test:perf` script to `package.json`

**Files:**
- Modify: `package.json` (scripts section)

- [ ] **Step 1: Read the current scripts**

```bash
grep -A 10 '"scripts"' package.json
```

- [ ] **Step 2: Add `test:perf`**

Use the Edit tool. Find the existing `"test": "vitest run"` line and append `"test:perf": "vitest run test/perf-chronicle-scale.test.ts"` immediately after it. Example before:

```json
    "test": "vitest run",
```

After (preserving trailing comma logic — likely the existing test line keeps its comma if other scripts follow it):

```json
    "test": "vitest run",
    "test:perf": "vitest run test/perf-chronicle-scale.test.ts",
```

- [ ] **Step 3: Verify**

```bash
node -e "console.log(require('./package.json').scripts['test:perf'])"
```

Expected: `vitest run test/perf-chronicle-scale.test.ts`.

---

## Task 4: Create the perf test file

**Files:**
- Create: `test/perf-chronicle-scale.test.ts`

This is the meat of the branch. ~200 lines. Done as one file creation, not split, because the file's parts are tightly coupled and would be confusing to assemble in pieces.

- [ ] **Step 1: Create the file**

Use the Write tool with this exact content:

```typescript
import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

/**
 * Perf bench — chronicle scale (1k jobs).
 *
 * Two cold testcontainers in sequence:
 *   Phase 1 — baseline populate, no pg-bossier installed.
 *   Phase 2 — populate with pg-bossier installed. Container stays alive.
 *
 * Phase 3 (query measurement) runs against phase 2's container.
 *
 * The per-state-transition overhead = (T_phase2 - T_phase1) / 3000.
 * 3000 reflects 3 trigger fires per happy-path job (created → active → completed).
 *
 * Run via: npm run test:perf
 * Spec: docs/superpowers/specs/2026-05-23-performance-budget-design.md
 */

const QUEUE = 'perf-queue';
const N_JOBS = 1000;
const SAMPLES_PER_METHOD = 100;
const PERF_TIMEOUT_MS = 5 * 60_000; // 5-minute ceiling for the whole bench

interface Measurement {
  name: string;
  samples: number[];
  mean: number;
  median: number;
  p99: number;
}

class BenchHarness {
  private measurements: Measurement[] = [];
  triggerOverheadMsPerStateChange = 0;
  tBaselineLifecycleMs = 0;
  tWithTriggerLifecycleMs = 0;

  recordTriggerOverhead(args: { tBaseline: number; tWithTrigger: number; stateTransitions: number }) {
    this.tBaselineLifecycleMs = args.tBaseline;
    this.tWithTriggerLifecycleMs = args.tWithTrigger;
    const delta = args.tWithTrigger - args.tBaseline;
    this.triggerOverheadMsPerStateChange = delta / args.stateTransitions;
  }

  async sampleMethod(name: string, n: number, fn: () => Promise<unknown>): Promise<void> {
    const samples: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const measurement: Measurement = {
      name,
      samples,
      mean: sum / samples.length,
      median: sorted[Math.floor(sorted.length * 0.5)]!,
      p99: sorted[Math.floor(sorted.length * 0.99)]!,
    };
    this.measurements.push(measurement);
  }

  allMeasurements(): readonly Measurement[] {
    return this.measurements;
  }

  /**
   * Print a markdown table to stdout. The same shape goes into PERFORMANCE.md.
   * Use console.log (not console.error) so vitest's stdout-reporter captures it.
   */
  report(): void {
    const lines: string[] = [];
    lines.push('');
    lines.push('### Perf bench — chronicle scale (1k jobs, single-process)');
    lines.push('');
    lines.push(`- Populate baseline (no trigger):  ${this.tBaselineLifecycleMs.toFixed(1)} ms`);
    lines.push(`- Populate with trigger:           ${this.tWithTriggerLifecycleMs.toFixed(1)} ms`);
    lines.push(`- Per-state-transition overhead:   ${this.triggerOverheadMsPerStateChange.toFixed(3)} ms`);
    lines.push('');
    lines.push('| Method                                | mean (ms) | median (ms) | p99 (ms) |');
    lines.push('|---------------------------------------|-----------|-------------|----------|');
    for (const m of this.measurements) {
      const padded = m.name.padEnd(37);
      lines.push(`| ${padded} | ${m.mean.toFixed(2).padStart(9)} | ${m.median.toFixed(2).padStart(11)} | ${m.p99.toFixed(2).padStart(8)} |`);
    }
    lines.push('');
    console.log(lines.join('\n'));
  }
}

/**
 * Populate the queue with N jobs via the full pg-boss lifecycle:
 *   N × send → 3 trigger fires per job (created on INSERT, active on fetch UPDATE, completed on complete UPDATE).
 *
 * Returns the array of job IDs in creation order.
 */
async function populateLifecycle(boss: Harness['boss'], n: number): Promise<string[]> {
  await boss.createQueue(QUEUE);
  // Phase A — send
  const jobIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await boss.send(QUEUE, { idx: i });
    if (id) jobIds.push(id);
  }
  // Phase B — fetch + complete in batches of 100
  let remaining = jobIds.length;
  while (remaining > 0) {
    const batch = await boss.fetch(QUEUE, { batchSize: 100 });
    if (!batch || batch.length === 0) break;
    for (const job of batch) {
      await boss.complete(QUEUE, job.id);
    }
    remaining -= batch.length;
  }
  return jobIds;
}

describe('Perf — chronicle scale (1k jobs)', () => {
  let phase2: Harness | null = null;
  let knownJobId: string;
  const bench = new BenchHarness();

  beforeAll(async () => {
    // -------- Phase 1: baseline populate, no pg-bossier installed --------
    const h1 = await startHarness();
    const t0p1 = performance.now();
    await populateLifecycle(h1.boss, N_JOBS);
    const tBaseline = performance.now() - t0p1;
    await h1.teardown();

    // -------- Phase 2: populate with pg-bossier installed --------
    phase2 = await startHarness();
    await install(phase2.pool);
    const t0p2 = performance.now();
    const jobIds = await populateLifecycle(phase2.boss, N_JOBS);
    const tWithTrigger = performance.now() - t0p2;

    bench.recordTriggerOverhead({
      tBaseline,
      tWithTrigger,
      stateTransitions: N_JOBS * 3,
    });

    // Pick the median-position job id for known-id lookups.
    knownJobId = jobIds[Math.floor(jobIds.length / 2)]!;

    // -------- Phase 3: query measurements against the populated chronicle --------
    const client = bossier({ boss: phase2.boss, pool: phase2.pool });
    await bench.sampleMethod('findById(known)',                SAMPLES_PER_METHOD, () => client.findById(knownJobId));
    await bench.sampleMethod('findById(unknown)',              SAMPLES_PER_METHOD, () => client.findById(randomUUID()));
    await bench.sampleMethod('getRetryHistory(known)',         SAMPLES_PER_METHOD, () => client.getRetryHistory(knownJobId));
    await bench.sampleMethod('listJobs({})',                   SAMPLES_PER_METHOD, () => client.listJobs({}));
    await bench.sampleMethod("listJobs({state:'completed'})",  SAMPLES_PER_METHOD, () => client.listJobs({ state: 'completed' }));
    await bench.sampleMethod("listJobs({queue:'perf-queue'})", SAMPLES_PER_METHOD, () => client.listJobs({ queue: QUEUE }));
    await bench.sampleMethod("latestPerQueue(['perf-queue'])", SAMPLES_PER_METHOD, () => client.latestPerQueue([QUEUE]));
    await bench.sampleMethod('countByState({})',               SAMPLES_PER_METHOD, () => client.countByState({}));
    await bench.sampleMethod('countByQueue({})',               SAMPLES_PER_METHOD, () => client.countByQueue({}));
    await bench.sampleMethod('listLongRunning({900})',         SAMPLES_PER_METHOD, () => client.listLongRunning({ olderThanSeconds: 900 }));

    bench.report();
  }, PERF_TIMEOUT_MS);

  afterAll(async () => {
    if (phase2) await phase2.teardown();
  });

  it('captured 1 trigger-overhead measurement + 10 query measurements', () => {
    expect(bench.allMeasurements().length).toBe(10);
  });

  it('every measurement has 100 samples', () => {
    for (const m of bench.allMeasurements()) {
      expect(m.samples.length).toBe(SAMPLES_PER_METHOD);
    }
  });

  it('every query p99 is under 1 second (sanity check, not budget)', () => {
    for (const m of bench.allMeasurements()) {
      expect(m.p99, `p99 of ${m.name}`).toBeLessThan(1000);
    }
  });

  it('per-state-transition trigger overhead is under 50 ms (sanity check)', () => {
    expect(bench.triggerOverheadMsPerStateChange).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npm run build 2>&1 | tail -5
```

Expected: tsc emits no errors. The test file is part of the project's tsconfig include.

- [ ] **Step 3: Verify lint passes**

```bash
npm run lint 2>&1 | tail -5
```

Expected: eslint clean. If lint complains (e.g. `@typescript-eslint/no-non-null-assertion` on the `[...]!` patterns), fix the lint message before continuing — these are the same patterns already used in `test/client.test.ts` so they should pass.

- [ ] **Step 4: Commit**

```bash
git add test/perf-chronicle-scale.test.ts package.json
git commit -m "$(cat <<'EOF'
test: add perf bench for chronicle scale (1k jobs)

A new vitest file that populates 1,000 jobs through pg-boss's full
lifecycle in two cold testcontainers — one without pg-bossier
installed (baseline), one with — to derive the capture-trigger's
per-state-transition overhead. Then samples each of the seven Goal 5
read methods 100 times against the populated chronicle and prints a
markdown table for the published PERFORMANCE.md.

Runs via `npm run test:perf`, separate from the default fast suite.
Vitest assertions are sanity-only (p99 < 1s, trigger overhead < 50ms);
the published budgets in PERFORMANCE.md are human-readable targets,
not test failures.

First step toward closing issue #12.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Run the perf test locally; capture numbers

**Files:** none (data collection).

- [ ] **Step 1: Run the perf test**

```bash
npm run test:perf 2>&1 | tee /tmp/perf-run-1.log
```

Expected: completes within ~5 minutes; the markdown table prints to stdout (visible in the log). All 4 vitest assertions pass.

If the test fails on the timeout, increase `PERF_TIMEOUT_MS` and re-run. If it fails on a vitest assertion (e.g. p99 > 1s), that's a real problem with the harness or substrate — investigate before continuing.

- [ ] **Step 2: Extract the markdown table from the log**

```bash
# Find the section between "### Perf bench" and the next blank-line-after-table:
sed -n '/### Perf bench/,/^$/p' /tmp/perf-run-1.log > /tmp/perf-table-1.md
cat /tmp/perf-table-1.md
```

Expected: the printed table is in `/tmp/perf-table-1.md`. Eyeball — verify the trigger overhead is positive, p99 numbers look sane (likely 1–20ms range for most methods at 1k scale).

- [ ] **Step 3: (Optional) Re-run for stability check**

```bash
npm run test:perf 2>&1 | tee /tmp/perf-run-2.log
sed -n '/### Perf bench/,/^$/p' /tmp/perf-run-2.log > /tmp/perf-table-2.md
diff /tmp/perf-table-1.md /tmp/perf-table-2.md || echo "Numbers differ between runs (expected — noise)"
```

This is informational only — single-run variance is real. Use the higher of the two p99s per method when computing budgets (more conservative).

- [ ] **Step 4: Record the numbers for Task 6**

Keep `/tmp/perf-table-1.md` (or `/tmp/perf-table-2.md`, whichever has higher numbers) available for Task 6 — that's where the budgets get derived.

---

## Task 6: Create `PERFORMANCE.md`

**Files:**
- Create: `PERFORMANCE.md` (repo root)

- [ ] **Step 1: Compute published budgets from first-measurement p99**

For each method's p99 from `/tmp/perf-table-1.md` (or whichever table you settled on), the published budget = `ceil(p99 × 2.0 to one significant figure)`. Examples:
- p99 = 1.47 ms → budget = 3 ms
- p99 = 4.12 ms → budget = 9 ms
- p99 = 0.31 ms → budget = 0.7 ms (or round to 1 ms)
- p99 = 12.5 ms → budget = 30 ms

Same rule for trigger overhead.

Write the computed budgets in a parallel table.

- [ ] **Step 2: Create the file**

Use the Write tool with this content, substituting `<FIRST_MEASUREMENT_TABLE>` with the table from Task 5, `<BUDGET_TABLE>` with the computed budgets table, `<MEASURED_AT_HARDWARE>` with the hardware caveat (e.g. "MacBook Pro M-series, Docker Desktop"), `<FOLLOW_UP>` with the follow-up issue number from Task 2, and `<DATE>` with `2026-05-23`:

```markdown
# Performance

This file is the published record of pg-bossier's per-method performance numbers and the budgets a future regression should defend against. See the spec at `docs/superpowers/specs/2026-05-23-performance-budget-design.md` for the full rationale.

## What this measures

A vitest perf file at `test/perf-chronicle-scale.test.ts` populates 1,000 jobs through pg-boss's full public-API lifecycle (`createQueue` → `send` → `fetch` → `complete`) in two cold testcontainers — one without pg-bossier installed (baseline), one with. The difference between the two populate wall-clock times, divided by 3,000 state transitions (1,000 jobs × 3 transitions: created → active → completed), is the **per-state-transition overhead** the `pgbossier_capture` trigger introduces.

The same file then samples each of the seven Goal 5 read methods 100 times against the populated chronicle, recording mean, median, and p99 latency.

Run with: `npm run test:perf` (NOT part of the default `npm test`).

## What this does NOT measure

- Scale beyond 1,000 jobs. Larger populations (10k / 100k / 1M) and multi-queue cardinality are tracked in follow-up #<FOLLOW_UP>.
- Retry-path lifecycles. All jobs in the populate complete on first attempt; `getRetryHistory` is measured against jobs with a single attempt.
- Active-jobs scenarios. After populate all jobs are `completed`; `listLongRunning` is measured but returns an empty result.
- Concurrent workers. Single-process sequential populate and sampling.
- Stable-hardware CI. The perf test runs on contributor hardware locally; CI integration on a stable runner is tracked in #<FOLLOW_UP>.

## First measurement (<DATE>, <MEASURED_AT_HARDWARE>)

<FIRST_MEASUREMENT_TABLE>

## Published budgets

Published budget per method = first-measurement p99 × 2.0, rounded to one significant figure. Generous headroom because run-to-run variance is not yet characterized. When the harness extends to 10k+ in follow-up #<FOLLOW_UP> and variance is observed, headroom tightens (likely to ~1.3×).

<BUDGET_TABLE>

## How to run

```bash
npm run test:perf
```

The test runs in a fresh testcontainer and takes a few minutes. The markdown table prints to stdout at the end.

## How to interpret

When a fresh run on similar hardware produces numbers above the published budget by >50%, treat as a likely real regression and investigate before merging. Run-to-run variance of ~10–20% is normal. Hardware variation (contributor laptop vs CI runner vs production) means absolute numbers are not directly comparable across machines — the budget is calibrated to the machine that produced the first measurement above.

## Future scenarios (follow-up #<FOLLOW_UP>)

- 10k / 100k / 1M-job scale extensions (likely separate `test/perf-chronicle-NNk.test.ts` files).
- Failure-injection variants so `getRetryHistory` exercises real retry chains.
- Multi-queue cardinality populates.
- Active-jobs scenarios for `listLongRunning`.
- CI integration on a stable runner, with workflow artifacts capturing the result table.
- Hard budget assertions in CI (tighten the v1 sanity-only assertions).
- Per-feature budget allocation (only if it earns its keep).
- Violation policy (what happens when CI sees a >2× regression).
```

- [ ] **Step 3: Verify the file**

```bash
wc -l PERFORMANCE.md
grep -n '<FOLLOW_UP>\|<FIRST_MEASUREMENT_TABLE>\|<BUDGET_TABLE>\|<MEASURED_AT_HARDWARE>\|<DATE>' PERFORMANCE.md
```

Expected: file is ~50–80 lines depending on the tables. The `grep` for placeholders returns **no matches** — every `<...>` placeholder was fully substituted.

- [ ] **Step 4: Commit**

```bash
git add PERFORMANCE.md
git commit -m "$(cat <<'EOF'
docs: add PERFORMANCE.md with first measurement + published budgets

Captures the first run of `npm run test:perf` against a fresh
testcontainer. Per-state-transition trigger overhead and per-method
mean/median/p99 latencies recorded; published budgets per method are
first-measurement p99 × 2.0 (rounded to one significant figure).

Names the deferred follow-ups (scale extensions, retry-path, CI
integration, violation policy) and points at follow-up #<FOLLOW_UP>.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Substitute `<FOLLOW_UP>` in the commit body.

---

## Task 7: Add CHANGELOG Unreleased entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Confirm there is an `### Added` subsection under `## [Unreleased]`**

```bash
sed -n '/## \[Unreleased\]/,/^## \[/p' CHANGELOG.md | head -20
```

Expected: an `### Added` header exists (the Goal 8 branch added a `### Changed`, but `### Added` was already there).

- [ ] **Step 2: Add the entry at the top of `### Added`**

Use the Edit tool. Find the first bullet under `### Added` and insert this new bullet immediately before it:

```markdown
- First-measurement performance bench at `test/perf-chronicle-scale.test.ts`, runnable via `npm run test:perf`. Populates 1,000 jobs through pg-boss's full lifecycle in two testcontainers (with and without `pgbossier.install`), derives the capture trigger's per-state-transition overhead from the populate-time delta, then samples each of the seven Goal 5 read methods 100 times. Methodology, first-measurement numbers, and published per-method budgets recorded in `PERFORMANCE.md`. Resolves issue [#12](https://github.com/elfensky/pg-bossier/issues/12); scale extensions, CI integration, and budget violation policy continue as follow-up [#<FOLLOW_UP>](https://github.com/elfensky/pg-bossier/issues/<FOLLOW_UP>).
```

Substitute `<FOLLOW_UP>` (both occurrences).

- [ ] **Step 3: Verify no leakage and commit**

```bash
grep -c '<FOLLOW_UP>' CHANGELOG.md
# expect: 0

git add CHANGELOG.md
git commit -m "docs: changelog entry for performance budget first measurement (#12)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Final in-branch verification

**Files:** none (verification only).

- [ ] **Step 1: Run the fast suite**

```bash
npm run lint && npm run build && npm test
```

Expected: lint clean, build clean, 55 fast tests pass (same as baseline).

- [ ] **Step 2: Re-run the perf test to confirm it still works**

```bash
npm run test:perf 2>&1 | tail -25
```

Expected: completes; markdown table prints; all 4 vitest assertions pass.

- [ ] **Step 3: Eyeball the diff against develop**

```bash
git diff develop --stat
git diff develop --name-only
git log develop..HEAD --oneline
```

Expected diff scope:
- `CHANGELOG.md`
- `PERFORMANCE.md`
- `package.json`
- `test/perf-chronicle-scale.test.ts`

3 commits in branch (perf test + script, PERFORMANCE.md, CHANGELOG).

- [ ] **Step 4: Confirm no src/ leakage**

```bash
git diff develop --name-only | grep -E '^src/' || echo "  (no src/ changes — clean)"
```

Expected: no src/ changes.

---

## Task 9: Push branch and open PR

**Files:** none (git/GitHub operations).

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin feature/performance-budget
```

- [ ] **Step 2: Draft PR body**

```bash
cat > /tmp/perf-pr-body.md <<'EOF'
Closes #12 by delivering pg-bossier's first published per-method performance numbers and the methodology around them.

## What this PR ships

- **`test/perf-chronicle-scale.test.ts`** — a new vitest file that populates 1,000 jobs through pg-boss's full lifecycle in two cold testcontainers (one without pg-bossier installed, one with), derives the capture trigger's per-state-transition overhead from the populate-time delta, then samples each of the seven Goal 5 read methods 100 times. Prints a markdown table to stdout.
- **`npm run test:perf`** script invokes only the new file (separate from the default `npm test`).
- **`PERFORMANCE.md`** at the repo root: methodology, first-measurement numbers, published per-method budgets (first-measurement p99 × 2.0, rounded), how to run, how to interpret, and the deferred follow-ups list.

`CLAUDE.md` sync follows in a separate post-merge commit on develop — matches the pattern in `2c2c14d`.

## What this PR deliberately does NOT do

Scale extensions (10k / 100k / 1M), retry-path coverage, multi-queue cardinality, active-jobs scenarios, CI integration, hard budget assertions, per-feature allocation, and violation policy all continue as follow-up #<FOLLOW_UP>.

## Verification

- `npm run lint && npm run build && npm test` pass (55 tests, same as baseline).
- `npm run test:perf` runs cleanly in ~3–5 minutes; markdown table printed; all 4 sanity assertions pass.

## Design context

- Spec: `docs/superpowers/specs/2026-05-23-performance-budget-design.md` (committed at `c248761` ancestor; visible in this PR's commit list).
- Pattern follows Goal 8's doc-tightening branch (PR #20, merged `5b2a3d0`).
EOF
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create \
  --base develop \
  --head feature/performance-budget \
  --title "feat: Goal 8 perf budget — first measurement + PERFORMANCE.md (closes #12)" \
  --body-file /tmp/perf-pr-body.md
```

Substitute `<FOLLOW_UP>` in `/tmp/perf-pr-body.md` before running `gh pr create`. **Capture the PR number** for Task 10.

---

## Task 10: Refresh issue #12 body

**Files:** none (external GitHub action).

- [ ] **Step 1: Draft refreshed body**

```bash
cat > /tmp/issue-12-refreshed.md <<'EOF'
## Status: Resolved by first measurement (2026-05-23)

This issue's open items have been resolved:

- **Numeric target.** Set per-method from the first run of `npm run test:perf`. See `PERFORMANCE.md` "Published budgets."
- **Measurement methodology.** Documented in `PERFORMANCE.md` "What this measures." Single-process, 1,000 jobs through pg-boss full lifecycle, two-container baseline-vs-installed comparison for trigger overhead.
- **First measurement.** Captured and recorded in `PERFORMANCE.md`.
- **Budget unit.** Absolute milliseconds per call (mean + p99 reported; budget gates on p99).
- **Budget violation policy.** Deferred to follow-up #<FOLLOW_UP>. Sanity-only vitest assertions in v1.
- **Per-feature budget allocation.** Deferred to follow-up #<FOLLOW_UP>.
- **Reporting cadence.** Manual — run `npm run test:perf` when you want a number. CI integration is in follow-up #<FOLLOW_UP>.

**Resolution PR:** #<PR_NUMBER>.

**Design spec:** [`docs/superpowers/specs/2026-05-23-performance-budget-design.md`](https://github.com/elfensky/pg-bossier/blob/develop/docs/superpowers/specs/2026-05-23-performance-budget-design.md) (on develop after PR merges).

---

## Original purpose (preserved for context)

Set the numeric per-event overhead budget that gives "stay close to pg-boss" (Goal 8) enforceable teeth. Without a number, the constraint in #1 is unenforceable.

## Parent

Sub-issue of #1 (cross-cutting — gives Goal 8's "stay close" constraint enforceable teeth; budgets every other goal's implementation).

## Decisions made (historical record)

- **Budget unit** → absolute milliseconds per call (mean + p99).
- **Numeric target** → set from first measurement, per method, in `PERFORMANCE.md`.
- **Measurement methodology** → vitest + `@testcontainers/postgresql`, single-process, 1,000 jobs through pg-boss full lifecycle, two-container comparison.
- **First measurement** → done; recorded in `PERFORMANCE.md`.
- **Budget violation policy** → deferred (#<FOLLOW_UP>). v1 has sanity-only vitest assertions; tight gating waits for stable-runner CI.
- **Per-feature budget allocation** → deferred (#<FOLLOW_UP>).
- **Reporting cadence** → manual via `npm run test:perf`; CI integration in #<FOLLOW_UP>.
EOF
```

Substitute `<FOLLOW_UP>` and `<PR_NUMBER>`.

- [ ] **Step 2: Update issue #12**

```bash
gh issue edit 12 --body-file /tmp/issue-12-refreshed.md
gh issue view 12 --json title,state,url --jq '"  state=\(.state)  URL=\(.url)"'
```

Expected: issue updated, state still OPEN (closes after PR merge).

---

## Task 11: Merge PR (CHECKPOINT — requires user approval)

**Files:** none (merge operation).

- [ ] **Step 1: Confirm CI passes**

```bash
gh pr checks <PR_NUMBER>
gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus,state --jq '.'
```

Expected: all checks green (`verify` job passes; the `pg-boss-version-tripwire` job passes silently). `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`.

- [ ] **Step 2: ASK USER FOR EXPLICIT APPROVAL**

Per CLAUDE.md ("Commit or push only when the user asks") and per the parallel-track conservative pattern. Do not auto-merge.

- [ ] **Step 3: Merge with --no-ff**

```bash
gh pr merge <PR_NUMBER> --merge
```

Per CLAUDE.md: feature → develop merges are --no-ff, never squashed.

---

## Task 12: Close issue #12 with summary comment

**Files:** none (external GitHub action; done after merge).

GitHub may auto-close #12 because the PR body has `Closes #12`. The explicit close below is then a no-op (with a warning), but post the summary comment regardless.

- [ ] **Step 1: Draft closing comment**

```bash
cat > /tmp/issue-12-closing.md <<'EOF'
Closed by PR #<PR_NUMBER> (merged via `<MERGE_SHA>`).

**What landed:**

1. **`test/perf-chronicle-scale.test.ts`** — vitest perf bench that populates 1,000 jobs through pg-boss's full lifecycle in two cold testcontainers (with and without pg-bossier installed), derives per-state-transition trigger overhead, then samples each of the seven Goal 5 read methods 100 times.
2. **`npm run test:perf`** — invokes the perf bench, separate from the default fast `npm test`.
3. **`PERFORMANCE.md`** — methodology, first-measurement numbers, per-method published budgets (first-run p99 × 2.0, rounded), how to run, how to interpret.

**Where to find things:**

- Bench: [`test/perf-chronicle-scale.test.ts`](https://github.com/elfensky/pg-bossier/blob/develop/test/perf-chronicle-scale.test.ts).
- Numbers and budgets: [`PERFORMANCE.md`](https://github.com/elfensky/pg-bossier/blob/develop/PERFORMANCE.md).
- Design spec: [`docs/superpowers/specs/2026-05-23-performance-budget-design.md`](https://github.com/elfensky/pg-bossier/blob/develop/docs/superpowers/specs/2026-05-23-performance-budget-design.md).
- Implementation plan: [`docs/superpowers/plans/2026-05-23-performance-budget.md`](https://github.com/elfensky/pg-bossier/blob/develop/docs/superpowers/plans/2026-05-23-performance-budget.md).

**Deferred — follow-up #<FOLLOW_UP>:** scale extensions (10k / 100k / 1M), retry-path variants, multi-queue cardinality, active-jobs scenarios, CI integration on a stable runner, hard budget assertions, per-feature budget allocation, violation policy.
EOF
```

Substitute `<PR_NUMBER>`, `<MERGE_SHA>` (the develop merge commit's short SHA after fast-forward), and `<FOLLOW_UP>`.

- [ ] **Step 2: Post comment and close**

```bash
gh issue comment 12 --body-file /tmp/issue-12-closing.md
gh issue close 12 --reason completed 2>&1 || echo "(probably already auto-closed by PR merge — expected)"
gh issue view 12 --json state,closedAt --jq '"state=\(.state)  closedAt=\(.closedAt)"'
```

Expected: comment posted; close is a no-op if GitHub already auto-closed it; final state is CLOSED.

---

## Task 13: Sync `CLAUDE.md` on develop (post-merge)

**Files:**
- Modify: `CLAUDE.md` on develop directly (not the worktree, which is on the merged feature branch).

This is a docs commit directly on develop, matching the pattern from `2c2c14d` (Goal 8 sync) and `800c014` (Goal 6 sync).

- [ ] **Step 1: Switch to main checkout, fast-forward develop**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git checkout develop
git pull --ff-only origin develop
git log -3 --oneline
```

Expected: latest commit is the merge of `feature/performance-budget`.

- [ ] **Step 2: Update the Project-status paragraph**

Use the Edit tool. Find the existing sentence about Goal 8's compat-doc tightening (added in commit `2c2c14d`). Add immediately after it:

```
**Goal 8 / performance budget** — `npm run test:perf` runs a vitest perf bench at `test/perf-chronicle-scale.test.ts`, populating 1,000 jobs through pg-boss's full lifecycle in two cold testcontainers to derive per-state-transition trigger overhead, then sampling each of the seven Goal 5 read methods 100 times; published numbers and per-method budgets live in `PERFORMANCE.md`. Merged via PR #<PR_NUMBER>; issue #12 closed (scale extensions, CI integration, and budget violation policy continue as follow-up #<FOLLOW_UP>).
```

Substitute `<PR_NUMBER>` and `<FOLLOW_UP>`.

- [ ] **Step 3: Update the introductory line above the Implementation-progress table**

Find the existing line that names Goals 5, 6, 8 as merged. Extend it to include "and the first performance measurement (PR #<PR_NUMBER>) which closed cross-cutting issue [#12](https://github.com/elfensky/pg-bossier/issues/12) (correctness-assertions follow-up #19 already open; performance follow-up #<FOLLOW_UP> now open as well)."

- [ ] **Step 4: Update the Cross-cutting table row**

Find the row for "Performance budget — numeric per-event overhead target" in the cross-cutting issues table. Replace with:

```
| ✅ Performance budget — numeric per-event overhead target _(done — #12 closed; follow-up #<FOLLOW_UP> open for scale extensions, CI integration, violation policy)_ | Gives Goal 8's "stay close" enforceable teeth |
```

Substitute `<FOLLOW_UP>`.

- [ ] **Step 5: Commit and push**

```bash
git add CLAUDE.md
git commit -m "docs: sync CLAUDE.md — performance budget first measurement, issue #12 closed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin develop
```

---

## Task 14: Clean up worktree and feature branch

**Files:**
- Remove: `.worktrees/performance-budget/`

- [ ] **Step 1: Confirm merge and clean up**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git branch --merged develop | grep performance-budget
git worktree remove .worktrees/performance-budget
git branch -d feature/performance-budget
git worktree list
```

Expected: only the main checkout and the parallel Goal 7 worktree remain.

---

## Self-review check

- **Spec coverage:** Every deliverable from the spec's "What this branch ships" list maps to a task — perf test file → Task 4, npm script → Task 3, PERFORMANCE.md → Task 6, CHANGELOG → Task 7, #12 closure → Task 12, follow-up issue → Task 2, CLAUDE.md sync → Task 13. ✓
- **Placeholder scan:** Two intentional placeholders — `<FOLLOW_UP>` (resolved in Task 2) and `<PR_NUMBER>` (resolved in Task 9), both flagged at every downstream use site. No TBDs, no "appropriate" hand-waving. Code blocks contain complete code; PERFORMANCE.md's `<FIRST_MEASUREMENT_TABLE>` / `<BUDGET_TABLE>` / `<MEASURED_AT_HARDWARE>` / `<DATE>` placeholders are explicitly resolved during Task 5 → Task 6 (data flows from perf test stdout to doc). ✓
- **Type / text consistency:** `BenchHarness` class name consistent. `populateLifecycle` name consistent. `QUEUE = 'perf-queue'` consistent across Task 4 code and Task 6 doc. `N_JOBS = 1000` and `SAMPLES_PER_METHOD = 100` consistent. The 10-measurement count is consistent across Task 4 (`bench.sampleMethod` calls) and the spec's "10 measurements × 100 samples" claim. ✓
- **Scope check:** Single implementation plan; no decomposition needed. ✓

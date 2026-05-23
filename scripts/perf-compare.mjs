#!/usr/bin/env node
// perf-compare.mjs — Compare a PR's vitest bench output against the latest
// `develop` baseline stored on the `perf-metrics` orphan branch, write a
// Markdown diff to $GITHUB_STEP_SUMMARY, and exit nonzero on regression.
//
// Used by .github/workflows/perf-pr.yml on pull_request. Exit-nonzero is the
// signal for the non-required `perf-regression` status check — reviewers
// see a red X without the merge being blocked (issue #23 design choice).
//
// Stdlib-only — no npm deps. Run from the repo root.
//
// Usage:
//   node scripts/perf-compare.mjs <vitest-output.json> <baseline.jsonl>
//
// If <baseline.jsonl> is empty or missing, the script emits a "no baseline
// available" summary and exits 0 — the first PR run after orphan-branch
// init is expected to have no prior baseline.
//
// Exit codes:
//   0  no regression (or no baseline yet)
//   1  at least one method regressed beyond the threshold
//   2  vitest output schema unexpected

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { METHOD_IDS } from './perf-methods.mjs';

// Regression thresholds (issue #23, debate-gate-revised):
//   🟢 OK         — within bounds
//   🟡 elevated   — mean >50% OR p99 >2x (warning only)
//   🔴 regression — mean >2x OR p99 >5x (red X; non-required check)
const ELEVATED_MEAN_RATIO = 1.5;
const ELEVATED_P99_RATIO = 2.0;
const REGRESSION_MEAN_RATIO = 2.0;
const REGRESSION_P99_RATIO = 5.0;

// Baseline staleness window — if the develop baseline is older than this,
// the diff is presented but flagged as potentially-stale (runner drift
// can introduce false signals; see issue #23 fingerprint discussion).
const STALE_DAYS = 14;

function die(msg, code = 1) {
  process.stderr.write(`perf-compare: ${msg}\n`);
  process.exit(code);
}

const [, , inputArg, baselineArg] = process.argv;
if (!inputArg || !baselineArg) {
  die('usage: perf-compare.mjs <vitest-output.json> <baseline.jsonl>');
}
const inputFile = resolve(inputArg);
const baselineFile = resolve(baselineArg);

if (!existsSync(inputFile)) die(`vitest output not found: ${inputFile}`);

let report;
try {
  report = JSON.parse(readFileSync(inputFile, 'utf8'));
} catch (err) {
  die(`failed to parse vitest output: ${err.message}`);
}

if (!report || !Array.isArray(report.files)) {
  die('vitest output missing "files" array — schema change?', 2);
}

// Extract PR run's methods, keyed by method_id.
const prMethods = new Map();
for (const file of report.files) {
  if (!Array.isArray(file.groups)) continue;
  for (const group of file.groups) {
    if (!Array.isArray(group.benchmarks)) continue;
    for (const b of group.benchmarks) {
      const id = METHOD_IDS.get(b.name);
      if (!id) continue;
      // Match the schema guard in perf-write.mjs. Without it, a vitest
      // output schema change that drops mean/median/p99 would silently
      // produce NaN ratios below, and NaN comparisons fail-open
      // (`NaN >= REGRESSION_P99_RATIO` is false), masking real
      // regressions. Fail loudly instead.
      if (typeof b.mean !== 'number' || typeof b.median !== 'number' || typeof b.p99 !== 'number') {
        die(`bench "${b.name}" missing mean/median/p99 — vitest schema change?`, 2);
      }
      prMethods.set(id, {
        method_id: id,
        variant_label: b.name,
        mean_ms: b.mean,
        median_ms: b.median,
        p99_ms: b.p99,
      });
    }
  }
}

if (prMethods.size === 0) die('no recognized benchmarks in vitest output', 2);

// Read baseline JSONL. Take the last line (most recent develop record).
function readLatestBaseline(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return null;
  const lines = raw.split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    process.stderr.write(`perf-compare: failed to parse last baseline line: ${err.message}\n`);
    return null;
  }
}

const baseline = readLatestBaseline(baselineFile);

// Compute current package-lock hash so we can compare fingerprints.
let currentLockHash = '';
try {
  const lock = readFileSync(resolve('package-lock.json'), 'utf8');
  currentLockHash = 'sha256:' + createHash('sha256').update(lock).digest('hex');
} catch {
  // ignore
}

// Render Markdown report to $GITHUB_STEP_SUMMARY.
function writeSummary(md) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) {
    appendFileSync(path, md);
  } else {
    process.stdout.write(md);
  }
}

// First run after orphan-branch init: baseline.jsonl exists but is empty,
// or the file doesn't exist at all. Emit a friendly summary and exit 0.
if (!baseline) {
  writeSummary(
    [
      '## ⏱ Perf bench — no baseline yet',
      '',
      'No `develop` perf record found on the `perf-metrics` branch. After this PR is merged, the first `push: develop` workflow run will establish the baseline. Subsequent PRs will diff against it.',
      '',
      'PR results (this run):',
      '',
      '| Method | mean (ms) | median (ms) | p99 (ms) |',
      '|---|---:|---:|---:|',
      ...Array.from(prMethods.values()).map(
        (m) =>
          `| \`${m.variant_label}\` | ${m.mean_ms.toFixed(3)} | ${m.median_ms.toFixed(3)} | ${m.p99_ms.toFixed(3)} |`,
      ),
      '',
    ].join('\n'),
  );
  process.exit(0);
}

// Compute staleness and fingerprint compat.
const baselineDate = new Date(baseline.recorded_at);
const ageDays = (Date.now() - baselineDate.getTime()) / (1000 * 60 * 60 * 24);
const isStale = ageDays > STALE_DAYS;
const fingerprintMismatch =
  (baseline.runner?.image_os && baseline.runner.image_os !== (process.env.ImageOS ?? '')) ||
  (baseline.runner?.image_version &&
    baseline.runner.image_version !== (process.env.ImageVersion ?? '')) ||
  (baseline.node_version && baseline.node_version !== process.version) ||
  (baseline.package_lock_hash && currentLockHash && baseline.package_lock_hash !== currentLockHash);

// Build the diff table.
const baselineMethods = new Map((baseline.methods ?? []).map((m) => [m.method_id, m]));

const rows = [];
let worstStatus = 'ok';
for (const pr of prMethods.values()) {
  const base = baselineMethods.get(pr.method_id);
  if (!base) {
    // New method in PR (no baseline to compare against). Render in the
    // table but deliberately don't promote worstStatus — there's no
    // before/after to call this a regression. Once it lands on develop,
    // future PRs will diff against it normally.
    rows.push({
      pr,
      base: null,
      meanDeltaPct: null,
      p99DeltaPct: null,
      status: 'new',
      statusEmoji: '⚪',
    });
    continue;
  }
  const meanRatio = base.mean_ms > 0 ? pr.mean_ms / base.mean_ms : 1;
  const p99Ratio = base.p99_ms > 0 ? pr.p99_ms / base.p99_ms : 1;
  const meanDeltaPct = (meanRatio - 1) * 100;
  const p99DeltaPct = (p99Ratio - 1) * 100;

  let status = 'ok';
  let statusEmoji = '🟢';
  if (meanRatio >= REGRESSION_MEAN_RATIO || p99Ratio >= REGRESSION_P99_RATIO) {
    status = 'regression';
    statusEmoji = '🔴';
    worstStatus = 'regression';
  } else if (meanRatio >= ELEVATED_MEAN_RATIO || p99Ratio >= ELEVATED_P99_RATIO) {
    status = 'elevated';
    statusEmoji = '🟡';
    if (worstStatus === 'ok') worstStatus = 'elevated';
  }
  rows.push({ pr, base, meanDeltaPct, p99DeltaPct, status, statusEmoji });
}

const formatPct = (n) =>
  n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const formatMs = (n) => (typeof n === 'number' ? n.toFixed(3) : '—');

const lines = [];
lines.push('## ⏱ Perf bench — PR vs `develop` baseline');
lines.push('');

if (isStale || fingerprintMismatch) {
  lines.push('> ⚠ **Baseline may be unreliable for this comparison:**');
  if (isStale) {
    lines.push(
      `> - Baseline is ${ageDays.toFixed(1)} days old (>${STALE_DAYS}d). Runner image drift on \`ubuntu-latest\` may inflate apparent regressions.`,
    );
  }
  if (fingerprintMismatch) {
    lines.push('> - Runner / Node / package-lock fingerprint differs from the baseline.');
  }
  lines.push(
    '> - Treat any 🔴 below as suspect until a fresh baseline lands on `develop`. Numbers are still recorded for trend tracking.',
  );
  lines.push('');
}

lines.push(`Baseline: \`${baseline.commit_sha.slice(0, 7)}\` recorded ${baseline.recorded_at}`);
lines.push('');
lines.push('| Status | Method | base mean | PR mean | Δ mean | base p99 | PR p99 | Δ p99 |');
lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  lines.push(
    `| ${r.statusEmoji} | \`${r.pr.variant_label}\` | ` +
      `${formatMs(r.base?.mean_ms)} | ${formatMs(r.pr.mean_ms)} | ${formatPct(r.meanDeltaPct)} | ` +
      `${formatMs(r.base?.p99_ms)} | ${formatMs(r.pr.p99_ms)} | ${formatPct(r.p99DeltaPct)} |`,
  );
}
lines.push('');
lines.push(
  'Thresholds — 🟡 elevated: mean >+50% or p99 >+100% · 🔴 regression: mean >+100% or p99 >+400%. ' +
    '🔴 fails the `perf-regression` status check (non-required — does not block merge).',
);
lines.push('');

writeSummary(lines.join('\n'));

// Exit nonzero on regression so the GitHub status check shows red X.
// Per issue #23 design: the check should NOT be marked required in branch
// protection — it surfaces the concern visibly without blocking merge.
process.exit(worstStatus === 'regression' ? 1 : 0);

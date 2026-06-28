#!/usr/bin/env node
// perf-report.mjs — Summarize the WHOLE perf history (perf-metrics.jsonl on the
// orphan `metrics` branch) as a per-method trend report. This is the missing
// third script: perf-write.mjs appends one record, perf-compare.mjs diffs a PR
// against ONE baseline (two points) — neither can see a sustained trend or a
// regime step-change across the full series. This one can: its step-change
// detector is what surfaces a methodology shift (e.g. the #21 all-states
// populate rebuild) that a two-point diff misreads as a code regression.
//
// Stdlib-only — no npm deps. Run from the repo root.
//
// Usage:
//   node scripts/perf-report.mjs [metrics.jsonl]   # default: read metrics branch
//   node scripts/perf-report.mjs --selftest        # run the built-in self-check
//
// With no path arg it reads `git show origin/metrics:perf-metrics.jsonl` (fetch
// the branch first: `git fetch origin metrics`); falls back to ./perf-metrics.jsonl.
//
// Budget overlay is deliberately out of scope: the per-method budgets live in
// PERFORMANCE.md as documentation, and duplicating them here would drift. This
// report is about the SHAPE of the series over time, not pass/fail.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// A consecutive-record median jump at/above this ratio is called a step-change
// (a regime shift — workload/index/schema change — not run-to-run noise).
const STEP_RATIO = 1.5;

function die(msg, code = 1) {
  process.stderr.write(`perf-report: ${msg}\n`);
  process.exit(code);
}

// --- pure helpers (exercised by --selftest) ---------------------------------

/** Group every record's per-method entries by method_id, in record order. */
export function seriesByMethod(records) {
  const byId = new Map();
  for (const rec of records) {
    for (const m of rec.methods ?? []) {
      if (!byId.has(m.method_id)) byId.set(m.method_id, []);
      byId.get(m.method_id).push({
        median_ms: m.median_ms,
        mean_ms: m.mean_ms,
        p99_ms: m.p99_ms,
        commit_sha: rec.commit_sha,
        recorded_at: rec.recorded_at,
      });
    }
  }
  return byId;
}

/** Largest consecutive-record jump in median, with where it happened. */
export function biggestStep(points) {
  let best = { ratio: 1, at: null };
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].median_ms;
    const cur = points[i].median_ms;
    if (!(prev > 0) || !(cur > 0)) continue;
    const ratio = cur / prev; // directional: >1 slower, <1 faster
    if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(best.ratio))) {
      best = { ratio, at: points[i] };
    }
  }
  return best;
}

const min = (xs) => xs.reduce((a, b) => (b < a ? b : a), Infinity);
const max = (xs) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

// --- self-check -------------------------------------------------------------

function selftest() {
  const recs = [
    { commit_sha: 'aaa', recorded_at: 't0', methods: [{ method_id: 'm', median_ms: 1.0, mean_ms: 1, p99_ms: 2 }] },
    { commit_sha: 'bbb', recorded_at: 't1', methods: [{ method_id: 'm', median_ms: 1.1, mean_ms: 1, p99_ms: 2 }] },
    { commit_sha: 'ccc', recorded_at: 't2', methods: [{ method_id: 'm', median_ms: 3.0, mean_ms: 1, p99_ms: 2 }] }, // step
    { commit_sha: 'ddd', recorded_at: 't3', methods: [{ method_id: 'm', median_ms: 3.1, mean_ms: 1, p99_ms: 2 }] },
  ];
  const series = seriesByMethod(recs);
  const pts = series.get('m');
  console.assert(pts.length === 4, 'series length');
  const step = biggestStep(pts);
  console.assert(step.at?.commit_sha === 'ccc', `step located at ccc, got ${step.at?.commit_sha}`);
  console.assert(Math.abs(step.ratio - 3.0 / 1.1) < 1e-9, `step ratio ~2.73, got ${step.ratio}`);
  console.assert(step.ratio >= STEP_RATIO, 'step flagged');
  console.assert(min([3, 1, 2]) === 1 && max([3, 1, 2]) === 3, 'min/max');
  process.stdout.write('perf-report selftest: OK\n');
}

// --- load -------------------------------------------------------------------

function loadRecords(pathArg) {
  let raw;
  if (pathArg) {
    const p = resolve(pathArg);
    if (!existsSync(p)) die(`metrics file not found: ${p}`);
    raw = readFileSync(p, 'utf8');
  } else if (existsSync(resolve('perf-metrics.jsonl'))) {
    raw = readFileSync(resolve('perf-metrics.jsonl'), 'utf8');
  } else {
    try {
      raw = execFileSync('git', ['show', 'origin/metrics:perf-metrics.jsonl'], { encoding: 'utf8' });
    } catch {
      die('no metrics file given and `git show origin/metrics:perf-metrics.jsonl` failed — run `git fetch origin metrics` or pass a path');
    }
  }
  const records = raw.trim().split('\n').filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      die(`bad JSON on line ${i + 1}: ${err.message}`);
    }
  });
  if (records.length === 0) die('metrics file is empty');
  return records;
}

// --- render -----------------------------------------------------------------

const f = (n) => (typeof n === 'number' && isFinite(n) ? n.toFixed(3) : '  -  ');
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

function main() {
  const arg = process.argv[2];
  if (arg === '--selftest') return selftest();

  const records = loadRecords(arg);
  const first = records[0];
  const last = records[records.length - 1];

  // Header: span + runner fingerprints (a fingerprint change can itself shift
  // numbers, so surface how many distinct runner images the series spans).
  const images = new Set(records.map((r) => r.runner?.image_version).filter(Boolean));
  const cpus = new Set(records.map((r) => r.runner?.cpu_model).filter(Boolean));
  process.stdout.write(
    `\nperf history — ${records.length} records  ` +
    `${first.recorded_at.slice(0, 10)} → ${last.recorded_at.slice(0, 10)}\n` +
    `runner: ${[...cpus].join(' / ') || 'unknown'}  ·  ${images.size} image version(s)\n` +
    `latest: ${last.commit_sha.slice(0, 7)} (${last.recorded_at.slice(0, 16).replace('T', ' ')})\n\n`,
  );

  const series = seriesByMethod(records);
  const W = 28;
  process.stdout.write(
    pad('method', W) + ['first', 'last', 'min', 'max', 'medMed', 'p99max'].map((h) => padL(h, 8)).join('') +
    '  biggest median step\n',
  );
  process.stdout.write('-'.repeat(W + 8 * 6) + '  ' + '-'.repeat(22) + '\n');

  const steps = [];
  for (const [id, pts] of series) {
    const medians = pts.map((p) => p.median_ms).filter((x) => typeof x === 'number');
    const p99s = pts.map((p) => p.p99_ms).filter((x) => typeof x === 'number');
    const sorted = [...medians].sort((a, b) => a - b);
    const medOfMed = sorted[Math.floor(sorted.length / 2)];
    const step = biggestStep(pts);
    const flagged = step.at && step.ratio !== 1 && (step.ratio >= STEP_RATIO || step.ratio <= 1 / STEP_RATIO);
    if (flagged) steps.push({ id, step });
    const stepStr = flagged
      ? `${step.ratio >= 1 ? '↑' : '↓'}${step.ratio.toFixed(2)}× @ ${step.at.commit_sha.slice(0, 7)}`
      : 'stable';
    process.stdout.write(
      pad(id, W) +
      [f(pts[0].median_ms), f(pts[pts.length - 1].median_ms), f(min(medians)), f(max(medians)), f(medOfMed), f(max(p99s))]
        .map((s) => padL(s, 8)).join('') +
      '  ' + stepStr + '\n',
    );
  }

  // Step-change callouts — the regime shifts a two-point PR diff can't see.
  if (steps.length) {
    process.stdout.write('\nstep-changes (median jump ≥ ' + STEP_RATIO + '× between consecutive records):\n');
    // Cluster by the commit where the step lands: a shared commit across many
    // methods is a methodology/schema shift, not a per-method code regression.
    const byCommit = new Map();
    for (const s of steps) {
      const k = s.step.at.commit_sha.slice(0, 7);
      if (!byCommit.has(k)) byCommit.set(k, { at: s.step.at, ids: [] });
      byCommit.get(k).ids.push(`${s.id} ${s.step.ratio >= 1 ? '↑' : '↓'}${s.step.ratio.toFixed(2)}×`);
    }
    for (const [sha, { at, ids }] of byCommit) {
      const tag = ids.length >= 3 ? '  ← shared across methods → a runner/workload/schema shift, not a per-method code regression' : '';
      process.stdout.write(`  ${sha} (${at.recorded_at.slice(0, 10)})${tag}\n`);
      for (const line of ids) process.stdout.write(`      ${line}\n`);
    }
  } else {
    process.stdout.write('\nno step-changes — series is stable within run-to-run noise.\n');
  }
  process.stdout.write('\n');
}

main();

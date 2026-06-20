#!/usr/bin/env node
// perf-write.mjs — Extract bench results from vitest's JSON output, build a
// JSONL record (schema v1.0), and append one line to the perf history file.
//
// Used by .github/workflows/perf-history.yml on push to develop. The CI step
// runs `npm run test:perf` (which writes perf-output.json), then runs this
// script to append a record to perf-metrics.jsonl on the orphan
// `metrics` branch.
//
// Stdlib-only — no npm deps. Run from the repo root.
//
// Usage:
//   node scripts/perf-write.mjs <vitest-output.json> <history-file.jsonl>
//
// Exit codes:
//   0  success
//   1  argument / file-read error
//   2  vitest output schema unexpected (the issue-#23 gate flagged that
//      vitest benchmark output is experimental and does not follow SemVer
//      — surface that explicitly rather than appending a corrupt record).

import { readFileSync, writeFileSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, arch, platform } from 'node:os';
import { resolve } from 'node:path';
import { METHOD_IDS } from './perf-methods.mjs';

const SCHEMA_VERSION = '1.0';

function die(msg, code = 1) {
  process.stderr.write(`perf-write: ${msg}\n`);
  process.exit(code);
}

const [, , inputArg, outputArg] = process.argv;
if (!inputArg || !outputArg) {
  die('usage: perf-write.mjs <vitest-output.json> <history-file.jsonl>');
}
const inputFile = resolve(inputArg);
const outputFile = resolve(outputArg);

if (!existsSync(inputFile)) die(`vitest output not found: ${inputFile}`);

let report;
try {
  report = JSON.parse(readFileSync(inputFile, 'utf8'));
} catch (err) {
  die(`failed to parse vitest output: ${err.message}`);
}

// Walk the vitest JSON schema. Shape (vitest 4.x):
//   { files: [{ filepath, groups: [{ fullName, benchmarks: [{ name, mean, median, p99, ... }] }] }] }
if (!report || !Array.isArray(report.files)) {
  die('vitest output missing "files" array — schema change?', 2);
}

const methods = [];
for (const file of report.files) {
  if (!Array.isArray(file.groups)) continue;
  for (const group of file.groups) {
    if (!Array.isArray(group.benchmarks)) continue;
    for (const b of group.benchmarks) {
      const id = METHOD_IDS.get(b.name);
      if (!id) {
        // Unknown bench name — warn but continue so the rest of the record
        // is still written. A rename in the bench file without updating
        // METHOD_IDS above is the most likely cause.
        process.stderr.write(`perf-write: unknown bench name "${b.name}" — not in METHOD_IDS, skipping\n`);
        continue;
      }
      if (typeof b.mean !== 'number' || typeof b.median !== 'number' || typeof b.p99 !== 'number') {
        die(`bench "${b.name}" missing mean/median/p99 — vitest schema change?`, 2);
      }
      methods.push({
        method_id: id,
        variant_label: b.name,
        samples_count: Number(b.sampleCount ?? 0),
        mean_ms: b.mean,
        median_ms: b.median,
        p99_ms: b.p99,
      });
    }
  }
}

if (methods.length === 0) die('no benchmarks found in vitest output', 2);

// Package-lock hash — sha256 of the lock file. Detects dependency drift
// between baseline and PR runs that could cause unrelated perf shifts.
let packageLockHash = '';
try {
  const lock = readFileSync(resolve('package-lock.json'), 'utf8');
  packageLockHash = 'sha256:' + createHash('sha256').update(lock).digest('hex');
} catch {
  // No lock file (or unreadable) — leave hash empty rather than failing.
}

// vitest version — read from devDependencies in package.json so the bench
// file doesn't need to be touched if vitest is bumped.
let vitestVersion = '';
try {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  vitestVersion = pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest ?? '';
} catch {
  // ignore — non-blocking
}

const cpuModel = cpus()[0]?.model ?? 'unknown';

const record = {
  schema_version: SCHEMA_VERSION,
  recorded_at: new Date().toISOString(),
  commit_sha: process.env.GITHUB_SHA ?? '',
  branch: process.env.GITHUB_REF_NAME ?? '',
  event: process.env.GITHUB_EVENT_NAME ?? '',
  pr_number: process.env.PR_NUMBER ?? '',
  runner: {
    os: platform(),
    arch: arch(),
    cpu_model: cpuModel,
    image_os: process.env.ImageOS ?? '',
    image_version: process.env.ImageVersion ?? '',
    runner_os: process.env.RUNNER_OS ?? '',
  },
  node_version: process.version,
  vitest_version: vitestVersion,
  package_lock_hash: packageLockHash,
  methods,
};

// Ensure trailing newline so concatenated JSONL parses cleanly.
const line = JSON.stringify(record) + '\n';

// Append or create. If the file doesn't exist, write it fresh.
if (existsSync(outputFile)) {
  appendFileSync(outputFile, line);
} else {
  writeFileSync(outputFile, line);
}

const sizeKb = (statSync(outputFile).size / 1024).toFixed(1);
process.stdout.write(
  `perf-write: appended ${methods.length} methods to ${outputFile} (${sizeKb} KB total)\n`,
);

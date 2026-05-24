# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

_Nothing has been released yet. These entries will form the first release — the
first `develop` → `main` squash._

### Added

- **Goal 3 — Retry history / DLQ lineage.** `client.recordDeadLetter({sourceJobId, dlqJobId})` records a source→DLQ link in `terminal_detail.deadLetteredAs` JSONB on the source's last `failed` row. `client.findDeadLetterSource(dlqJobId)` returns `{jobId, attempt, queue}` of the source. `client.findDeadLetterTarget(sourceJobId)` returns `{dlqJobId, attempt}`. Consumer is responsible for preserving the source id on the DLQ job's `data` payload (typically `data._originalJobId`). Issue [#4](https://github.com/elfensky/pg-bossier/issues/4).
- **Goal 2 — Terminal-state detail.** `client.recordTerminalDetail(jobId, attempt, payload)` writes a worker-classified failure shape (`class: 'transient' | 'non_retryable'` mandated on `failed`) to `pgbossier.record.terminal_detail`. Discriminated-union typed reader returns `TerminalDetailFailed | TerminalDetailCompleted | TerminalDetailCancelled | null` keyed on row state. `recordPatch` no longer accepts `terminal_detail` (single-writer convention). New public type exports: `TerminalDetail`, `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`. Issue [#3](https://github.com/elfensky/pg-bossier/issues/3).
- CI-anchored performance history (issue [#23](https://github.com/elfensky/pg-bossier/issues/23)). Two new GitHub Actions workflows: `.github/workflows/perf-history.yml` runs the bench on every `push: develop` and appends one JSONL record (including runner fingerprint — OS, image OS/version, CPU model, Node version, vitest version, package-lock SHA256) to `perf-metrics.jsonl` on the orphan **`metrics`** branch; `.github/workflows/perf-pr.yml` runs on every `pull_request`, fetches the latest develop baseline, writes a Markdown diff table to `$GITHUB_STEP_SUMMARY`, and exits nonzero on regression so the non-required `perf-regression` status check shows a red X without blocking merge (mean >+100% or p99 >+400% trips it). Stale baselines (>14 days old or fingerprint mismatch) get flagged in the summary. Writer and comparer are stdlib-only Node scripts (`scripts/perf-write.mjs`, `scripts/perf-compare.mjs`); one-time orphan-branch init steps documented in `docs/metrics-init.md`.
- Restructured the perf bench from a hand-rolled `it()`-based sampler to vitest's native `bench()` blocks (`test/perf/chronicle-scale.test.ts` → `test/perf/chronicle-scale.bench.ts`). Each bench is pinned to `iterations: 100, time: 0, warmupIterations: 0` so the sample count remains deterministic across runs. `vitest.perf.config.ts` now drives `vitest bench` and writes the structured `perf-output.json` consumed by the issue #23 pipeline. This soft-invalidates PR #22's first-measurement numbers in `PERFORMANCE.md` — fresh CI baselines become the source of truth as the `metrics` chronicle accumulates.
- First-measurement performance bench at `test/perf/chronicle-scale.bench.ts`, runnable via `npm run test:perf` (uses a dedicated `vitest.perf.config.ts`; the default `npm test` excludes `test/perf/**`). Populates 1,000 jobs through pg-boss's full happy-path lifecycle and samples each of the ten Goal 5 read-method variants 100 times. Methodology, first-measurement numbers, and published per-method budgets recorded in `PERFORMANCE.md` at the repo root. Resolves issue [#12](https://github.com/elfensky/pg-bossier/issues/12); scale extensions, direct DB-side trigger-overhead measurement, and budget violation policy continue as follow-up [#21](https://github.com/elfensky/pg-bossier/issues/21).
- Initial project scaffolding: `package.json`, `CLAUDE.md`, `.gitignore`, `CHANGELOG.md`.
- `pg-boss ^12.18.2` declared as a peer dependency.
- TypeScript with `strict` mode and `noUncheckedIndexedAccess`, ESM output via `"type": "module"` and `NodeNext` resolution, `.d.ts` declarations emitted alongside `.js`.
- `npm run build` script (runs `tsc`); source in `src/`, build output in `dist/`.
- ESLint flat config (`eslint.config.js`) with `typescript-eslint` `recommended-type-checked` + `stylistic-type-checked` presets, using `projectService` for tsconfig auto-discovery.
- `npm run lint` and `npm run lint:fix` scripts.
- Working conventions documented in `CLAUDE.md` — critical rules, the Git branching/worktree workflow, language and linting choices, file guidelines, and a verify-before-done rule.
- `.worktrees/` added to `.gitignore`.
- `install(pool)` — creates the `pgbossier` schema, the `pgbossier.record` chronicle table (one row per `(job_id, attempt)`) and its indexes, the `pgbossier.capture()` function, and a capture trigger on `pgboss.job`; backfills jobs that predate installation. Idempotent.
- `uninstall(pool)` — `DROP SCHEMA pgbossier CASCADE`; removes everything and cascades away the capture trigger, leaving `pgboss.job` untouched (symmetric drop-in).
- Capture trigger mirrors every `pgboss.job` state transition (`created` / `active` / `retry` / `completed` / `cancelled` / `failed`) into `pgbossier.record`, preserving each attempt forever — surviving pg-boss's DELETE+INSERT retry path. Fail-open: a capture error is logged as a warning and never blocks the underlying pg-boss operation.
- `bossier({ boss, pool })` client — one unified surface that wraps the pg-boss instance: every pg-boss method is forwarded to it, and pg-bossier's own methods sit alongside, including `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns `terminal_detail` and `input_snapshot`.
- Public API from `src/index.ts`: `install`, `uninstall`, `bossier`, and the `Bossier` / `BossierMethods` / `BossierOptions` / `RecordPatch` types.
- `pg ^8.0.0` declared as a peer dependency (consumers supply the `pg.Pool`).
- Integration test suite — `vitest` with `@testcontainers/postgresql`, run against real Postgres + pg-boss 12.18.2 (no mocks).
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) — runs lint, build, and the integration suite on every push to `develop` or `main` and every pull request.
- `package.json` `exports`, `main`, `types`, `files`, and `engines` fields, plus a `prepare` build hook — `import` from `pg-bossier` resolves, the published tarball is scoped to `dist/`, and the gitignored `dist/` is built automatically on publish and on git-dependency installs.
- `README.md` — install instructions, a usage example, requirements, and project status.
- `COMPATIBILITY.md` — pg-boss compatibility tiers (Stable / Transitional / Forbidden) for every pg-boss surface the substrate depends on.
- `LICENSE` — MIT license file (the license was already declared in `package.json`).
- Goal 5 operational read API — seven typed read methods on the `bossier` client, all querying the permanent `pgbossier.record` chronicle so jobs stay answerable after pg-boss has deleted the `pgboss.job` row:
  - `findById(jobId)` — the latest attempt of one job (`null` if unknown or malformed).
  - `getRetryHistory(jobId)` — every attempt of a job, oldest first.
  - `listJobs(opts)` — filtered, paginated job list over the current-attempt view, with an exact total (independent of pagination).
  - `latestPerQueue(queues)` — the most recently created job in each queue.
  - `countByState(filter)` / `countByQueue(filter)` — job counts grouped by current state (all six state keys zero-filled) or by queue.
  - `listLongRunning(opts)` — active jobs whose `started_on` is older than a threshold (default 900s).
- Exported read-API types `JobRecord`, `JobState`, `JobFilter`, and `ListJobsOpts`; `findById`, `getRetryHistory`, and `listJobs` are generic over `<TInput, TOutput>`.
- `record_active_idx` — a partial index on `pgbossier.record (queue, started_on) WHERE state = 'active'` that serves `listLongRunning` without a sequential scan.
- Goal 6 persistent job-progress API on the `bossier` client — `setProgress` and `getProgress`, reading and writing the `pgbossier.record.progress` column, which survives pg-boss's DELETE+INSERT retry path:
  - `setProgress(jobId, progress)` — writes progress to the job's current attempt (resolved server-side as `max(attempt)`, so the worker needs only `job.id`). Accepts any JSON-serializable value; fail-open on runtime errors; throws only on a null/undefined/non-serializable argument.
  - `getProgress(jobId)` — returns `{ progress, attempt }` for the most-recent non-null progress across attempts (the `attempt` distinguishes a current-attempt checkpoint from a carried-forward prior-attempt value), or `null` if unknown or never written.
- Exported type `ProgressResult<TProgress>`; `getProgress` is generic over `<TProgress>`.
- **Goal 7 — Lifecycle event API** (#8). `subscribe()` returns a typed `BossierEvents` (Node `EventEmitter`) that fires `'created'`, `'started'`, `'completed'`, `'failed'`, `'cancelled'`, `'retried'`, plus a `'job'` catch-all, `'connected'`, `'warning'`, and a discriminated `'error'` (`reason: 'gap' | 'parse' | 'handler'`). Transport: Postgres `LISTEN/NOTIFY` on `pgbossier_job` from the existing capture trigger. Auto-reconnect with exponential backoff + jitter. `AbortSignal` and `Symbol.asyncDispose` support.
- **`seq BIGINT` monotonic event cursor** on `pgbossier.record` (sequence `pgbossier.record_seq`, advanced on every INSERT/UPDATE). Included in the NOTIFY payload.
- **`getEventsSince(seq, opts?)`** on the `bossier` client — catch-up read for use after a gap signal. Returns the latest state per attempt (the audit table upserts each `(job_id, attempt)`).
- `COMPATIBILITY.md`: new "Unsupported topologies" section (PgBouncer transaction-mode, standby connections, `target_session_attrs=read-write`).
- **Goal 9 — Install / distribution shape** (#10). Schema names
  (`pgbossier`, `pgboss`) become configurable via
  `install(pool, { schema?, pgbossSchema? })`. Trigger name and NOTIFY
  channel scoped to the schema (`${schema}_capture`, `${schema}_job`)
  to support multiple pg-bossier installs per database. Hardened
  validation: rejects `public`, `information_schema`, `pg_*`-prefixed
  names, reserved keywords, and identifiers over 63 bytes. `install()`
  wraps DDL in a transaction with a preflight `SELECT 1 FROM
  pgboss.job LIMIT 0` check — failure leaves no partial state.
- **CLI** (`npx pg-bossier install`, `uninstall`). Stdlib `parseArgs`
  with `strict: true`. Prints destination (`host=… database=… schema=…`)
  before any SQL runs. Exit codes: 0 success, 1 usage error, 2 runtime
  error, 64 invalid schema name.
- **package.json**: `bin: { pgbossier: ./bin/pgbossier.js }`, `engines`
  bumped to `>=18.3.0`, `files: ["dist", "bin"]`.
- **`CONTRIBUTING.md`**: first-publish runbook (develop → main mechanics,
  `npm publish --dry-run`, version-bump policy).
- **CI**: new `consumer-artifact-smoke-test` job that `npm pack`s and
  installs the tarball in a fresh directory — verifies the bin script
  and bundled `dist/` work end-to-end.

### Changed

- **`recordTerminalDetail` (Goal 2) now uses JSONB merge.** The internal `UPDATE` writes `COALESCE(terminal_detail, '{}'::jsonb) || $payload` instead of the prior `SET terminal_detail = $payload` overwrite. This is the prerequisite for `recordDeadLetter` to cooperate; the new semantic is key-level (a second call's keys overwrite same-keyed values; non-overlapping keys from prior calls survive). External behavior change: a call to `recordTerminalDetail` that previously would have wiped out a prior call's keys now preserves them.
- `COMPATIBILITY.md` now documents the per-PR update cadence and the explicit decision against a CI version matrix and a time-bound support SLA. CI adds a tripwire step that warns when pg-boss publishes a minor above the peer-dep floor in `package.json`. Resolves issue [#9](https://github.com/elfensky/pg-bossier/issues/9). Cross-version correctness assertions on `pgbossier.record` continue as follow-up [#19](https://github.com/elfensky/pg-bossier/issues/19).
- The integration test harness constructs pg-boss with `supervise: false` and `schedule: false`, so its maintenance loop and cron scheduler no longer perturb `count(*)` assertions during tests.
- `recordPatch` no longer writes the `progress` column — `setProgress` is its sole write path.
- **Internal signatures**: free functions in `src/read.ts`,
  `src/progress.ts`, `src/events.ts`, `src/record.ts` now take a
  `SchemaNames` parameter as the second argument (after `pool`). Public
  API via `bossier({ boss, pool })` unchanged — schemas resolve at
  construction time and close over each method.
- **`setProgress` error messages** — prefixed with `pg-bossier:` for consistency with the new `recordTerminalDetail` validator. External behavior unchanged; only the error message text shifted.

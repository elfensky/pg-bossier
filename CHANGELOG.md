# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Changed

- Internal: the canonical UUID regex (the read API tests `jobId` against it to short-circuit a malformed id to a clean `null`/`[]` instead of a Postgres `uuid`-cast error) is now a single exported `UUID_RE` in `sql.ts`, replacing three identical copies in `read.ts` / `progress.ts` / `input-snapshot.ts`.
- Internal: the `seq` column is now defined directly in `pgbossier.record`'s `CREATE TABLE` instead of bolted on by a separate `ALTER TABLE … ADD COLUMN`. Removed the speculative ALTER-based "upgrade path" and its test — no pre-`seq` version ever shipped, so there was no in-place upgrade to support (0.x schema changes are drop+reinstall). Resulting schema is identical.

## [0.1.0] - 2026-06-21

First tagged release. Cut for the descent-app validation trial; **not yet
published to npm** (publish is gated on that trial). Install via the `v0.1.0`
git tag — see the README. All nine charter goals are delivered.

### Removed

- **`recordPatch` and the `RecordPatch` type.** The general-purpose patch writer had narrowed over time to a single writable column (`input_snapshot`) — the same column `recordInputSnapshot` already owns — making it redundant duplicate tooling. `recordInputSnapshot` is now the **sole** input-snapshot writer. `recordPatch`'s only unique behavior, clearing the column to SQL `NULL` via `{ input_snapshot: null }`, was dropped as unused (descent-app's domain audit table owns provenance, so `input_snapshot` is opt-in and rarely written); re-add to `recordInputSnapshot` if a clear path is ever needed. Pre-1.0, no published version carried `recordPatch`.

### Fixed

- **README dead-letter contract corrected.** The documented `_originalJobId` pattern put the self-identifying id only on the job's `data`, not as the job's *actual* id — but `recordDeadLetter` keys on pg-boss's real job id (via the chronicle), so as written it would silently no-op (`reason: 'not_found'`) and never record the lineage. The examples now also pass `{ id: sourceId }` to `send` and explain that both halves (the `id` option *and* the `data` field) are required. Verified end-to-end by a new test against pg-boss's native dead-letter routing.
- **`install()` no longer freezes a live pg-boss queue while backfilling.** The backfill `INSERT … SELECT FROM pgboss.job` previously ran inside the same transaction as `CREATE`/`DROP TRIGGER` on `pgboss.job`, so the trigger DDL's lock (DROP: `ACCESS EXCLUSIVE`, CREATE: `SHARE ROW EXCLUSIVE`) was held for the entire backfill — blocking every pg-boss queue write (and read) for as long as the backfill ran on a large `pgboss.job`. The DDL now commits first (trigger goes live, lock releases); the idempotent `ON CONFLICT DO NOTHING` backfill runs afterward, where its `SELECT` takes only `ACCESS SHARE` and never blocks pg-boss. DDL remains atomic; a failed backfill is safely completed by re-running `install()`. Surfaces a mis-framing in issue [#11](https://github.com/elfensky/pg-bossier/issues/11) (the risk is the trigger DDL lock, not the backfill SELECT's own lock).

### Added

- `docs/adopting-in-descent-app.md` — step-by-step adoption guide for the descent-app validation trial (install via the `v0.1.0` tag, run the migration, swap queries per the scorecard, the two contracts to honor), including a copy-paste prompt for a Claude session in descent-app. Linked from the README's git-URL install section.
- `docs/descent-app-fit.md` — the success-criterion-#1 scorecard: a verified mapping of descent-app's `queries.js` raw SQL onto pg-bossier's read API, with the documented short list of what stays raw by design (the two `pgboss.job.output` writers and a conditional residual lookup for the deliberately-uncaptured metadata columns). Linked from the README's "Reading job history" section.
- `latestPerQueue` gains an `orderBy?: 'createdOn' | 'completedOn'` option (default `'createdOn'`, backward-compatible). `'completedOn'` returns the last *finished* job per queue (`NULLS LAST`), matching descent-app's `getLastJobPerSchedule` "last finished run per scheduled queue" need without a behavior change for existing callers.
- Goal 1 forensic-survival regression test: a completed job's `pgbossier.record` row (and `findById` / `getRetryHistory` reads) survive pg-boss's `deletion_seconds` hard-`DELETE` of the row from `pgboss.job` — the headline "what happened to job X six months ago?" promise (success criterion #2), previously only proven across the retry `DELETE`+`INSERT`, never across the maintenance delete.
- Non-default-schema runtime regression test: a full capture → `findById`/`getRetryHistory` → `subscribe` event round-trip under a custom `pgbossier` schema, exercising the schema-interpolated capture function, NOTIFY channel, and read SQL at runtime (previously only install-time DDL was covered for custom schemas).
- Production-path test coverage: a `work()`-driven happy-path capture test (the polling-worker auto-complete path descent-app runs in production, vs the manual `fetch()`/`complete()` used elsewhere), and an end-to-end test against pg-boss's **native** dead-letter routing (real `deadLetter` queue → `recordDeadLetter` → `findDeadLetterSource`/`findDeadLetterTarget`) — previously the DLQ lineage was only covered with a synthetic DLQ id.
- **Goal 4 — Input-snapshot slot.** `client.recordInputSnapshot(jobId, attempt, snapshot)` writes opt-in worker-supplied snapshots to `pgbossier.record.input_snapshot`. `client.getInputSnapshot<T>(jobId, attempt?)` reads them with dual-mode return: `T | null` for explicit attempt, `{snapshot, attempt} | null` for most-recent. New GIN index `record_input_snapshot_gin` enables containment queries. New public type export: `InputSnapshotResult<T>`. Issue [#5](https://github.com/elfensky/pg-bossier/issues/5).
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
- `bossier({ boss, pool })` client — one unified surface that wraps the pg-boss instance: every pg-boss method is forwarded to it, and pg-bossier's own methods sit alongside on one flat surface (the per-column writers, Goal 5 reads, and event subscription each documented in their own entries).
- Public API from `src/index.ts`: `install`, `uninstall`, `bossier`, and the `Bossier` / `BossierMethods` / `BossierOptions` types.
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
- **Internal signatures**: free functions in `src/read.ts`,
  `src/progress.ts`, `src/events.ts`, `src/record.ts` now take a
  `SchemaNames` parameter as the second argument (after `pool`). Public
  API via `bossier({ boss, pool })` unchanged — schemas resolve at
  construction time and close over each method.
- **`setProgress` error messages** — prefixed with `pg-bossier:` for consistency with the new `recordTerminalDetail` validator. External behavior unchanged; only the error message text shifted.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

_Nothing has been released yet. These entries will form the first release — the
first `develop` → `main` squash._

### Added

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
- `bossier({ boss, pool })` client — one unified surface that wraps the pg-boss instance: every pg-boss method is forwarded to it, and pg-bossier's own methods sit alongside, including `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns (`progress`, `terminal_detail`, `input_snapshot`).
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

### Changed

- The integration test harness constructs pg-boss with `supervise: false` and `schedule: false`, so its maintenance loop and cron scheduler no longer perturb `count(*)` assertions during tests.

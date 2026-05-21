# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

## [0.1.1] - 2026-05-21

### Added

- GitHub Actions CI workflow (`.github/workflows/ci.yml`) — runs lint, build, and the integration suite on every push to `main` and every pull request.
- `package.json` `exports`, `main`, `types`, `files`, and `engines` fields, plus a `prepare` build hook — `import` from `pg-bossier` now resolves, the published tarball is scoped to `dist/`, and the gitignored `dist/` is built automatically on publish and on git-dependency installs.
- `README.md` — install instructions, a usage example, requirements, and project status.
- `COMPATIBILITY.md` — pg-boss compatibility tiers (Stable / Transitional / Forbidden) for every pg-boss surface the substrate depends on.
- `LICENSE` — MIT license file (the license was already declared in `package.json`).

### Changed

- The integration test harness constructs pg-boss with `supervise: false` and `schedule: false`, so its maintenance loop and cron scheduler no longer perturb `count(*)` assertions during tests.

## [0.1.0] - 2026-05-21

### Added

- Initial project scaffolding: `package.json`, `CLAUDE.md`, `.gitignore`, `CHANGELOG.md`.
- `pg-boss ^12.18.2` declared as a peer dependency.
- TypeScript with `strict` mode and `noUncheckedIndexedAccess`, ESM output via `"type": "module"` and `NodeNext` resolution, `.d.ts` declarations emitted alongside `.js`.
- `npm run build` script (runs `tsc`); source in `src/`, build output in `dist/`.
- Placeholder `src/index.ts` so the build pipeline is exercisable end-to-end.
- ESLint flat config (`eslint.config.js`) with `typescript-eslint` `recommended-type-checked` + `stylistic-type-checked` presets, using `projectService` for tsconfig auto-discovery.
- `npm run lint` and `npm run lint:fix` scripts.
- Working conventions in `CLAUDE.md`: Critical rules (KISS, faithful reporting, doc sync, no direct pushes to `main`); Branching/worktree/Git workflow (single-trunk on `main`, worktree-per-branch default, `--no-ff` merges, no squash, version-on-merge); File guidelines (chunked reads, broad rename search, file/function size preferences); explicit "verify before claiming done" rule in Build / test / run.
- `.worktrees/` added to `.gitignore`.
- `install(pool)` — creates the `pgbossier` schema, the `pgbossier.record` chronicle table (one row per `(job_id, attempt)`) and its indexes, the `pgbossier.capture()` function, and a capture trigger on `pgboss.job`; backfills jobs that predate installation. Idempotent.
- `uninstall(pool)` — `DROP SCHEMA pgbossier CASCADE`; removes everything and cascades away the capture trigger, leaving `pgboss.job` untouched (symmetric drop-in).
- Capture trigger mirrors every `pgboss.job` state transition (`created` / `active` / `retry` / `completed` / `cancelled` / `failed`) into `pgbossier.record`, preserving each attempt forever — surviving pg-boss's DELETE+INSERT retry path. Fail-open: a capture error is logged as a warning and never blocks the underlying pg-boss operation.
- `bossier({ boss, pool })` client exposing the underlying pg-boss instance plus `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns (`progress`, `terminal_detail`, `input_snapshot`).
- Public API from `src/index.ts`: `install`, `uninstall`, `bossier`, and the `BossierClient` / `BossierOptions` / `RecordPatch` types.
- `pg ^8.0.0` declared as a peer dependency (consumers supply the `pg.Pool`).
- Integration test suite — `vitest` with `@testcontainers/postgresql`, run against real Postgres + pg-boss 12.18.2 (no mocks).

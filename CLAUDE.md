# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-release (`0.0.0`) — nothing published yet.** The shared storage substrate (PR #15) is in place: the `pgbossier.record` chronicle table, the `pgbossier_capture` trigger on `pgboss.job`, idempotent `install()` / `uninstall()`, the unified `bossier({ boss, pool })` client — a `Proxy` over the pg-boss instance exposing pg-boss's whole API plus pg-bossier's own methods (`recordPatch` + the Goal 5 reads) on one flat surface, no `.boss` sub-object — and a `vitest` + `@testcontainers/postgresql` integration suite — plus GitHub Actions CI, the `exports` / `files` / `prepare` packaging that makes `pg-bossier` importable and publishable, a `COMPATIBILITY.md` pg-boss tier doc, and a deterministic test harness. `src/` is real code — `sql.ts` (DDL), `install.ts`, `record.ts`, `client.ts`, `read.ts`, `index.ts` (public API). **Goal 1** (the forensic audit table) is delivered — issue #2 closed. **Goal 5**'s operational read API — `findById` / `getRetryHistory` / `listJobs` / `latestPerQueue` / `countByState` / `countByQueue` / `listLongRunning` on the `bossier` client — merged via PR #17; its issue #6 is closed. **Goal 6**'s persistent progress API — `setProgress` / `getProgress` in `src/progress.ts`, on the `bossier` client — merged via `a7a8074`; its issue #7 is closed. **Goal 7**'s lifecycle event API — `subscribe()` returning a typed `BossierEvents`, `getEventsSince(seq)`, a monotonic `seq` column on `pgbossier.record`, and `pg_notify` inside the capture trigger — merged via the `feature/goal-7-lifecycle-events` branch; its issue #8 is closed. **Goal 8**'s pg-boss compatibility doc tightening — `COMPATIBILITY.md` ratifies the decisions against a CI version matrix and a time-bound SLA, with a self-firing CI tripwire that warns when pg-boss publishes a minor above the peer-dep floor — merged via PR #20 (`5b2a3d0`); its issue #9 is closed (cross-version correctness assertions continue as follow-up #19). **Goal 8 / performance budget** — a vitest perf bench at `test/perf/chronicle-scale.bench.ts` (opt-in via `npm run test:perf`, dedicated `vitest.perf.config.ts`) populates 1,000 jobs through pg-boss's full happy-path lifecycle and samples each of the ten Goal 5 read-method variants 100 times via vitest's `bench()` (pinned to `iterations: 100, time: 0`); per-method published budgets live in `PERFORMANCE.md` at the repo root — merged via PR #22 (`1c71721`); issue #12 closed (scale extensions, direct DB-side trigger-overhead measurement, and budget violation policy continue as follow-up #21; trigger-overhead via populate-time delta was attempted in PR #22 and dropped as unreliable at N=1000, see PR #22 description). **Issue #23 / CI-anchored perf history** — `.github/workflows/perf-history.yml` runs the bench on every `push: develop` and appends a JSONL record (with runner fingerprint) to `perf-metrics.jsonl` on the orphan **`metrics`** branch; `.github/workflows/perf-pr.yml` runs on every PR, diffs against the latest develop baseline, and writes a Markdown summary to `$GITHUB_STEP_SUMMARY` plus a non-required `perf-regression` status check that shows a red X on regression (mean >+100% or p99 >+400%) without blocking merge; the bench was restructured from a hand-rolled `it()`-based sampler to vitest's `bench()` blocks as part of this work, which soft-invalidates PR #22's first-measurement numbers in favor of fresh CI baselines. Scripts: `scripts/perf-write.mjs` (writer), `scripts/perf-compare.mjs` (PR comparer), stdlib-only. One-time orphan-branch init: `docs/metrics-init.md`. The other goals are at varying stages — see issue #1's "Implementation progress" section for the authoritative per-goal status. The version stays `0.0.0` on `develop` until the first release (the first `develop` → `main` squash). Don't invent architecture answers; check open issues first and ask if a decision hasn't been made.

The canonical scope document is **[issue #1](https://github.com/elfensky/pg-bossier/issues/1)** ("Requirements: what pg-bossier should achieve"). Treat it as the rubric — any feature, refactor, or design choice must be justifiable against the goals and non-goals it lists. Issue #1 itself explicitly notes: "Anything not explicitly in scope is out — feature requests outside this boundary get closed with a reference to this issue."

## Critical rules

- **KISS.** Simple solutions only. Don't overengineer. Don't add abstractions for hypothetical future needs. Three similar lines beats a premature abstraction. When in doubt about an open question, default to the simpler choice and surface the tradeoff rather than silently picking a clever one.
- **Report outcomes faithfully.** If lint, build, or tests fail, say so with the actual output. If you didn't run a verification step, say so — don't imply it ran. Never claim "all checks pass" when output shows failures. Never suppress or simplify failing checks to manufacture a green result. Never characterize incomplete or broken work as done.
- **Keep docs in sync with code.** When a change affects `CLAUDE.md`, `CHANGELOG.md`, or an open issue, update the doc in the same change — not a separate follow-up. Stale docs are worse than no docs.
- **`main` only ever receives release commits and hotfixes** — never a direct or feature commit. On `develop`: large features go through a worktree → branch → `--no-ff` merge; bugfixes, chores, and docs may be committed directly. See § Branching, worktrees, and Git workflow.

## What pg-bossier is

A **JS/TS library that layers on top of [pg-boss](https://github.com/timgit/pg-boss)** to provide an **operational data plane** — capabilities pg-boss has explicitly declined to take on. Nine concrete goals:

1. **Permanent job history.** `pgbossier.record` populated automatically, surviving pg-boss's in-place row deletion (the `deletion_seconds` `DELETE` and the retry `DELETE`+`INSERT`). **Delivered.**
2. **Typed terminal-state detail.** `terminal_state` (pg-boss's three terminal values — `completed` / `cancelled` / `failed`) + `terminal_detail` (JSONB discriminated by state; `class` mandated when `failed`; `expired` / `superseded` are pg-bossier-derived markers, not pg-boss states). One typed read answers "why did this fail?" without string-matching error text.
3. **Retry history tracking.** A job keeps one stable `id` across all retries (pg-boss reuses it through the retry `DELETE`+`INSERT`); each attempt is a preserved row-version. `getRetryHistory(jobId)` returns the ordered attempt sequence — no link columns.
4. **Optional input-snapshot capture.** Opt-in JSONB slot for consumer-supplied "what data did this job see" manifests. Pg-bossier preserves; consumers define shape.
5. **New APIs.** Operational read methods (`peek` / `findById` / `listActive` / `listStalled` / `getRetryHistory` / state-counts). pg-boss 12 partially covers some (`findJobs` / `getQueueStats` / `getWipData`) — the Goal 5 sub-issue names each method's differentiator. Write extensions for Goals 2/4/6 are deferred per-feature per the API-shape principle. **The operational read API merged via PR #17; issue #6 is closed.**
6. **Persistent job progress.** One mechanism that survives DELETE+re-INSERT. Two usage patterns from the same slot: resumable (position) and non-resumable (display). Worker decides whether to use the persisted value on retry.
7. **Lifecycle event API.** Event emission on every state transition (in-process EventEmitter and/or `LISTEN/NOTIFY` on `pgbossier_*` channels). Maps to pg-boss#570 (declined upstream). Distinct from pg-boss's "pub/sub" feature (which is queue fan-out, not real-time events).
8. **pg-boss compatibility tier system.** Stable / Transitional / Forbidden classification + CI matrix.
9. **One-step install, symmetric uninstall.** One dependency + one migration + `DROP SCHEMA pgbossier CASCADE` for clean removal.

pg-boss stays an **unmodified npm dependency** — pg-bossier extends it, never replaces it.

## Non-negotiable boundaries

From issue #1. These are not up for casual revisiting inside an implementation PR — if a task feels like it crosses one of these lines, surface that explicitly:

### Non-goals

- **No UI / dashboard.** Data plane only; consumers build their own UIs. pg-boss now ships its own dashboard — we don't compete.
- **No HTTP/REST layer.** JS API only.
- **No fork of pg-boss.** Use it as a dependency, don't patch its source.
- **Don't replace pg-boss queue ops** (`send` / `fetch` / `complete` / `fail` / `work` / `touch`). Extend, never replace.
- **Don't add scheduling.** pg-boss handles cron / scheduled jobs.
- **Not a workflow engine.** No DAGs, fan-out/fan-in primitives.
- **Not a queue runtime mutator (in v1).** No pause/resume, no force-delete, no concurrency control mid-flight. Pause/resume reserved for a possible v0.2 if descent-app's Space-Track rate-limiting concretely surfaces the need.
- **Not an observability platform.** OpenTelemetry exporters are the consumer's responsibility, built on top of Goal 7's event substrate.
- **Not a testing harness.** pg-boss ships its own testability hooks.
- **Not introspecting handler behavior.** Goal 4's input-snapshot slot is for _consumer-supplied_ data only.
- **Don't become an ORM.** Should work alongside Prisma without depending on it.
- **No bounded retention tooling.** pg-bossier writes to its audit table forever; retention is consumer-owned.
- **Symmetric drop-in.** Adding pg-bossier = one dependency + one migration. Removing it = `DROP SCHEMA pgbossier CASCADE` + uninstall the package.
- **No upstream PR campaign.** We're not trying to land these features in pg-boss itself.

### Constraints (load-bearing rules every implementation must respect)

- **Audit writes are fail-open.** pg-bossier failures never block pg-boss operations. Default: log and continue.
- **Per-event overhead has a published budget.** Decided in the cross-cutting performance-budget sub-issue. Exceeding the budget blocks release.
- **API-shape principle: composition, not replacement.** Read methods (Goal 5) are always new pg-bossier methods, not overloads of pg-boss methods. Write extensions (Goals 2, 4, 6) prototype both (a) overload pg-boss method via new options and (b) new sibling pg-bossier method, then document the trade-off and pick one per feature.

## pg-boss compatibility contract

Goal 8 from issue #1 names _which_ pg-boss surfaces we depend on, and under what stability assumption. "Stay close to pg-boss" is meaningless without naming the parts:

- **Stable (we depend, treat as contract).** pg-boss's documented public JS API — the methods consumers already call (`send`, `fetch`, `complete`, `fail`, `work`, `touch`, etc.). Upstream breakage here is a major-version concern, both for pg-boss and by extension for us.
- **Transitional (we depend, tested per supported pg-boss version).** Reads against the `pgboss.job` table (pg-boss 12 has no `archive` table — job rows are deleted in place by `deletion_seconds`). Tracked in the CI matrix; expect to update bindings on pg-boss minor bumps without that itself being a pg-bossier breaking change.
- **Forbidden (never depend on).** pg-boss internals — private SQL, helper modules, undocumented events, any `node_modules/pg-boss/src/*` reach-ins. If an implementation feels like it needs one of these, that's the signal to either find a public-API path or open an issue questioning the requirement.

When adding a feature, name explicitly which tier each pg-boss surface used falls into. If a surface doesn't fit Stable or Transitional, it's Forbidden — no exceptions inside an implementation PR.

## Primary consumer (v1 design target)

**[descent-app](https://github.com/drunikbe/descent-app)** is what v1 is shaped around. It:

- Runs pg-boss in production
- Uses Prisma
- Has ~45 raw SQL queries against `pgboss.job` today ([descent-app#343](https://github.com/drunikbe/descent-app/issues/343))
- Needs forensic job lookup ("what happened to job X six months ago?")
- Has a Space-Track integration with external rate limits — the canonical v0.2 hook for revisiting queue pause/resume if/when that surfaces as a real need

Optimize for this shape first. Generalization to broader OSS consumers is a post-v1 concern. When weighing an API choice, the useful question is: **"does this make descent-app's `src/lib/jobs/queries.js` cleaner?"**

## Success criteria (from issue #1)

1. descent-app's raw-SQL count against `pgboss.*` drops to zero (or to a documented short list with stated reasons).
2. "What happened to job X six months ago?" is answerable with one typed query — including inputs, final output, failure class, and full retry history — even after pg-boss has deleted the job row from `pgboss.job`.
3. Consumers wire to job events, not timers. No production consumer of pg-bossier runs a polling loop against the query API to detect state changes.
4. Adoption on an existing pg-boss install takes under an hour: install package, run one migration, swap imports where extended APIs are needed.
5. pg-boss minor releases are supported within ~2 weeks of upstream publication, verified by a passing CI matrix.

## What's deliberately undecided

Each decision below is its own GitHub issue. Sub-issues opened during the issue #1 refinement. **Goal 1's issue ([#2](https://github.com/elfensky/pg-bossier/issues/2)) is closed — delivered by the storage substrate;** the rest were re-scoped on 2026-05-21 to reflect what the substrate settled. Goal 5's operational read API has since merged (PR #17) and its issue [#6](https://github.com/elfensky/pg-bossier/issues/6) is closed; Goal 6's persistent progress API has merged (`a7a8074`) and its issue [#7](https://github.com/elfensky/pg-bossier/issues/7) is closed; Goal 7's lifecycle event API has merged and its issue [#8](https://github.com/elfensky/pg-bossier/issues/8) is closed; Goal 8's compat-doc tightening has merged (PR #20 / `5b2a3d0`) and its issue [#9](https://github.com/elfensky/pg-bossier/issues/9) is closed (correctness-assertions follow-up [#19](https://github.com/elfensky/pg-bossier/issues/19) open); the cross-cutting performance budget (#12) has merged via PR #22 (`1c71721`) with the scale-extensions/CI-integration follow-up [#21](https://github.com/elfensky/pg-bossier/issues/21) open; the remaining goal issues stay open.

**Goal implementation issues (one per goal):**

| Sub-issue                                                                            | Goal   |
| ------------------------------------------------------------------------------------- | ------ |
| ✅ Forensic audit table — schema, capture mechanism, write semantics _(done — #2 closed)_ | Goal 1 |
| Terminal-state detail — discriminated-union shape, worker signaling, `class` mandate   | Goal 2 |
| Retry history columns — parent/successor links, supersession semantics                | Goal 3 |
| Input-snapshot slot — opt-in JSONB column, consumer-defined shape                      | Goal 4 |
| ✅ New APIs — operational read method signatures, TS generics surface _(read API merged — PR #17; #6 closed)_ | Goal 5 |
| ✅ Persistent progress API — `setProgress` / `getProgress`, retry-resume semantics _(done — merged `a7a8074`; #7 closed)_ | Goal 6 |
| ✅ Lifecycle event API — `subscribe()` + typed `BossierEvents` with six event types plus catch-all / connected / warning / discriminated error; `getEventsSince(seq)` catch-up read; monotonic `seq` column on `pgbossier.record`. _(done — issue #8 closed)_ | Goal 7 |
| ✅ pg-boss compatibility tier doc + decision against a matrix _(done — #9 closed; correctness-assertions follow-up #19 opened)_ | Goal 8 |
| Install/uninstall surface — migration tooling, distribution shape                      | Goal 9 |

**Cross-cutting issues:**

| Sub-issue                                                    | Reason                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| Backfill strategy for existing installs                      | Affects Goal 1 implementation                 |
| ✅ Performance budget — first measurement + per-method published budgets _(done — #12 closed via PR #22; scale extensions / CI integration / violation policy follow-up #21 open)_ | Gives Goal 8's "stay close" enforceable teeth |
| TypeScript generics surface — `Job<TInput, TOutput>` pattern | Most affects Goal 5; also Goal 6/7            |

If a task touches one of these and there's no companion issue, open one (or ask the user to) before writing code.

## Versioning and changelog

- **Semantic Versioning** ([semver.org](https://semver.org/spec/v2.0.0/)) for releases. While on `0.x.y` the API is unstable — anything may break between minors. Promote to `1.0.0` only when the API surface is committed.
- **Keep a Changelog** ([keepachangelog.com](https://keepachangelog.com/en/1.1.0/)) format in `CHANGELOG.md`. Every feature branch with user-visible changes adds an entry under `## [Unreleased]` (on `develop`) using the standard sections (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`).
- **Version bump happens at release, not at feature merge.** Feature branches merge into `develop` *without* touching the version. When a release is cut — the squash of `develop` onto `main`, see § Branching — that single release commit bumps `package.json` + `package-lock.json` and renames `[Unreleased]` to the dated version section, opening a fresh `[Unreleased]`.
- The `version` in `package.json` and the latest dated section in `CHANGELOG.md` must agree.

## Branching, worktrees, and Git workflow

Two long-lived branches:

- **`develop`** — the integration branch, and the repo's default branch. Full commit history; all day-to-day work happens here.
- **`main`** — the release ledger. One commit per release, each a squashed snapshot of `develop` at release time. `main` receives nothing else (except hotfixes) — never a direct commit. It is intentionally empty until the first release.

**What needs a feature branch:** large features go through a worktree → branch → `--no-ff` merge into `develop`. Bugfixes, chores, refactors, and docs may be committed directly to `develop` — no worktree, no branch. When in doubt, or when a change wants isolation and incremental review, use a branch.

**Feature workflow (worktree per branch)** — for large features:

1. Create the worktree off `develop` (run from the main checkout):
   `git worktree add .worktrees/<branch-dir> -b <branch-name> develop`
2. `cd` into the worktree and install: `npm install`
3. Do the work in the worktree directory — small, logical commits as you go (schema → impl → wire-up → tests), not one giant commit at the end
4. Verify in the worktree before merging back: `npm run lint && npm run build && npm test`
5. Merge into `develop` (from a `develop` checkout): `git merge --no-ff <branch-name>`. No version bump here.
6. Make sure the change has a `CHANGELOG.md` entry under `## [Unreleased]` — see § Versioning and changelog.
7. Push: `git push origin develop`
8. Clean up: `git worktree remove .worktrees/<branch-dir>` + `git branch -d <branch-name>`

**Release workflow (`develop` → `main`):**

A release is a single squashed commit on `main` that snapshots `develop`:

1. Snapshot `develop`'s tree onto `main` — a tree snapshot, **not** `git merge --squash`. `main` and `develop` have unrelated histories by design, so a real merge would conflict; the release takes `develop`'s tree wholesale.
2. In that same release commit: bump `package.json` + `package-lock.json` (minor for features, patch for fixes), and rename `CHANGELOG.md`'s `[Unreleased]` to the dated version section, opening a fresh `[Unreleased]` back on `develop`.
3. Commit on `main` as `Release X.Y.Z`; push `main`.
4. `main` and `develop` diverge in the commit graph by design — the version number and `CHANGELOG.md` are the link between them, not git ancestry.

**Hotfixes:** branch from `main`, fix, land on `main` as a patch release commit, then port the fix to `develop` (cherry-pick).

**Worktree directory:** `.worktrees/` in project root (gitignored). Directory names mirror the branch name with slashes replaced by hyphens.

**Commit and merge rules:**

- **Feature → `develop` merges are `--no-ff`, never squashed.** `develop` preserves the full commit history.
- **`develop` → `main` releases are squashed** — one commit per release. This is the *only* place squashing is used.
- **No `--rebase` merges** into `develop` — preserve the branch shape.
- **Commit incrementally on feature branches.** Each commit should be a coherent unit of progress that a reviewer (or a future you) can read independently.

## Language

**TypeScript with `strict` mode**, ESM output, `.d.ts` declarations shipped. This is a deliberate choice rather than a default, and the reasoning matters because TypeScript wouldn't be an obvious pick for every project:

- **Goal 5 from issue #1 makes the language choice load-bearing, not stylistic.** A typed query API isn't a preference — it's a stated success criterion. The primary consumer (descent-app, Prisma) expects autocomplete on job payloads and generics like `Job<TInput, TOutput>` for forensic queries. Shipping that surface from plain JS would require either drift-prone hand-maintained `.d.ts` files or JSDoc + `// @ts-check` (which gets awkward for library generics and still needs TS tooling to verify).
- **Libraries have the inverse TS cost/benefit profile of applications.** A library has a small, slowly-changing public API consumed by many callers — types pay off N times per change. Application code has a sprawling, fast-changing internal surface consumed once. "Avoid TS by default" is a defensible stance for apps; pg-bossier sits on the opposite end of that curve.
- **`noUncheckedIndexedAccess: true`** is enabled on top of `strict`. Query-result handling and `pgboss.job.output` JSONB access are exactly the patterns where forcing `T | undefined` on indexed lookups catches real bugs.
- **ESM** (`"type": "module"`, `module: "NodeNext"`) is the right 2026 default for a new library targeting Node 18+ and a Prisma-using consumer base. CJS-only would create import friction for the v1 consumer.
- **`declaration: true`** so `.d.ts` ships alongside `.js` in `dist/` — consumers don't need (and we don't have to maintain) a separate `@types/pg-bossier` package.
- **`tsc` only, no bundler.** Bundler choice (tsup / unbuild / rollup, dual ESM+CJS publish, treeshaking) is a real decision and is deferred per issue #1's "distribution shape" row until there's code to ship that actually motivates one.

Source lives in `src/`, compiles to `dist/`. Run `npm run build` to compile.

## Linting

**ESLint flat config with `typescript-eslint` (`recommended-type-checked` + `stylistic-type-checked`).** Like the TypeScript choice, this isn't default tooling — it's load-bearing for what this project promises:

- **`@typescript-eslint/no-floating-promises`** and **`no-misused-promises`** catch forgotten `await` on async calls (`recordEvent`, `persistProgress`, anything wrapping pg-boss). `tsc` cannot see these — they compile clean and fail silently in production. For a library whose value proposition is "consumers can trust the API," a floating-promise hole is self-defeating.
- **`consistent-type-imports`** matters because under `module: NodeNext` + ESM, mixed type and value imports can produce real runtime errors (a value-import of something type-only fails at module load). `tsc` only catches this under specific settings; ESLint enforces it uniformly.
- **Flat config** (`eslint.config.js`) is the only supported ESLint config format in ESLint 10+.
- **`projectService: true`** for tsconfig auto-discovery — the modern typescript-eslint setup that replaces the legacy `project: './tsconfig.json'` form.
- Type-checked lint is slower than syntax-only lint, but the cost is negligible at library scale.

Run `npm run lint` to check, `npm run lint:fix` to auto-fix.

Formatter (Prettier or alternative) is deferred — that's a separate decision worth having once there's real code to argue over.

## Build / test / run

- **Install:** `npm install`
- **Lint:** `npm run lint` — ESLint flat config (auto-fix: `npm run lint:fix`)
- **Build:** `npm run build` — `tsc` emits to `dist/` (gitignored)
- **Test:** `npm test` — runs `vitest run`. Integration tests live under `test/`, exercised against real Postgres + pg-boss via `@testcontainers/postgresql` (Docker required, no mocks). `vitest.config.ts` sets `fileParallelism: false` — one container per test file.
- **CI:** `.github/workflows/ci.yml` runs `npm ci` → lint → build → test on every push to `develop` or `main` and every pull request (`ubuntu-latest`, Node 22). The testcontainers suite runs on the runner's own Docker — no `services:` block. One Node / one pg-boss version for now; the pg-boss version matrix is tracked in issue #9.

**Verify before claiming done.** Run `npm run lint && npm run build && npm test` before reporting a task complete. Order mirrors the CI workflow's fail-fast order: cheap checks first. If anything fails, report the actual output — don't suppress, don't simplify, don't claim success.

## File guidelines

- When reading files over 500 lines, use `Read`'s `offset` and `limit` to read in chunks. Don't assume a single read captured the whole file.
- When renaming or changing a function / type / variable, search for: direct calls, type references, string literals containing the name, re-exports, barrel files, and test mocks. One grep is not enough.
- Prefer files under 500–800 LOC; split files over 1000 LOC before making major changes.
- Prefer functions under 100 lines; refactor functions over 200 lines before modifying.
- Prioritize cohesion (one responsibility per file), clear boundaries, and readability over compactness.

## Related links

- [pg-boss](https://github.com/timgit/pg-boss) — the upstream queue library this project wraps
- [pg-boss#35](https://github.com/timgit/pg-boss/issues/35), [#174](https://github.com/timgit/pg-boss/issues/174), [#516](https://github.com/timgit/pg-boss/issues/516), [#570](https://github.com/timgit/pg-boss/issues/570) — declined upstream requests that motivate pg-bossier (progress, batch progress, failure classification, lifecycle events)
- [pg-boss#427](https://github.com/timgit/pg-boss/issues/427), [#551](https://github.com/timgit/pg-boss/issues/551), [#659](https://github.com/timgit/pg-boss/issues/659), [#745](https://github.com/timgit/pg-boss/issues/745) — popular pg-boss requests pg-bossier explicitly does **not** address (sub-minute schedules, pause/resume, workflows)
- [descent-app#342](https://github.com/drunikbe/descent-app/issues/342) — current JobProgress fallback approach in the consumer
- [descent-app#343](https://github.com/drunikbe/descent-app/issues/343) — descent-app tracking issue for raw-SQL removal

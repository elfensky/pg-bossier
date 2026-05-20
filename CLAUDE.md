# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-implementation.** Tooling is in place (`package.json`, TypeScript with `tsc`, ESM, `CHANGELOG.md`) but no feature code has shipped — `src/index.ts` is a placeholder. Don't invent architecture answers; check open issues first and ask if a decision hasn't been made.

The canonical scope document is **[issue #1](https://github.com/elfensky/pg-bossier/issues/1)** ("Requirements: what pg-bossier should achieve"). Treat it as the rubric — any feature, refactor, or design choice must be justifiable against the goals and non-goals it lists. Issue #1 itself explicitly notes: "Anything not explicitly in scope is out — feature requests outside this boundary get closed with a reference to this issue."

## Critical rules

- **KISS.** Simple solutions only. Don't overengineer. Don't add abstractions for hypothetical future needs. Three similar lines beats a premature abstraction. When in doubt about an open question, default to the simpler choice and surface the tradeoff rather than silently picking a clever one.
- **Report outcomes faithfully.** If lint, build, or tests fail, say so with the actual output. If you didn't run a verification step, say so — don't imply it ran. Never claim "all checks pass" when output shows failures. Never suppress or simplify failing checks to manufacture a green result. Never characterize incomplete or broken work as done.
- **Keep docs in sync with code.** When a change affects `CLAUDE.md`, `CHANGELOG.md`, or an open issue, update the doc in the same change — not a separate follow-up. Stale docs are worse than no docs.
- **Never push directly to `main`** (after the initial scaffolding commit). Feature work goes through a worktree → branch → merge, even for small changes. Exceptions are user-explicit only. See § Branching, worktrees, and Git workflow.

## What pg-bossier is

A **JS/TS library that layers on top of [pg-boss](https://github.com/timgit/pg-boss)** to provide an **operational data plane** — capabilities pg-boss has explicitly declined to take on. Nine concrete goals:

1. **Permanent job history.** `pgbossier.job_audit` populated automatically, surviving pg-boss's in-place row deletion (the `deletion_seconds` `DELETE` and the retry `DELETE`+`INSERT`).
2. **Typed terminal-state detail.** `terminal_state` (pg-boss's three terminal values — `completed` / `cancelled` / `failed`) + `terminal_detail` (JSONB discriminated by state; `class` mandated when `failed`; `expired` / `superseded` are pg-bossier-derived markers, not pg-boss states). One typed read answers "why did this fail?" without string-matching error text.
3. **Retry history tracking.** A job keeps one stable `id` across all retries (pg-boss reuses it through the retry `DELETE`+`INSERT`); each attempt is a preserved row-version. `getRetryHistory(jobId)` returns the ordered attempt sequence — no link columns.
4. **Optional input-snapshot capture.** Opt-in JSONB slot for consumer-supplied "what data did this job see" manifests. Pg-bossier preserves; consumers define shape.
5. **New APIs.** Operational read methods (`peek` / `findById` / `listActive` / `listStalled` / `getRetryHistory` / `getActiveWorkers` / state-counts). pg-boss 12 partially covers some (`findJobs` / `getQueueStats` / `getWipData`) — the Goal 5 sub-issue names each method's differentiator. Write extensions for Goals 2/4/6 are deferred per-feature per the API-shape principle.
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
2. "What happened to job X six months ago?" is answerable with one typed query — including inputs, final output, failure class, full retry history, and worker context — even after pg-boss has deleted the job row from `pgboss.job`.
3. Consumers wire to job events, not timers. No production consumer of pg-bossier runs a polling loop against the query API to detect state changes.
4. Adoption on an existing pg-boss install takes under an hour: install package, run one migration, swap imports where extended APIs are needed.
5. pg-boss minor releases are supported within ~2 weeks of upstream publication, verified by a passing CI matrix.

## What's deliberately undecided

Each decision below is its own GitHub issue. Sub-issues opened during the issue #1 refinement:

**Goal implementation issues (one per goal):**

| Sub-issue                                                                            | Goal   |
| ------------------------------------------------------------------------------------- | ------ |
| Forensic audit table — schema, capture mechanism, write semantics                     | Goal 1 |
| Terminal-state detail — discriminated-union shape, worker signaling, `class` mandate   | Goal 2 |
| Retry history columns — parent/successor links, supersession semantics                | Goal 3 |
| Input-snapshot slot — opt-in JSONB column, consumer-defined shape                      | Goal 4 |
| New APIs — operational read method signatures, TS generics surface                    | Goal 5 |
| Persistent progress API — storage location, retry-survival semantics                  | Goal 6 |
| Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY), payload schema             | Goal 7 |
| pg-boss compatibility tier doc + CI matrix definition                                 | Goal 8 |
| Install/uninstall surface — migration tooling, distribution shape                      | Goal 9 |

**Cross-cutting issues:**

| Sub-issue                                                    | Reason                                        |
| ------------------------------------------------------------ | --------------------------------------------- |
| Backfill strategy for existing installs                      | Affects Goal 1 implementation                 |
| Performance budget — numeric per-event overhead target       | Gives Goal 8's "stay close" enforceable teeth |
| TypeScript generics surface — `Job<TInput, TOutput>` pattern | Most affects Goal 5; also Goal 6/7            |

If a task touches one of these and there's no companion issue, open one (or ask the user to) before writing code.

## Versioning and changelog

- **Semantic Versioning** ([semver.org](https://semver.org/spec/v2.0.0/)) for releases. While on `0.x.y` the API is unstable — anything may break between minors. Promote to `1.0.0` only when the API surface is committed.
- **Keep a Changelog** ([keepachangelog.com](https://keepachangelog.com/en/1.1.0/)) format in `CHANGELOG.md`. Every PR with user-visible changes adds an entry under `## [Unreleased]` using the standard sections (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`). Releases rename `[Unreleased]` to the dated version section and open a fresh `[Unreleased]`.
- The `version` in `package.json` and the latest dated section in `CHANGELOG.md` must agree.

## Branching, worktrees, and Git workflow

Single-trunk model: `main` is the release branch (what gets published to npm). All other work lives on short-lived branches checked out via worktree. If/when the project grows into needing a separate integration branch (`develop`), we'll add it — for now KISS.

**Default workflow (worktree per branch):**

1. Create the worktree off `main` (run from the main checkout):
   `git worktree add .worktrees/<branch-dir> -b <branch-name>`
2. `cd` into the worktree and install: `npm install`
3. Do the work in the worktree directory — small, logical commits as you go (schema → impl → wire-up → tests), not one giant commit at the end
4. Verify in the worktree before merging back: `npm run lint && npm run build` (and tests once they exist)
5. From the main checkout: `git checkout main && git merge --no-ff <branch-name>`
6. **Version-on-merge.** Bump `package.json` version (minor for features, patch for fixes/refactors) and add the `CHANGELOG.md` entry in the **same commit as the code change** (or amend into the merge commit). Not a separate chore commit. The package.json↔CHANGELOG agreement rule from § Versioning and changelog still applies.
7. Push: `git push`
8. Clean up: `git worktree remove .worktrees/<branch-dir>` + `git branch -d <branch-name>`

**Worktree directory:** `.worktrees/` in project root (gitignored). Directory names mirror the branch name with slashes replaced by hyphens.

**Commit and merge rules:**

- **Never squash.** Always `--no-ff` or plain `--merge`. Full commit history must be preserved.
- **No `--rebase` merges** for the same reason — preserve the branch shape.
- **Commit incrementally on feature branches.** Each commit should be a coherent unit of progress that a reviewer (or a future you) can read independently.

**Exception (direct-on-main):** Only when the user explicitly asks ("just do this quickly on main", "skip the worktree"). Realistic cases: docs-only updates, the initial scaffolding. If in doubt, use a worktree.

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
- **Test:** not yet established — runner choice (vitest / node:test / jest) is deferred until first feature lands

**Verify before claiming done.** Run `npm run lint && npm run build` (and tests once they exist) before reporting a task complete. Order mirrors a CI fail-fast pipeline: cheap checks first. If anything fails, report the actual output — don't suppress, don't simplify, don't claim success.

Update this section when test tooling is added.

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

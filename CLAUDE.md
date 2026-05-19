# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-implementation.** Tooling is in place (`package.json`, TypeScript with `tsc`, ESM, `CHANGELOG.md`) but no feature code has shipped — `src/index.ts` is a placeholder. Don't invent architecture answers; check open issues first and ask if a decision hasn't been made.

The canonical scope document is **[issue #1](https://github.com/elfensky/pg-bossier/issues/1)** ("Requirements: what pg-bossier should achieve"). Treat it as the rubric — any feature, refactor, or design choice must be justifiable against the goals and non-goals it lists. Issue #1 itself explicitly notes: "Anything not explicitly in scope is out — feature requests outside this boundary get closed with a reference to this issue."

## What pg-bossier is

A **JS/TS library that layers on top of [pg-boss](https://github.com/timgit/pg-boss)** to provide an **operational data plane** — capabilities pg-boss has explicitly declined to take on:

- **Forensic preservation with lineage and failure classification.** Every job preserved forever (surviving pg-boss's archive→delete cleanup), with typed failure semantics (transient / non-retryable / cancelled / expired / superseded) and explicit lineage links between retries, reschedules, and singleton supersessions. "Why did job X produce result Y?" answerable with one typed query, not by string-matching error text.
- **Operational query API.** Live and historical reads through typed methods — not just status counts, but operational shapes like `peek` / `findById` / `listActive` / `listStalled` / `getAttemptChain` / `getActiveWorkers`. Consumers never drop to `$queryRaw` for debugging or operations.
- **Mid-flight progress that survives retries.** Long-running jobs persist progress (not just emit it) so it survives worker crashes and pg-boss's DELETE+re-INSERT retry path.
- **Reactive surface.** Every job state transition lands as a queryable row *and* is published to an in-process emitter. Consumers wire to events, not 5-second polling loops. Same substrate is what consumer-owned OpenTelemetry exporters build on (we don't ship those).

pg-boss stays an **unmodified npm dependency** — pg-bossier extends it, never replaces it.

## Non-negotiable boundaries

From issue #1. These are not up for casual revisiting inside an implementation PR — if a task feels like it crosses one of these lines, surface that explicitly:

- **No UI / dashboard.** Data plane only; consumers build their own UIs. pg-boss now ships its own dashboard — we don't compete.
- **No HTTP/REST layer.** JS API only.
- **No fork of pg-boss.** Use it as a dependency, don't patch its source.
- **Don't replace pg-boss queue ops** (`send` / `fetch` / `complete` / `fail` / `work` / `touch`). Extend, never replace.
- **Don't add scheduling.** pg-boss handles cron / scheduled jobs. Sub-minute scheduling ([pg-boss#427](https://github.com/timgit/pg-boss/issues/427)) stays a pg-boss concern.
- **Not a workflow engine.** No job dependencies, no DAGs, no fan-out/fan-in primitives ([pg-boss#745](https://github.com/timgit/pg-boss/issues/745)). That's Inngest / Temporal / BullMQ-Flow territory.
- **Not a queue runtime mutator (in v1).** No pause/resume, no force-delete, no concurrency control mid-flight ([pg-boss#551](https://github.com/timgit/pg-boss/issues/551), [#659](https://github.com/timgit/pg-boss/issues/659)). Pause/resume is reserved for a possible v0.2 revisit if a concrete consumer scenario materializes (descent-app's Space-Track rate-limiting is the candidate trigger).
- **Not an observability platform.** OpenTelemetry exporters are the consumer's responsibility, built on top of the Goal 6 event substrate. We don't ship spans, metrics, or exporters.
- **Not a testing harness.** pg-boss ships its own testability hooks ([pg-boss#643](https://github.com/timgit/pg-boss/issues/643)); we don't reimplement them.
- **Don't become an ORM.** Should work alongside Prisma without depending on it.
- **Symmetric drop-in.** Adding pg-bossier = one dependency + one migration. Removing it = `DROP SCHEMA pgbossier CASCADE` + uninstall the package. No orphaned tables, no halfway-removed state.
- **No upstream PR campaign.** We're not trying to land these features in pg-boss itself.

## pg-boss compatibility contract

Goal 4 from issue #1 names *which* pg-boss surfaces we depend on, and under what stability assumption. "Stay close to pg-boss" is meaningless without naming the parts:

- **Stable (we depend, treat as contract).** pg-boss's documented public JS API — the methods consumers already call (`send`, `fetch`, `complete`, `fail`, `work`, `touch`, etc.). Upstream breakage here is a major-version concern, both for pg-boss and by extension for us.
- **Transitional (we depend, tested per supported pg-boss version).** Reads against `pgboss.job` and `pgboss.archive` schemas. Tracked in the CI matrix; expect to update bindings on pg-boss minor bumps without that itself being a pg-bossier breaking change.
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
2. "What happened to job X six months ago?" is answerable with one typed query — including inputs, final output, failure class, full retry chain, and worker context — even after pg-boss has deleted the job from its own archive.
3. Consumers wire to job events, not timers. No production consumer of pg-bossier runs a polling loop against the query API to detect state changes.
4. Adoption on an existing pg-boss install takes under an hour: install package, run one migration, swap imports where extended APIs are needed.
5. pg-boss minor releases are supported within ~2 weeks of upstream publication, verified by a passing CI matrix.

## What's deliberately undecided

Issue #1 explicitly defers the following — each must be opened as its own issue **before** implementation, not chosen ad-hoc inside another PR:

| Decision | Status |
|---|---|
| Strategic approach (fork vs layer vs upstream) | Deferred to a separate issue |
| Method signatures for query / progress / audit / events | Per-requirement issue |
| Audit capture mechanism (Postgres trigger vs app hook vs both) | Per-requirement issue (Goal 1) |
| Audit table schema, retention semantics, lineage fields | Per-requirement issue (Goal 1) |
| Failure classification taxonomy (exact enum values, how workers signal them) | Per-requirement issue (Goal 1) |
| Operational read API shapes (`peek` / `findById` / `listActive` / `listStalled` / `getAttemptChain` / `getActiveWorkers`) | Per-requirement issue (Goal 2) |
| Progress storage location (`pgboss.job.output` vs sidecar table) | Per-requirement issue (Goal 3) |
| Retry-resume semantics, `previousOutput`, opt-in flags | Per-requirement issue (Goal 3) |
| pg-boss / Postgres version matrix; exact stable/transitional/forbidden surface lists | Per-requirement issue (Goal 4) |
| Distribution shape (single package, monorepo, separate Prisma adapter) | Per-requirement issue (Goal 5) |
| Reactive surface mechanism (in-process `EventEmitter` vs Postgres `LISTEN/NOTIFY` vs both) | Per-requirement issue (Goal 6) |
| Event schema (what events fire, what payload, persisted vs ephemeral) | Per-requirement issue (Goal 6) |
| Test coverage targets, performance budgets | Operational, follows from success criteria |

If a task touches one of these and there's no companion issue, open one (or ask the user to) before writing code.

## Versioning and changelog

- **Semantic Versioning** ([semver.org](https://semver.org/spec/v2.0.0/)) for releases. While on `0.x.y` the API is unstable — anything may break between minors. Promote to `1.0.0` only when the API surface is committed.
- **Keep a Changelog** ([keepachangelog.com](https://keepachangelog.com/en/1.1.0/)) format in `CHANGELOG.md`. Every PR with user-visible changes adds an entry under `## [Unreleased]` using the standard sections (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`). Releases rename `[Unreleased]` to the dated version section and open a fresh `[Unreleased]`.
- The `version` in `package.json` and the latest dated section in `CHANGELOG.md` must agree.

## Language

**TypeScript with `strict` mode**, ESM output, `.d.ts` declarations shipped. This is a deliberate choice rather than a default, and the reasoning matters because TypeScript wouldn't be an obvious pick for every project:

- **Goal #2 from issue #1 makes the language choice load-bearing, not stylistic.** "Typed query API" isn't a preference — it's a stated success criterion. The primary consumer (descent-app, Prisma) expects autocomplete on job payloads and generics like `Job<TInput, TOutput>` for forensic queries. Shipping that surface from plain JS would require either drift-prone hand-maintained `.d.ts` files or JSDoc + `// @ts-check` (which gets awkward for library generics and still needs TS tooling to verify).
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
- **Build:** `npm run build` — runs `tsc`, emits to `dist/` (gitignored)
- **Test:** not yet established — test-runner choice (vitest / node:test / jest) is deferred until first feature lands

Update this section when test tooling is added.

## Related links

- [pg-boss](https://github.com/timgit/pg-boss) — the upstream queue library this project wraps
- [pg-boss#35](https://github.com/timgit/pg-boss/issues/35), [#174](https://github.com/timgit/pg-boss/issues/174), [#516](https://github.com/timgit/pg-boss/issues/516), [#570](https://github.com/timgit/pg-boss/issues/570) — declined upstream requests that motivate pg-bossier (progress, batch progress, failure classification, lifecycle events)
- [pg-boss#427](https://github.com/timgit/pg-boss/issues/427), [#551](https://github.com/timgit/pg-boss/issues/551), [#659](https://github.com/timgit/pg-boss/issues/659), [#745](https://github.com/timgit/pg-boss/issues/745) — popular pg-boss requests pg-bossier explicitly does **not** address (sub-minute schedules, pause/resume, workflows)
- [descent-app#342](https://github.com/drunikbe/descent-app/issues/342) — current JobProgress fallback approach in the consumer
- [descent-app#343](https://github.com/drunikbe/descent-app/issues/343) — descent-app tracking issue for raw-SQL removal

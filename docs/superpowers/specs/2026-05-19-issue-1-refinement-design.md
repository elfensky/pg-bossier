# Issue #1 Refinement — Design

- **Status:** Approved direction, awaiting spec review before implementation plan
- **Date:** 2026-05-19
- **Author:** elfensky, with claude-code (brainstorming)
- **Target:** [elfensky/pg-bossier#1](https://github.com/elfensky/pg-bossier/issues/1)

## Context

Issue #1 is pg-bossier's scope document — the rubric every implementation issue is supposed to be evaluated against. It exists, has no comments yet, and reads well as a thinking artifact. Four problems make it less useful than it could be as a rubric:

1. **Framing inversions.** Several goals name a benefit ("no raw SQL in consumers") rather than the capability we ship to produce that benefit ("typed job query API"). Benefit-titled goals are untestable as "done?" — you can only test the capability and measure whether the benefit followed.
2. **Bundled goals.** Goal 1 ("Operational data plane") is actually three independently-shippable capabilities — audit table, failure classification, lineage tracking — collapsed into one item. Bundling forces reviewers to evaluate three orthogonal design decisions at once.
3. **Missing constraints.** Several load-bearing decisions are absent from issue #1 today: audit-write transaction semantics, per-event overhead budget, error-policy on pg-bossier failure, retention strategy. Without these in scope, every implementation issue ends up re-litigating them.
4. **Heavy language.** Phrases like "operational data plane", "forensic preservation", "substrate", "symmetric drop-in" are accurate but raise the cost of reading. Lighter equivalents preserve precision without the jargon tax.

This design proposes a refined structure for issue #1 and an 11-issue sub-issue split. The refined issue #1 stays a charter — it decides scope, not implementation.

## Diagnostic

### Framing inversions

| Current goal | What it is | Real *requirement* (capability shipped) | Real *benefit* (outcome) |
|---|---|---|---|
| 1. "Operational data plane" | Vague benefit + bundle | Audit table + failure-class enum + lineage links | "What happened to job X?" answerable forever |
| 2. "No raw SQL in consumers" | Negative outcome | Typed query API (`peek` / `findById` / `listActive` / `listStalled` / `getAttemptChain` / `getActiveWorkers` / state-counts) | No `$queryRaw` against `pgboss.*` |
| 3. "Mid-flight visibility" | Benefit | Persistent progress API surviving DELETE+re-INSERT | Long-running progress survives crashes & retries |
| 4. "Stay close to pg-boss" | Delivery promise | Surface tier classification (Stable/Transitional/Forbidden) + CI matrix | pg-boss minors absorbable in ~2 weeks |
| 5. "Drop-in adoption" | Benefit | Single package + single migration + isolated schema + clean uninstall | <1hr adoption; clean removal |
| 6. "Reactive surface" | Abstract jargon | Lifecycle event API backed by audit table | Consumers stop polling |

### Goal 1 bundling

"Operational data plane" contains three orthogonal capabilities:

- **1a. Forensic audit table.** `pgbossier.job_audit` populated on every pg-boss state change, surviving the archive→delete cleanup.
- **1b. Failure classification.** Typed enum (`transient` / `non_retryable` / `cancelled` / `expired` / `superseded`).
- **1c. Lineage tracking.** Parent/successor links across retries, reschedules, supersession.

These ship along different axes (preservation, capture-shape, lineage), so each is independently valuable — a consumer can adopt just the capture-shape convention without the audit substrate, and vice versa. Splitting them lets each ship as a discrete increment.

### The 5-value enum conflates two axes

The current issue #1's failure classification enum (`transient` / `non_retryable` / `cancelled` / `expired` / `superseded`) bundles two orthogonal concerns into one flat list:

- **pg-boss-owned terminal states**: `cancelled`, `expired`, `superseded` — these are *what kind of outcome happened*. pg-boss already distinguishes them at the state-machine level.
- **pg-bossier-added failure sub-classification**: `transient`, `non_retryable` — these are only meaningful *when terminal_state is `failed`*. They're the retry-class signal pg-boss#516 asks for.

The refinement decomposes the conflation: `terminal_state` (column, pg-boss-owned values: `completed` / `failed` / `cancelled` / `expired` / `superseded`) + `terminal_detail` (JSONB, discriminated-union shape varying by state; includes the failure `class` field when state=`failed`). See Goal 2.

### Missing functionality

Items absent from issue #1 today, in three buckets:

**Belongs in issue #1 as load-bearing constraints/non-goals:**

- **Audit-write transaction semantics.** Pg-bossier audit writes are best-effort and never block a pg-boss operation. Default to fail-open.
- **Per-event overhead budget.** Numeric target (TBD in its own issue) — without it, "stay close to pg-boss" has no teeth.
- **Bounded retention is a non-goal.** Pg-bossier writes forever. Partitioning, summarization, retention policy are consumer-owned; we document guidance, don't ship tooling.

**Belongs in sub-issues (deferred decisions):**

- Backfill strategy for existing pg-boss installs (capture-from-now vs full backfill vs toggleable)
- TypeScript generics surface — exact `Job<TInput, TOutput>` pattern (registration vs inference vs declaration)
- Audit-schema versioning across pg-bossier major bumps
- Worker identity model (pg-boss internal worker IDs vs OS process vs custom registration)
- Read-side connection pooling (reuse pg-boss pool vs own pool)
- Migration tooling shape (Prisma coexistence, idempotence, re-runnability)
- Cancellation semantics' interaction with failure classification
- Singleton supersession lineage edge cases
- Pg-bossier self-instrumentation (does pg-bossier itself emit logs/spans about its own ops?)
- Job payload size handling (preserve full vs hash + truncate for large payloads)
- Multi-schema / multi-instance pg-boss support

**Belongs nowhere (closed by current scope):**

- *(None identified — everything missing is either in-scope for a sub-issue or is an explicit non-goal candidate.)*

### Language simplification

Substitutions to apply when rewriting:

| Heavy | Lighter |
|---|---|
| "Operational data plane" | "Job history and lookup" |
| "Forensic preservation" | "Permanent job history" |
| "Mid-flight visibility" | "Live progress reporting" |
| "Substrate" | "API" or "foundation" |
| "Surfaces" (pg-boss surfaces) | "APIs and tables" (with one-line definition on first use) |
| "Symmetric drop-in" | "Easy to install, easy to uninstall" |
| "Reactive surface" | "Lifecycle events" |

Keep "lineage" — it's precise and load-bearing. Cut decorative jargon, keep precise jargon.

## Design

### Reframed goal list

Eight goals, each with **what we ship**, **what consumers get**, **what counts as done**.

**Goal 1 — Permanent job history.**

- Ships: `pgbossier.job_audit` table, populated automatically on every pg-boss state change, surviving pg-boss's archive→delete cleanup.
- Benefit: "What happened to job X six months ago?" remains answerable.
- Done when: every in-scope pg-boss state change leaves an audit row; rows are never deleted by pg-boss's cleanup.
- Independent of Goal 2: the audit table preserves whatever data exists at the time of capture, regardless of whether `terminal_detail` follows the shape convention. With Goal 2, the convention is enforced; without Goal 2, `terminal_detail` is free-form.

**Goal 2 — Typed terminal-state detail capture.**

- Ships: at the moment a job reaches a terminal state, structured detail about *why/how* is recorded as a JSONB value whose shape is discriminated by `terminal_state` (`completed` → typically empty; `failed` → `{ class, message?, where?, ... }`; `cancelled` → `{ cancelledBy?, reason? }`; `expired` → `{ deadlineMs?, exceededByMs? }`; `superseded` → `{ supersededByJobId }`). Workers signal at fail/complete time (extension to pg-boss's `fail()` / `complete()` paths, exact shape deferred). For `failed` terminal-state, the `class: 'transient' | 'non_retryable'` field is mandated; pg-bossier rejects writes missing it.
- Benefit: "Why did this job fail?" is one typed read; aggregation queries by failure class are reliable; the retry-class signal pg-boss#516 asks for becomes available to consumers; the `where`/`code`/etc. detail fields stay consumer-defined for domain context.
- Done when: every job reaching a terminal state has a queryable `terminal_detail`; every `failed` row has a valid `class` value; the convention is documented and validated by pg-bossier's API at write time.
- Independent of Goal 1: detail is captured at the moment of state change and stored in pg-boss's natural location (preserved by pg-boss until archive→delete) regardless of whether the forensic audit table (Goal 1) is enabled. With Goal 1 enabled, the same detail is preserved forever in the audit table; without it, the detail follows pg-boss's normal cleanup schedule.

**Goal 3 — Lineage tracking.**

- Ships: parent/successor link columns on audit rows, populated for retries, reschedules, and singleton supersession.
- Benefit: full attempt chain reconstructable from the audit table alone.
- Done when: `getAttemptChain(jobId)` returns the complete chain for any in-scope job.

**Goal 4 — Typed job query API.**

- Ships: TypeScript methods covering the operational reads consumers currently work around with raw SQL — `peek`, `findById`, `listActive`, `listStalled`, `getAttemptChain`, `getActiveWorkers`, state-bucket counts.
- Benefit: consumers stop using `$queryRaw` against `pgboss.*`.
- Done when: descent-app's raw-SQL count against `pgboss.*` drops to zero (or to a documented short list with stated reasons).

**Goal 5 — Persistent job progress.**

- Ships: a progress API that *stores* progress (not just emits it) in a location that survives pg-boss's DELETE+re-INSERT retry path.
- Benefit: long-running progress survives worker crashes and retries.
- Done when: a worker crashing mid-job leaves progress visible to consumers after pg-boss retries.

**Goal 6 — Lifecycle event API.**

- Ships: in-process emitter and/or Postgres `LISTEN/NOTIFY` (mechanism deferred to its own issue), publishing every pg-boss state transition, backed by the audit table.
- Benefit: consumers subscribe instead of polling.
- Done when: no production consumer of pg-bossier polls the query API to detect state changes.

**Goal 7 — pg-boss compatibility tier system.**

- Ships: documented classification of every pg-boss surface pg-bossier uses into Stable / Transitional / Forbidden, plus a CI matrix that runs against supported pg-boss versions.
- Benefit: pg-boss minor releases absorbable in ~2 weeks without ad-hoc archaeology.
- Done when: every pg-boss surface in pg-bossier code is named in the tier doc; CI matrix passes against the supported pg-boss version set.

**Goal 8 — One-step install, symmetric uninstall.**

- Ships: a one-line install (one user-facing dependency, whatever its internal distribution shape) + a single migration into the isolated `pgbossier` schema + clean removal via `DROP SCHEMA pgbossier CASCADE` and uninstalling the dependency.
- Benefit: <1hr adoption on existing pg-boss installs; clean removal.
- Done when: end-to-end install on a fresh pg-boss instance is reproducible in <1hr; uninstall leaves zero pgbossier remnants.
- Note: whether the dependency resolves to one npm package, a monorepo with main + adapters, or a separate Prisma adapter, is deferred — see distribution-shape in the "does not decide" list.

### New constraints to add to issue #1

These shape every implementation, so they live in issue #1 rather than per-issue:

- **Constraint — audit writes are best-effort, never block pg-boss.** Pg-bossier failures (audit row insert error, event emitter throw, anything else in the pg-bossier hook path) must not prevent the underlying pg-boss operation from completing. Default behavior: log and continue. Stricter modes are out of scope for v1.
- **Constraint — per-event overhead has a published budget.** Pg-bossier adds work to every job lifecycle event. v1 ships with a numeric per-event budget (target TBD in its sub-issue) measured against pg-boss baseline. Exceeding the budget blocks release.
- **Non-goal — bounded retention.** Pg-bossier writes to its audit table forever. Partitioning strategies, roll-up summaries, retention policy, and storage-cost optimization are consumer-owned. We document recommended approaches; we don't ship tooling.

### Sub-issue split

After issue #1 is refined and merged, eleven sub-issues are opened. Each references issue #1 as its rubric.

**Goal-implementation issues (one per goal):**

| Sub-issue title | Maps to |
|---|---|
| Forensic audit table — schema, capture mechanism, write semantics | Goal 1 |
| Terminal-state detail — discriminated-union shape, worker signaling protocol, `class` mandate for failed | Goal 2 |
| Lineage columns — parent/successor links + supersession semantics | Goal 3 |
| Typed job query API — method signatures + TS generics surface | Goal 4 |
| Persistent progress API — storage location + retry-resume semantics | Goal 5 |
| Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY) + payload schema | Goal 6 |
| pg-boss compatibility tier doc + CI matrix definition | Goal 7 |
| Install/uninstall surface — migration tooling + Prisma coexistence | Goal 8 |

**Cross-cutting issues (don't map 1:1 to a goal):**

| Sub-issue title | Reason |
|---|---|
| Backfill strategy for existing installs | Affects Goal 1 implementation |
| Performance budget — numeric per-event overhead target | Cross-cutting; gives Goal 7's "stay close" enforceable teeth |
| TypeScript generics surface — `Job<TInput, TOutput>` pattern | Most affects Goal 4; also Goal 5/6 |

Each sub-issue opens as a stub: one-sentence "what this issue decides", link to its parent goal, `blocked-by-issue-1` label. The stubs make the roadmap legible without committing to implementation details.

## Decisions taken

The four open decisions from brainstorming, with their resolutions:

| Decision | Default proposed | Resolution |
|---|---|---|
| Granularity: 6 broad goals vs 8 narrower goals | 8 narrower | **8 narrower** — each goal maps 1:1 to one sub-issue and one "done when" criterion |
| Rewrite issue #1 body vs amend in place | Rewrite | **Rewrite** — zero comments on the issue today, so no thread to preserve |
| Sub-issue creation timing | Open all 11 stubs now | **Open all 11 stubs now** — visible roadmap; stubs closable later if a goal gets descoped |
| Which cross-cutting concerns belong in issue #1 itself | Lift only fail-open + perf budget + unbounded-retention | **Lift the three** — they shape every implementation; the others (backfill, TS generics, audit growth, etc.) are tractable in isolation as their own sub-issues |
| Failure classification shape (Goal 2) | Orthogonalize into `terminal_state` + `failure_class` columns | **`terminal_state` (pg-boss-owned values) + `terminal_detail` (JSONB, discriminated-union, `class` mandated for failed)** — one field for state-discriminated metadata rather than separate columns; reduces NULL forests; extensible to future detail fields without migrations. Goals 1 and 2 stay separate goals — they ship along different axes (preservation vs capture-shape) and each is independently valuable. Storage shape (JSONB vs alternatives) deferred to the sub-issue. |

## What this design does NOT decide

These remain deferred — each becomes its own sub-issue:

- Exact method signatures for any goal's API
- Audit-capture mechanism (Postgres trigger vs app hook vs both)
- Exact audit table schema (columns, indexes, FK constraints)
- Failure-classification signaling protocol (how a worker tells pg-bossier the failure class)
- Progress storage location (`pgboss.job.output` vs sidecar)
- Terminal-detail storage location when Goal 1 is not enabled (`pgboss.job.output` vs sidecar, deferred from Goal 2)
- Lifecycle event mechanism (`EventEmitter` vs `LISTEN/NOTIFY` vs both)
- Lifecycle event payload schema
- pg-boss compatibility tier exact membership lists
- Distribution shape (single package, monorepo, separate Prisma adapter)
- TypeScript generics pattern for `Job<TInput, TOutput>`
- Migration tooling shape (raw SQL file, Prisma migration, custom runner)
- Backfill strategy default (capture-from-now vs full vs toggleable)
- Numeric per-event overhead budget
- Audit-schema versioning across pg-bossier major bumps
- Worker identity model for `getActiveWorkers()`
- Read-side connection pooling
- Test-coverage targets

## Acceptance criteria for the refinement

The refinement is done when:

1. Issue #1's body is rewritten with the eight-goal structure, three new constraints/non-goals, and lighter language.
2. Eleven sub-issue stubs are opened on GitHub, each linking to issue #1 as its rubric and labeled `blocked-by-issue-1`.
3. `CLAUDE.md` is updated to reflect the new goal numbering, new constraints, and the sub-issue list (so future agents working on the repo see the refined structure as canonical).
4. The before/after state is summarized in a comment on issue #1 itself (single comment, links to the design doc) so the reasoning is discoverable from GitHub alone.

## Next step

Once you approve this spec, the next skill is `superpowers:writing-plans` — it generates the concrete implementation plan: the exact rewritten body of issue #1, the eleven stub titles + bodies, the CLAUDE.md diff, and the summary comment.

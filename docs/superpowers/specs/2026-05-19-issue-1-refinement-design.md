# Issue #1 Refinement — Design

- **Status:** Approved direction, awaiting spec review before implementation plan
- **Date:** 2026-05-19
- **Author:** elfensky, with claude-code (brainstorming)
- **Target:** [elfensky/pg-bossier#1](https://github.com/elfensky/pg-bossier/issues/1)

## Context

Issue #1 is pg-bossier's scope document — the rubric every implementation issue is supposed to be evaluated against. It exists, has no comments yet, and reads well as a thinking artifact. Five problems make it less useful than it could be as a rubric:

1. **Framing inversions.** Several goals name a benefit ("no raw SQL in consumers") rather than the capability we ship to produce that benefit ("typed job query API"). Benefit-titled goals are untestable as "done?" — you can only test the capability and measure whether the benefit followed.
2. **Bundled goals.** Goal 1 ("Operational data plane") is actually three independently-shippable capabilities — audit table, failure classification, lineage tracking — collapsed into one item. Bundling forces reviewers to evaluate three orthogonal design decisions at once.
3. **Missing constraints.** Several load-bearing decisions are absent from issue #1 today: audit-write transaction semantics, per-event overhead budget, error-policy on pg-bossier failure, retention strategy. Without these in scope, every implementation issue ends up re-litigating them.
4. **Heavy language.** Phrases like "operational data plane", "forensic preservation", "substrate", "symmetric drop-in" are accurate but raise the cost of reading. Lighter equivalents preserve precision without the jargon tax.
5. **Stale pg-boss baseline.** Issue #1 — and an early draft of this design — describe a pre-12 pg-boss data model: an `archive` table, an `expired` state, a `superseded` state. pg-boss 12.18.2 (the version pinned in `package.json` `peerDependencies`) has none of those. Goals built on those facts must be corrected before they can serve as a rubric — see § Outdated pg-boss assumptions.

This design proposes a refined structure for issue #1 and a 12-issue sub-issue split. The refined issue #1 stays a charter — it decides scope, not implementation.

## Diagnostic

### Framing inversions

| Current goal                 | What it is             | Real _requirement_ (capability shipped)                                                                                      | Real _benefit_ (outcome)                         |
| ---------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1. "Operational data plane"  | Vague benefit + bundle | Audit table + failure-class enum + lineage links                                                                             | "What happened to job X?" answerable forever     |
| 2. "No raw SQL in consumers" | Negative outcome       | New read APIs (`peek` / `findById` / `listActive` / `listStalled` / `getRetryHistory` / `getActiveWorkers` / state-counts)   | No `$queryRaw` against `pgboss.*`                |
| 3. "Mid-flight visibility"   | Benefit                | Persistent progress API surviving DELETE+re-INSERT                                                                           | Long-running progress survives crashes & retries |
| 4. "Stay close to pg-boss"   | Delivery promise       | Surface tier classification (Stable/Transitional/Forbidden) + CI matrix                                                      | pg-boss minors absorbable in ~2 weeks            |
| 5. "Drop-in adoption"        | Benefit                | Single package + single migration + isolated schema + clean uninstall                                                        | <1hr adoption; clean removal                     |
| 6. "Reactive surface"        | Abstract jargon        | Lifecycle event API backed by audit table                                                                                    | Consumers stop polling                           |

### Goal 1 bundling

"Operational data plane" contains three orthogonal capabilities:

- **1a. Forensic audit table.** `pgbossier.job_audit` populated on every pg-boss state change, surviving pg-boss's in-place deletion of job rows (both the `deletion_seconds`-driven `DELETE` and the `DELETE`+`INSERT` cycle pg-boss runs on every retry).
- **1b. Failure classification.** Typed sub-classification (`transient` / `non_retryable`) recorded when a job is `failed`, plus pg-bossier-derived outcome refinements (`expired`, `superseded`) reconstructed from pg-boss signals — see the enum section below for why these are not pg-boss states.
- **1c. Retry history tracking.** Parent/successor links across retries, reschedules, supersession. This is the retry tree across pg-boss's DELETE+INSERT retry path — distinct from _data lineage / data provenance_ (what external data the handler consumed during execution; see Goal 4 for that slot). "Retry history" names the 80% case; the data also covers reschedules and supersession, documented in scope in Goal 3.

These ship along different axes (preservation, capture-shape, lineage), so each is independently valuable — a consumer can adopt just the capture-shape convention without the audit substrate, and vice versa. Splitting them lets each ship as a discrete increment.

### The 5-value enum conflates two axes — and is wrong about pg-boss

The current issue #1's failure classification enum (`transient` / `non_retryable` / `cancelled` / `expired` / `superseded`) has two problems: it conflates orthogonal concerns, and it is factually wrong about pg-boss's state machine.

**The conflation.** The enum bundles two unrelated axes into one flat list:

- **Terminal outcomes** — `cancelled`, `expired`, `superseded` describe _what kind of outcome happened_.
- **Failure sub-classification** — `transient`, `non_retryable` are only meaningful _when the job failed_. They're the retry-class signal pg-boss#516 asks for.

**The factual error.** Issue #1 treats `cancelled` / `expired` / `superseded` as terminal states pg-boss "already distinguishes at the state-machine level". Verified against pg-boss 12.18.2 source: pg-boss's `job_state` enum is exactly `created` / `retry` / `active` / `completed` / `cancelled` / `failed` — six states, three of them terminal (`completed` / `cancelled` / `failed`). **There is no `expired` state and no `superseded` state** (zero occurrences in pg-boss source). A job that exceeds `expireInSeconds` is routed through pg-boss's normal fail path into `failed` (or `retry`); a singleton displaced by a newer job lands in `cancelled`. "Expired" and "superseded" are distinctions pg-bossier _reconstructs_ from pg-boss columns (timeout markers; singleton policy + the presence of a successor) — not states it can read.

The refinement decomposes the conflation along the corrected axes:

- `terminal_state` — column, **pg-boss-owned values only**: `completed` / `cancelled` / `failed`.
- `terminal_detail` — JSONB, discriminated-union shape varying by `terminal_state`. Carries the failure `class` field when `terminal_state` is `failed`, and the pg-bossier-derived outcome refinements (`expired` marker on `failed`, `superseded` marker on `cancelled`).

See Goal 2. This correction _strengthens_ Goal 2: because pg-boss flattens "expired" and "superseded" away, recovering those distinctions is exactly the gap `terminal_detail` exists to fill.

### Outdated pg-boss assumptions

Issue #1 — and an earlier draft of this design — describe a pg-boss data model that pg-boss has since changed. All claims below verified against pg-boss 12.18.2 (pinned in `package.json` `peerDependencies`) by reading `node_modules/pg-boss/dist`:

- **No `pgboss.archive` table.** pg-boss 12 creates `version` / `queue` / `schedule` / `subscription` / `bam` / `warning` / `job` / `job_common` in its schema — no `archive`. There is no archive→delete two-phase cleanup; job rows are removed in place by a single `DELETE` driven by per-queue `deletion_seconds` (7 days after completion by default; `deleteAfterSeconds: 0` disables it entirely). Every "archive→delete" phrase in issue #1, this design, and `CLAUDE.md` § pg-boss compatibility contract must be corrected — Goal 8's transitional-surface list names `pgboss.job`, never `pgboss.archive`.
- **pg-boss preservation is already configurable.** With `deleteAfterSeconds: 0` a consumer keeps completed jobs in `pgboss.job` indefinitely. Goal 1's value is therefore narrower than "pg-boss throws jobs away and we don't" — see the corrected Goal 1 body for the precise framing.
- **Retry is a `DELETE`+`INSERT`, and `output` rides along by parameter.** pg-boss's `failJobs` SQL deletes the job row and re-inserts it as `retry` or `failed`. The `output` column is carried into the re-insert because the SQL is templated to do so — not by any state-machine guarantee. A Goal 6 progress design living in `pgboss.job.output` survives retries on 12.18.2 but is one upstream SQL change from silently losing progress; this is the concrete argument for the sidecar option.
- **Three terminal states, not five** — see the failure-enum section above.

None of these corrections change a goal's _intent_; they correct the facts the goals rest on.

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
- Singleton supersession retry-history edge cases
- Pg-bossier self-instrumentation (does pg-bossier itself emit logs/spans about its own ops?)
- Job payload size handling (preserve full vs hash + truncate for large payloads)
- Multi-schema / multi-instance pg-boss support

**Belongs nowhere (closed by current scope):**

- _(None identified — everything missing is either in-scope for a sub-issue or is an explicit non-goal candidate.)_

### Language simplification

Substitutions to apply when rewriting:

| Heavy                         | Lighter                                                   |
| ----------------------------- | --------------------------------------------------------- |
| "Operational data plane"      | "Job history and lookup"                                  |
| "Forensic preservation"       | "Permanent job history"                                   |
| "Mid-flight visibility"       | "Live progress reporting"                                 |
| "Substrate"                   | "API" or "foundation"                                     |
| "Surfaces" (pg-boss surfaces) | "APIs and tables" (with one-line definition on first use) |
| "Symmetric drop-in"           | "Easy to install, easy to uninstall"                      |
| "Reactive surface"            | "Lifecycle events"                                        |

Prefer accessible specific terms over general or technical ones — "retry history" beats "lineage" (which is ambiguous with data lineage / provenance) and beats "attempt-chain" (precise but technical); "terminal_detail" beats "failure metadata"; etc. Cut decorative jargon, keep precise jargon.

## Design

### Reframed goal list

Nine goals, each with **what we ship**, **what consumers get**, **what counts as done**.

**Goal 1 — Permanent job history.**

- Ships: `pgbossier.job_audit` table, populated automatically on every pg-boss state change, surviving both ways pg-boss removes job rows — the `deletion_seconds`-driven `DELETE`, and the `DELETE`+`INSERT` cycle pg-boss runs on every retry.
- Benefit: "What happened to job X six months ago?" remains answerable — including the per-attempt history that pg-boss's retry `DELETE`+`INSERT` overwrites in place.
- Scope note: pg-boss can already retain completed jobs indefinitely (`deleteAfterSeconds: 0`). Goal 1 is _not_ "pg-boss deletes, we don't" — it is an audit substrate in a separate schema, with retention independent of the hot `pgboss.job` table, capturing the per-attempt rows pg-boss never keeps.
- Done when: every in-scope pg-boss state change leaves an audit row; audit rows are never removed by pg-boss's cleanup.
- Independent of Goal 2: the audit table preserves whatever data exists at the time of capture, regardless of whether `terminal_detail` follows the shape convention. With Goal 2, the convention is enforced; without Goal 2, `terminal_detail` is free-form.

**Goal 2 — Typed terminal-state detail capture.**

- Ships: at the moment a job reaches a terminal state, structured detail about _why/how_ is recorded as a JSONB value whose shape is discriminated by `terminal_state`. `terminal_state` carries **only the three values pg-boss's state machine actually has** — `completed` / `cancelled` / `failed`:
  - `completed` → typically empty.
  - `failed` → `{ class, message?, where?, ... }`. When the failure was a timeout, detail also carries the pg-bossier-derived `expired` marker — e.g. `{ class: 'transient', expired: true, deadlineMs?, exceededByMs? }`.
  - `cancelled` → `{ cancelledBy?, reason? }`. When the cancel was a singleton displaced by a newer job, detail carries the pg-bossier-derived `superseded` marker — e.g. `{ reason: 'superseded', supersededByJobId }`.
- "Expired" and "superseded" are pg-bossier-derived refinements, not pg-boss states — pg-boss has no `expired`/`superseded` state to read (see § Outdated pg-boss assumptions). Reconstructing them from pg-boss columns is precisely the gap this goal fills.
- Workers signal at fail/complete time (extension to pg-boss's `fail()` / `complete()` paths, exact shape deferred). For `failed` terminal-state, the `class: 'transient' | 'non_retryable'` field is mandated; pg-bossier rejects writes missing it.
- Benefit: "Why did this job fail?" is one typed read; aggregation queries by failure class are reliable; the retry-class signal pg-boss#516 asks for becomes available to consumers; the `where`/`code`/etc. detail fields stay consumer-defined for domain context.
- Done when: every job reaching a terminal state has a queryable `terminal_detail`; every `failed` row has a valid `class` value; the convention is documented and validated by pg-bossier's API at write time.
- Independent of Goal 1: detail is captured at the moment of state change and stored in pg-boss's natural location (preserved by pg-boss until its `deletion_seconds` cleanup runs) regardless of whether the forensic audit table (Goal 1) is enabled. With Goal 1 enabled, the same detail is preserved forever in the audit table; without it, the detail follows pg-boss's normal cleanup schedule.

**Goal 3 — Retry history tracking.**

- Ships: parent/successor link columns on audit rows, populated for retries, reschedules, and singleton supersession. The name "retry history" reflects the 80% case; the data also covers reschedules and singleton supersession (each populates the same parent/successor link columns). This is distinct from data lineage / provenance — see Goal 4 for that slot.
- Benefit: full retry-and-supersession history reconstructable from the audit table alone.
- Done when: `getRetryHistory(jobId)` returns the complete history for any in-scope job (retries, reschedules, and supersession links).

**Goal 4 — Optional input-snapshot capture.**

- Ships: an opt-in JSONB slot (`input_snapshot`) on each audit row for consumer-supplied "consumed-data manifest" — primary keys, snapshot timestamps, inline rows, or any shape that fits the job's data dependency. Workers populate it at queue time or job start; pg-bossier preserves it without dictating shape.
- Benefit: "What data did job X see when it ran?" becomes answerable with a typed read, for the consumer's chosen snapshot shape. Small jobs can store inline data or primary keys; large jobs (operating on entire tables) can store a snapshot timestamp to reconstruct the view at queue time.
- Done when: the audit row has an opt-in `input_snapshot` JSONB column; pg-bossier exposes a typed reader; the slot is documented as opt-in with no enforced shape.
- Independent of Goal 1: as with Goal 2, the snapshot can live in pg-boss's natural location (e.g., extending the job's `data` field by convention) if Goal 1 is not enabled; Goal 1 preserves it forever when enabled.
- Out of scope: pg-bossier does not introspect handler behavior or auto-capture consumed data. The slot is for _consumer-supplied_ snapshots only.

**Goal 5 — New APIs.**

- Ships: methods covering operations pg-boss doesn't provide _or provides only partially_. Concretely for v1, the **operational read methods** — `peek`, `findById`, `listActive`, `listStalled`, `getRetryHistory`, `getActiveWorkers`, state-bucket counts.
- Overlap with pg-boss is real and must be named per method — pg-boss 12.18.2 already ships partial coverage of three of these, so "always new APIs" is not true and the sub-issue must state each method's differentiator:
  - `findById` — pg-boss `findJobs(name, opts)` can already look up by id, but _requires the queue name_. pg-bossier's `findById(jobId)` resolves across queues; the cross-queue lookup is the value-add.
  - state-bucket counts — pg-boss `getQueueStats` / `getQueues` return `deferredCount` / `queuedCount` / `activeCount` / `totalCount` per queue, but no `failed`/`completed` counts and no cross-queue rollup. pg-bossier completes the set.
  - `getActiveWorkers` — pg-boss `getWipData()` exposes worker WIP, but only for workers in the _current Node process_. pg-bossier's value-add is real only if it gives cross-instance visibility; the sub-issue must commit to that or drop the method.
  - `listStalled` — pg-boss now resolves stalled jobs itself (`heartbeatSeconds` + `failJobsByHeartbeat`), but exposes no read API for "what is stuck right now". The read shape is net-new; the resolution mechanism is upstream's.
  - `peek`, `getRetryHistory` — fully net-new; pg-boss has nothing comparable.
- Note on writes: the write surfaces introduced by other goals (terminal_detail capture from Goal 2, input_snapshot from Goal 4, progress from Goal 6) _may_ also be new APIs OR _may_ extend pg-boss's existing methods. That choice is deferred per-feature to each goal's sub-issue, per the API-shape principle (see New constraints).
- Benefit: consumers stop using `$queryRaw` against `pgboss.*`; pg-bossier's operational reads are reachable via clear methods with strong return-value types (TS consumers get autocomplete; JS consumers call the same methods without compile-time checks).
- Done when: descent-app's raw-SQL count against `pgboss.*` drops to zero (or to a documented short list with stated reasons); the named methods exist and return typed values without consumer-side casting.

**Goal 6 — Persistent job progress.**

- Ships: a pg-bossier-managed slot for arbitrary progress data (consumer-defined shape, likely JSONB), written by the worker, preserved across pg-boss's DELETE+re-INSERT retry path, queryable via the typed read API (Goal 5).
- Two usage patterns are supported by the same mechanism:
  - **Resumable jobs** — workers store a structured *position* (cursor, processed-count, phase number). On retry, the worker reads the previous value and resumes from there. Display percent is derived by the consumer (e.g., `processed / total`). Examples: "processed 400/1000 requests, restart from 400"; "completed phase 3 of 6".
  - **Non-resumable jobs** — workers store a *display value* directly (percent, step number). On retry, the previous value is visible until the new attempt overwrites it; consumers can render it as stale or reset based on the active attempt's state. Examples: "uploading 30%"; "ETA 2 minutes".
- pg-bossier doesn't *need* to know which mode a job uses. It just persists what the worker writes. Whether the worker *uses* the persisted value on retry (to resume) or *ignores* it (and starts over) is a worker-side decision.
- Benefit: incremental work doesn't get repeated after crashes; monolithic work still gets observability without committing to persistence semantics it doesn't need.
- Done when: workers can write progress via a single API; the value survives a worker crash + pg-boss retry; consumers can read current progress via the typed query API; with Goal 1 enabled, per-attempt progress history is reconstructable.
- Storage-location caveat: pg-boss's retry path is a `DELETE`+`INSERT`, and `pgboss.job.output` survives it only because pg-boss's `failJobs` SQL is currently templated to carry `output` forward — not because of any state-machine guarantee. A progress slot in `pgboss.job.output` works on pg-boss 12.18.2 but is one upstream SQL change from silently dropping progress. This is the concrete argument for the sidecar option; the storage-location sub-issue must weigh it.
- Independent of Goal 1: the progress slot lives in a pg-bossier-owned location (sidecar or column on the active-job row) and works without the forensic audit substrate. Goal 1 enables progress-over-time forensic queries by preserving the progress value at each audit checkpoint.

**Goal 7 — Lifecycle event API.**

- Ships: an event API publishing every pg-boss state transition that pg-bossier captures. The event types map to pg-boss's actual transitions — `created` / `started` (→`active`) / `completed` / `failed` / `cancelled` / `retried` (→`retry`). `expired` and `superseded` are _not_ separate event types — they are derived refinements carried in the `failed` / `cancelled` event payload (consistent with Goal 2's `terminal_detail`); whether to additionally emit them as convenience events is a Goal 7 sub-issue choice. Mechanism — in-process EventEmitter, Postgres `LISTEN/NOTIFY` on pg-bossier-owned channels, or both — deferred to the sub-issue.
- Benefit: consumers subscribe instead of polling. Maps to pg-boss#570, which upstream declined.
- Done when: no production consumer of pg-bossier polls the query API to detect state changes.
- Distinct from pg-boss's "pub/sub" API — pg-boss pub/sub is queue fan-out (publishing to event X creates jobs in subscribed queues), not real-time event delivery. pg-bossier's lifecycle events describe state transitions of _existing_ jobs, not topology of _new_ ones.
- Precedent: pg-boss's `persistWarnings` option follows the "emit event AND optionally persist" shape — warnings land in a `warning` table with retention. Goal 7 + Goal 1 apply that same shape to job state transitions.
- Independent of Goal 1: events fire from pg-bossier's hook regardless of whether the audit table preserves them. Goal 1 enabled = events also queryable forever historically. Goal 1 disabled = events still emit live, just not retrievable post-hoc.
- Constraint — Postgres channel namespacing: if `LISTEN/NOTIFY` is part of the chosen mechanism, channels MUST be prefixed `pgbossier_*` to avoid collision with any future pg-boss use and to preserve Goal 9's symmetric-uninstall guarantee.

**Goal 8 — pg-boss compatibility tier system.**

- Ships: documented classification of every pg-boss surface pg-bossier uses into Stable / Transitional / Forbidden, plus a CI matrix that runs against supported pg-boss versions.
- Benefit: pg-boss minor releases absorbable in ~2 weeks without ad-hoc archaeology.
- Surfaces the tier doc must explicitly place (verified present in pg-boss 12.18.2): the public JS API (`send` / `fetch` / `complete` / `fail` / `work` / `touch` / `findJobs` / `getQueueStats` / `getWipData` / …) → Stable; reads against the `pgboss.job` table → Transitional — note there is **no `pgboss.archive` table**, do not list one; the `pgboss.bam` table and other internal maintenance machinery → Forbidden; pg-boss's ORM transaction adapters (`fromKnex` / `fromKysely` / `fromPrisma` / `fromDrizzle`) → Stable for the function names, Transitional for the ORM-version-coupled wrapped types.
- Done when: every pg-boss surface in pg-bossier code is named in the tier doc; CI matrix passes against the supported pg-boss version set.

**Goal 9 — One-step install, symmetric uninstall.**

- Ships: a one-line install (one user-facing dependency, whatever its internal distribution shape) + a single migration into the isolated `pgbossier` schema + clean removal via `DROP SCHEMA pgbossier CASCADE` and uninstalling the dependency.
- Benefit: <1hr adoption on existing pg-boss installs; clean removal.
- Done when: end-to-end install on a fresh pg-boss instance is reproducible in <1hr; uninstall leaves zero pgbossier remnants.
- Note: whether the dependency resolves to one npm package, a monorepo with main + adapters, or a separate Prisma adapter, is deferred — see distribution-shape in the "does not decide" list.
- Note on Prisma coexistence: pg-boss 12 already ships first-class ORM transaction adapters (`fromKnex` / `fromKysely` / `fromPrisma` / `fromDrizzle`). The migration-tooling sub-issue should treat Prisma coexistence as "compose with pg-boss's existing Prisma support", not "invent our own" — and stay consistent with the API-shape composition principle.

### New constraints to add to issue #1

These shape every implementation, so they live in issue #1 rather than per-issue:

- **Constraint — audit writes are best-effort, never block pg-boss.** Pg-bossier failures (audit row insert error, event emitter throw, anything else in the pg-bossier hook path) must not prevent the underlying pg-boss operation from completing. Default behavior: log and continue. Stricter modes are out of scope for v1. Open edge case for a sub-issue: pg-boss 12 lets a consumer run a queue op inside an ORM transaction (`boss.send(q, data, { db: fromPrisma(tx) })`). "Audit write never blocks pg-boss" implies the audit row is written _outside_ that transaction — so a rolled-back `send` can still leave an audit row. The Goal 1 sub-issue must decide whether that inconsistency is acceptable or whether audit writes opt into the caller's transaction when one is supplied.
- **Constraint — per-event overhead has a published budget.** Pg-bossier adds work to every job lifecycle event. v1 ships with a numeric per-event budget (target TBD in its sub-issue) measured against pg-boss baseline. Exceeding the budget blocks release. This is not a self-imposed nicety: when pg-boss declined job events (pg-boss#570, closed `not planned`), the maintainer's stated reason was that an internal event table "could become a bottleneck in high-volume use cases, interfering with the db connection being used for job proc[essing]." The budget is pg-bossier's answer to exactly that objection.
- **Non-goal — bounded retention.** Pg-bossier writes to its audit table forever. Partitioning strategies, roll-up summaries, retention policy, and storage-cost optimization are consumer-owned. We document recommended approaches; we don't ship tooling.
- **Principle — API shape: composition, not replacement.** pg-bossier composes with pg-boss, never replaces or forks its queue ops. Within that constraint, _how_ a state-changing pg-bossier feature attaches to pg-boss is an explicit per-feature exploration: (a) **overload** pg-boss's existing methods via new optional parameters (e.g., `boss.fail(id, err, { class })`), or (b) **new sibling methods** on a separate pg-bossier client (e.g., `bossier.setProgress(id, ...)`), or (c) **wrapping client** that intercepts pg-boss calls and adds behavior. Each write-feature sub-issue (Goals 2, 4, 6) prototypes both (a) and (b) and documents the trade-off before choosing. Read methods (Goal 5) are always new APIs — pg-boss provides none to overload.

### Sub-issue split

After issue #1 is refined and merged, twelve sub-issues are opened. Each references issue #1 as its rubric.

**Goal-implementation issues (one per goal):**

| Sub-issue title                                                                                          | Maps to |
| -------------------------------------------------------------------------------------------------------- | ------- |
| Forensic audit table — schema, capture mechanism, write semantics                                        | Goal 1  |
| Terminal-state detail — discriminated-union shape, worker signaling protocol, `class` mandate for failed | Goal 2  |
| Retry history columns — parent/successor links + supersession semantics                                  | Goal 3  |
| Input-snapshot slot — opt-in JSONB column, consumer-defined shape, typed reader                          | Goal 4  |
| New APIs — operational read methods + TS generics surface (write-method shape deferred per write-feature) | Goal 5  |
| Persistent progress API — storage location + retry-resume semantics                                      | Goal 6  |
| Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY) + payload schema                              | Goal 7  |
| pg-boss compatibility tier doc + CI matrix definition                                                    | Goal 8  |
| Install/uninstall surface — migration tooling + Prisma coexistence                                       | Goal 9  |

**Cross-cutting issues (don't map 1:1 to a goal):**

| Sub-issue title                                              | Reason                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Backfill strategy for existing installs                      | Affects Goal 1 implementation                                |
| Performance budget — numeric per-event overhead target       | Cross-cutting; gives Goal 8's "stay close" enforceable teeth |
| TypeScript generics surface — `Job<TInput, TOutput>` pattern | Most affects Goal 5; also Goal 6/7                           |

Each sub-issue opens as a stub: one-sentence "what this issue decides", link to its parent goal, `blocked-by-issue-1` label. The stubs make the roadmap legible without committing to implementation details.

## Decisions taken

Decisions accumulated during brainstorming:

| Decision                                               | Default proposed                                              | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Granularity: 6 broad goals vs 8 narrower goals         | 8 narrower                                                    | **8 narrower initially** — each goal maps 1:1 to one sub-issue and one "done when" criterion. Later expanded to 9 (see input-snapshot decision below).                                                                                                                                                                                                                                                                                                                                    |
| Rewrite issue #1 body vs amend in place                | Rewrite                                                       | **Rewrite** — zero comments on the issue today, so no thread to preserve                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sub-issue creation timing                              | Open all stubs now                                            | **Open all 12 stubs now** — visible roadmap; stubs closable later if a goal gets descoped                                                                                                                                                                                                                                                                                                                                                                                                 |
| Which cross-cutting concerns belong in issue #1 itself | Lift only fail-open + perf budget + unbounded-retention       | **Lift the three** — they shape every implementation; the others (backfill, TS generics, audit growth, etc.) are tractable in isolation as their own sub-issues                                                                                                                                                                                                                                                                                                                           |
| Failure classification shape (Goal 2)                  | Orthogonalize into `terminal_state` + `failure_class` columns | **`terminal_state` (pg-boss-owned values: `completed` / `cancelled` / `failed` — _not_ five; `expired`/`superseded` are pg-bossier-derived, see § Outdated pg-boss assumptions) + `terminal_detail` (JSONB, discriminated-union, `class` mandated for failed)** — one field for state-discriminated metadata rather than separate columns; reduces NULL forests; extensible to future detail fields without migrations. Goals 1 and 2 stay separate goals — they ship along different axes (preservation vs capture-shape) and each is independently valuable. Storage shape (JSONB vs alternatives) deferred to the sub-issue. |
| Lineage vocabulary (Goal 3)                            | Rename to disambiguate from data lineage                      | **Final name: "Retry history tracking"** — first renamed from "Lineage tracking" to "Attempt-chain tracking" (precise but technical), then to "Retry history tracking" for accessibility. "Retry history" names the 80% case; reschedules and singleton supersession are documented as in scope in the goal body. Removes ambiguity with data lineage / provenance entirely. Method name follows: `getRetryHistory(jobId)`.                                                                |
| Data-provenance handling (new Goal 4)                  | A (out of scope) / B (slot, no opinions) / C (slot + conventions) | **B (slot, no opinions)** — add an opt-in `input_snapshot` JSONB column; consumers populate with whatever shape fits their job size (primary keys, snapshot timestamps, inline data). pg-bossier preserves but doesn't dictate. v1 stays out of the data-provenance taxonomy business; if conventions emerge, promote to C in a later version.                                                                                                                                            |
| Job progress shape (Goal 6)                            | Two separate modes (resumable + display) with different storage | **One unified mechanism with two documented usage patterns** — pg-bossier provides a single progress slot (preserved across retries); workers store position (resumable) or display value (non-resumable); resumability is a worker-side decision, not a pg-bossier feature. Avoids over-decomposing into two APIs for one underlying storage need.                                                                                                                                       |
| Goal 5 naming                                          | "Typed job query API" / "Job query API" / "New APIs"          | **"New APIs"** — broader than just queries; absorbs whatever the per-feature API-shape decision lands on (reads are always new; write extensions may be new methods or overloads of pg-boss). "Typed" was confusing — pg-bossier is TS-written / JS-callable, not TS-only.                                                                                                                                                                                                                |
| API-shape choice (Goals 2, 4, 6 writes)                | Commit to either overload OR new-method shape at goal level   | **Add the API-shape principle to issue #1; defer the choice per write feature.** Each write-feature sub-issue prototypes both (a) overload pg-boss method via new options and (b) new sibling pg-bossier method, then documents the trade-off and picks one. Reads (Goal 5) are always new APIs — pg-boss provides none to overload.                                                                                                                                                      |
| Goal 7 baseline (pg-boss event support)                | Assumption that pg-boss already uses LISTEN/NOTIFY            | **Verified by source search: pg-boss does NOT use Postgres LISTEN/NOTIFY**; workers poll. pg-boss's "pub/sub" API is queue fan-out, not real-time event delivery. pg-boss EventEmitter exposes only `error` / `warning` / `wip` / `stopped` / `bam` — no per-job lifecycle events (pg-boss#570 declined). Goal 7 stays net-new; body now disambiguates from pg-boss pub/sub, cites the `persistWarnings` precedent, declares independence from Goal 1, and namespaces `LISTEN/NOTIFY` channels under `pgbossier_*`.   |
| pg-boss baseline facts (Goals 1, 2, 5, 8)              | Inherited issue #1's pre-12 model: `pgboss.archive` table, `expired`/`superseded` states | **Corrected against pg-boss 12.18.2 source.** No `archive` table — job rows are deleted in place by `deletion_seconds`. State enum is `created` / `retry` / `active` / `completed` / `cancelled` / `failed` only — no `expired`/`superseded`. Retry is a `DELETE`+`INSERT` on `pgboss.job`. pg-boss already ships `findJobs` / `getQueueStats` / `getWipData` (partial overlap with Goal 5). See § Outdated pg-boss assumptions. Goals 1, 2, 5, 8 bodies corrected; the correction strengthens Goal 2 rather than weakening it. `CLAUDE.md` and issue #1 Goal 4 inherit the same fix during the rewrite. |

## What this design does NOT decide

These remain deferred — each becomes its own sub-issue:

- Exact method signatures for any goal's API
- Audit-capture mechanism (Postgres trigger vs app hook vs both)
- Exact audit table schema (columns, indexes, FK constraints)
- Failure-classification signaling protocol (how a worker tells pg-bossier the failure class)
- Progress storage location (`pgboss.job.output` vs sidecar) — weigh the Goal 6 retry-path caveat: `output` survival across pg-boss's `DELETE`+`INSERT` is templating-dependent, not guaranteed
- Terminal-detail storage location when Goal 1 is not enabled (`pgboss.job.output` vs sidecar, deferred from Goal 2)
- Input-snapshot storage location when Goal 1 is not enabled (`pgboss.job.data` extension vs sidecar, deferred from Goal 4)
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

1. Issue #1's body is rewritten with the nine-goal structure, three new constraints (fail-open audit writes / per-event overhead budget / API-shape principle), one new non-goal (bounded retention is consumer-owned), the corrected pg-boss baseline (Goal 4's transitional-surface list names `pgboss.job` only — no `pgboss.archive`; the failure vocabulary no longer claims `expired`/`superseded` are pg-boss states), and lighter language. Re-verify every cited pg-boss issue's current state during the rewrite — several have closed since issue #1 was written.
2. Twelve sub-issue stubs are opened on GitHub, each linking to issue #1 as its rubric and labeled `blocked-by-issue-1`.
3. `CLAUDE.md` is updated to reflect the new goal numbering, new constraints, the sub-issue list, and the corrected pg-boss baseline facts — no `pgboss.archive` table, three terminal states not five — so future agents working on the repo see the refined structure as canonical.
4. The before/after state is summarized in a comment on issue #1 itself (single comment, links to the design doc) so the reasoning is discoverable from GitHub alone.

## Next step

Once you approve this spec, the next skill is `superpowers:writing-plans` — it generates the concrete implementation plan: the exact rewritten body of issue #1, the twelve stub titles + bodies, the CLAUDE.md diff, and the summary comment.

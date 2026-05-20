## Purpose

This issue defines **what pg-bossier should achieve** — outcomes, audience, scope, and strategic positioning. It deliberately does **not** specify how. Implementation design lives in follow-up issues that are evaluated against what we agree here.

The trap this issue exists to avoid: jumping to method signatures, schema sketches, and architecture decisions before we've agreed on the goals. Implementation is the cheap part; requirements drift is the expensive part.

---

## Why does pg-bossier exist?

[pg-boss](https://github.com/timgit/pg-boss) is a solid Postgres job queue, but it stops at the queue boundary. It deliberately does not cover:

- Mid-flight job progress ([pg-boss#35](https://github.com/timgit/pg-boss/issues/35), declined)
- Batch progress reporting ([pg-boss#174](https://github.com/timgit/pg-boss/issues/174), declined)
- Per-job lifecycle events ([pg-boss#570](https://github.com/timgit/pg-boss/issues/570), declined)
- Structured failure classification ([pg-boss#516](https://github.com/timgit/pg-boss/issues/516), declined)
- A general query / reporting API for job state
- Permanent job history (pg-boss deletes job rows after a configurable TTL — `deletion_seconds`)

The maintainer has been clear that monitoring / reporting is out of scope. After many major versions with no movement, we don't expect that to change.

For consumers who need these capabilities, the options are:

1. Write raw SQL against `pgboss.job` — descent-app currently has ~45 raw queries ([drunikbe/descent-app#343](https://github.com/drunikbe/descent-app/issues/343))
2. Fork pg-boss
3. Build a layer on top

**pg-bossier is option 3.**

---

## Audience

**Primary (v1):** descent-app and applications with the same shape:
- Run jobs through pg-boss
- Need to display job status and history in their own UIs
- Need permanent job history ("why did job X produce result Y six months ago?")
- Use Prisma or another ORM and want to avoid raw SQL

**Secondary (post-v1):** public OSS consumers with the same shape of need.

The v1 audience constrains the design — we optimize for the descent-app shape first. Generalization comes after the patterns have been validated by real use.

---

## Goals

Each goal lists **what we ship**, **what consumers get**, and **what counts as done**.

### Goal 1 — Permanent job history

- **Ships:** `pgbossier.job_audit` table, populated automatically on every pg-boss state change, surviving pg-boss's in-place row deletion — both the `deletion_seconds`-driven `DELETE` and the `DELETE`+`INSERT` cycle pg-boss runs on every retry.
- **Benefit:** "What happened to job X six months ago?" remains answerable — including the per-attempt history that pg-boss's retry `DELETE`+`INSERT` overwrites in place.
- **Done when:** every in-scope pg-boss state change leaves an audit row; audit rows are never removed by pg-boss's cleanup.
- **Scope note:** pg-boss can already retain completed jobs indefinitely (`deleteAfterSeconds: 0`). Goal 1 is not "pg-boss deletes, we don't" — it is an audit substrate in a separate schema with independent retention, capturing per-attempt rows pg-boss never keeps.
- **Independent of Goal 2:** the audit table preserves whatever data exists at the time of capture, regardless of whether `terminal_detail` follows the shape convention.

### Goal 2 — Typed terminal-state detail capture

- **Ships:** at the moment a job reaches a terminal state, structured detail about *why/how* is recorded as a JSONB value whose shape is discriminated by `terminal_state`. `terminal_state` carries only the three terminal values pg-boss's state machine actually has — `completed` / `cancelled` / `failed`. Shape examples: `completed` → typically empty; `failed` → `{ class, message?, where?, ... }`, plus a pg-bossier-derived `expired` marker when the failure was a timeout; `cancelled` → `{ cancelledBy?, reason? }`, plus a `superseded` marker when a singleton was displaced by a newer job. "Expired" and "superseded" are *not* pg-boss states — pg-boss has no such states; pg-bossier reconstructs them from pg-boss columns. For `failed` terminal-state, the `class: 'transient' | 'non_retryable'` field is mandated; pg-bossier rejects writes missing it.
- **Benefit:** "Why did this job fail?" is one typed read; aggregation queries by failure class are reliable; the retry-class signal pg-boss#516 asks for becomes available to consumers; `where` / `code` / etc. detail fields stay consumer-defined for domain context.
- **Done when:** every job reaching a terminal state has a queryable `terminal_detail`; every `failed` row has a valid `class` value; the convention is documented and validated by pg-bossier's API at write time.
- **Independent of Goal 1:** detail is captured at the moment of state change. With Goal 1 enabled, it's preserved forever in the audit table; without it, it follows pg-boss's normal cleanup schedule.

### Goal 3 — Retry history tracking

- **Ships:** parent/successor link columns on audit rows, populated for retries, reschedules, and singleton supersession. "Retry history" names the 80% case; the data also covers reschedules and singleton supersession.
- **Benefit:** full retry-and-supersession history reconstructable from the audit table alone.
- **Done when:** `getRetryHistory(jobId)` returns the complete history for any in-scope job (retries, reschedules, supersession links).
- **Distinct from data lineage / provenance** — see Goal 4 for that slot.

### Goal 4 — Optional input-snapshot capture

- **Ships:** an opt-in JSONB slot (`input_snapshot`) on each audit row for consumer-supplied "consumed-data manifest" — primary keys, snapshot timestamps, inline rows, or any shape that fits the job's data dependency. Workers populate it at queue time or job start; pg-bossier preserves it without dictating shape.
- **Benefit:** "What data did job X see when it ran?" becomes answerable for the consumer's chosen snapshot shape. Small jobs can store inline data or primary keys; large jobs (operating on entire tables) can store a snapshot timestamp.
- **Done when:** the audit row has an opt-in `input_snapshot` JSONB column; pg-bossier exposes a typed reader; the slot is documented as opt-in with no enforced shape.
- **Independent of Goal 1:** as with Goal 2, the snapshot can live in pg-boss's natural location if Goal 1 is not enabled.
- **Out of scope:** pg-bossier does not introspect handler behavior or auto-capture consumed data. The slot is for *consumer-supplied* snapshots only.

### Goal 5 — New APIs

- **Ships:** methods covering operations pg-boss doesn't provide *or provides only partially*. For v1, the **operational read methods** — `peek`, `findById`, `listActive`, `listStalled`, `getRetryHistory`, `getActiveWorkers`, state-bucket counts. pg-boss 12 already ships partial coverage of some of these (`findJobs`, `getQueueStats`, `getWipData`); the Goal 5 sub-issue must name each method's differentiator rather than assume all are greenfield.
- **Note on writes:** the write surfaces introduced by other goals (terminal_detail / input_snapshot / progress) may also be new APIs OR may extend pg-boss's existing methods — deferred per-feature per the API-shape principle (see constraints).
- **Benefit:** consumers stop using `$queryRaw` against `pgboss.*`. pg-bossier's operational reads are reachable via clear methods with strong return-value types (TS consumers get autocomplete; JS consumers call the same methods without compile-time checks).
- **Done when:** descent-app's raw-SQL count against `pgboss.*` drops to zero (or to a documented short list with stated reasons); the named methods exist and return typed values without consumer-side casting.

### Goal 6 — Persistent job progress

- **Ships:** a pg-bossier-managed slot for arbitrary progress data (consumer-defined shape, likely JSONB), written by the worker, preserved across pg-boss's DELETE+re-INSERT retry path, queryable via the typed read API (Goal 5).
- **Two usage patterns from the same mechanism:**
  - **Resumable jobs** — workers store a structured *position* (cursor, processed-count, phase). On retry, the worker reads the previous value and resumes. Display percent is derived by the consumer.
  - **Non-resumable jobs** — workers store a *display value* directly (percent, step). On retry, the previous value is visible until the new attempt overwrites it.
- pg-bossier doesn't need to know which mode a job uses. It persists what the worker writes; the worker decides whether to use the persisted value on retry (resume) or ignore it.
- **Benefit:** incremental work doesn't get repeated after crashes; monolithic work gets observability without committing to persistence semantics it doesn't need.
- **Done when:** workers can write progress via a single API; the value survives a worker crash + pg-boss retry; consumers can read current progress via the typed query API.
- **Independent of Goal 1:** the progress slot lives in a pg-bossier-owned location and works without the forensic audit substrate.

### Goal 7 — Lifecycle event API

- **Ships:** an event API publishing every pg-boss state transition that pg-bossier captures. Event types map to pg-boss's actual transitions — `created` / `started` / `completed` / `failed` / `cancelled` / `retried`; `expired` and `superseded` are derived refinements carried in the `failed` / `cancelled` payloads, not separate event types. Mechanism — in-process EventEmitter, Postgres `LISTEN/NOTIFY` on pg-bossier-owned channels, or both — deferred to the sub-issue.
- **Benefit:** consumers subscribe instead of polling. Maps to pg-boss#570 which upstream declined.
- **Done when:** no production consumer of pg-bossier polls the query API to detect state changes.
- **Distinct from pg-boss's "pub/sub" API** — pg-boss pub/sub is queue fan-out (publishing to event X creates jobs in subscribed queues), not real-time event delivery.
- **Precedent:** pg-boss's `persistWarnings` option follows the "emit event AND optionally persist" shape — Goal 7 + Goal 1 apply that same shape to job state transitions.
- **Independent of Goal 1:** events fire regardless of whether the audit table preserves them.
- **Constraint — channel namespacing:** if `LISTEN/NOTIFY` is part of the chosen mechanism, channels MUST be prefixed `pgbossier_*` to avoid collision with any future pg-boss use and to preserve Goal 9's symmetric-uninstall guarantee.

### Goal 8 — pg-boss compatibility tier system

- **Ships:** documented classification of every pg-boss surface pg-bossier uses into **Stable** / **Transitional** / **Forbidden**, plus a CI matrix that runs against supported pg-boss versions.
  - **Stable**: pg-boss's documented public JS API (`send`, `fetch`, `complete`, `fail`, `work`, `touch`, etc.). pg-bossier depends on this as contract; breakage is major-version concern.
  - **Transitional**: reads against the `pgboss.job` table. pg-boss 12 has **no `pgboss.archive` table** — job rows are deleted in place by `deletion_seconds`. Tested per supported version; expect bindings to update on pg-boss minor bumps without that being a pg-bossier breaking change.
  - **Forbidden**: pg-boss internals (private SQL, undocumented helpers, internal events, anything in `node_modules/pg-boss/src/*`). pg-bossier MUST NEVER depend on these.
- **Benefit:** pg-boss minor releases absorbable in ~2 weeks without ad-hoc archaeology.
- **Done when:** every pg-boss surface in pg-bossier code is named in the tier doc; CI matrix passes against the supported pg-boss version set.

### Goal 9 — One-step install, symmetric uninstall

- **Ships:** a one-line install (one user-facing dependency, whatever the internal distribution shape) + a single migration into the isolated `pgbossier` schema + clean removal via `DROP SCHEMA pgbossier CASCADE` and uninstalling the dependency.
- **Benefit:** <1hr adoption on existing pg-boss installs; clean removal.
- **Done when:** end-to-end install on a fresh pg-boss instance is reproducible in <1hr; uninstall leaves zero pgbossier remnants.
- **Note:** whether the dependency resolves to one npm package, a monorepo with main + adapters, or a separate Prisma adapter, is deferred — see distribution-shape in the "does not decide" list.

---

## Non-goals

- ❌ **Not a UI / dashboard.** Data plane only — consumers build their own UIs. pg-boss now ships its own dashboard; we don't compete.
- ❌ **Not a REST / HTTP service.** JS API only.
- ❌ **Not a fork of pg-boss.** pg-boss stays an unmodified npm dependency.
- ❌ **Not an upstream PR campaign.** We're not trying to land these features in pg-boss.
- ❌ **Not a queue engine.** pg-boss owns `send` / `fetch` / `complete` / `fail` / `work` / `touch`. pg-bossier extends, never replaces.
- ❌ **Not a scheduling library.** pg-boss handles cron / scheduled jobs. Sub-minute scheduling ([pg-boss#427](https://github.com/timgit/pg-boss/issues/427)) stays a pg-boss concern.
- ❌ **Not a workflow engine.** No job dependencies, DAGs, fan-out/fan-in primitives ([pg-boss#745](https://github.com/timgit/pg-boss/issues/745)). That's Inngest / Temporal / BullMQ-Flow territory.
- ❌ **Not a queue runtime mutator (in v1).** No pause/resume, no force-delete, no concurrency control mid-flight ([pg-boss#551](https://github.com/timgit/pg-boss/issues/551), [#659](https://github.com/timgit/pg-boss/issues/659)). Pause/resume reserved for a possible v0.2 if descent-app's Space-Track rate-limiting concretely surfaces the need.
- ❌ **Not an observability platform.** OpenTelemetry exporters are the consumer's responsibility, built on top of Goal 7's event substrate. We don't ship spans, metrics, or exporters.
- ❌ **Not a testing harness.** pg-boss ships its own testability hooks ([pg-boss#643](https://github.com/timgit/pg-boss/issues/643)). We don't reimplement.
- ❌ **Not an ORM.** Works well alongside Prisma but doesn't depend on it.
- ❌ **Not capturing handler-consumed data automatically.** Goal 4 provides a slot; what consumers put in it is their decision. pg-bossier does not introspect handler behavior.
- ❌ **No bounded retention tooling.** pg-bossier writes to its audit table forever (Goal 1). Partitioning, summarization, and retention policy are consumer-owned. We document recommended approaches; we don't ship tooling.

The non-goals list is as important as the goals list. Anything not explicitly in scope is out — feature requests outside this boundary get closed with a reference to this issue.

---

## Constraints

Three load-bearing rules that every implementation issue must respect (bounded-retention sits in the non-goals list above):

- **Audit writes are best-effort, never block pg-boss.** pg-bossier failures (audit row insert error, event emitter throw, anything else in the pg-bossier hook path) must not prevent the underlying pg-boss operation from completing. Default behavior: log and continue. Stricter modes are out of scope for v1. Edge case for the Goal 1 sub-issue: pg-boss 12 lets a consumer run a queue op inside an ORM transaction (`{ db: fromPrisma(tx) }`); the sub-issue decides whether a rolled-back op may still leave an audit row.
- **Per-event overhead has a published budget.** pg-bossier adds work to every job lifecycle event. v1 ships with a numeric per-event budget (target decided in its sub-issue) measured against pg-boss baseline. Exceeding the budget blocks release. This answers the maintainer's stated reason for declining job events upstream (pg-boss#570): an internal event table that "could become a bottleneck in high-volume use cases."
- **API-shape principle: composition, not replacement.** pg-bossier composes with pg-boss, never replaces or forks its queue ops. Within that constraint, *how* a state-changing pg-bossier feature attaches to pg-boss is an explicit per-feature exploration: (a) overload pg-boss's existing methods via new optional parameters (e.g., `boss.fail(id, err, { class })`); (b) new sibling methods on a separate pg-bossier client (e.g., `bossier.setProgress(id, ...)`); or (c) wrapping client that intercepts pg-boss calls. Each write-feature sub-issue (Goals 2, 4, 6) prototypes both (a) and (b) and documents the trade-off before choosing. Read methods (Goal 5) are always new pg-bossier methods, not overloads of pg-boss methods — even where pg-boss ships related functionality (`findJobs`, `getQueueStats`, `getWipData`), it lives on the pg-boss client and is not an extensible surface.

---

## Success criteria

We'll know pg-bossier is succeeding when:

1. **descent-app's `src/lib/jobs/queries.js` raw SQL count drops to zero** (or to a documented short list with stated reasons).
2. **"What happened to job X six months ago?"** is answerable with a single typed query — including inputs, final output, failure class, full retry history, and worker context — even after pg-boss has deleted the job row from `pgboss.job`.
3. **Consumers wire to job events, not timers.** No production consumer of pg-bossier runs a polling loop against the query API to detect state changes.
4. **Adoption time on an existing pg-boss install is under an hour** — install the package, run one migration, swap the `pg-boss` import where extended APIs are needed.
5. **pg-boss minor releases are supported within ~2 weeks** of upstream publication, verified by a passing CI matrix.

---

## Strategic approach

The strategic approach is **settled here**: pg-bossier is a **layer on top of pg-boss** — not a fork, not an upstream PR campaign. Goal 8 names the compatibility contract that makes the layered approach work (public API stable, schema reads transitional, internals forbidden). A separate follow-up issue can document the limitations of the layered approach in detail, but the *choice* between fork / layer / upstream is decided in this issue, not deferred.

---

## What this issue does NOT decide

The following are deferred to sub-issues:

| Decision | Sub-issue |
|---|---|
| Limitations of the layered approach in detail | Separate follow-up |
| Exact method signatures for any goal's API | Per-goal implementation |
| Audit-capture mechanism (Postgres trigger vs app hook vs both) | Goal 1 sub-issue |
| Exact audit table schema (columns, indexes, FK constraints) | Goal 1 sub-issue |
| Terminal-detail signaling protocol (how a worker tells pg-bossier the failure class) | Goal 2 sub-issue |
| Retry-history columns, supersession semantics | Goal 3 sub-issue |
| Input-snapshot column shape | Goal 4 sub-issue |
| TypeScript generics pattern for `Job<TInput, TOutput>` | Cross-cutting sub-issue |
| Progress storage location, retry-resume semantics | Goal 6 sub-issue |
| Lifecycle event mechanism (`EventEmitter` vs `LISTEN/NOTIFY` vs both) + payload schema | Goal 7 sub-issue |
| pg-boss compatibility tier exact membership lists; CI matrix definition | Goal 8 sub-issue |
| Migration tooling shape (raw SQL file, Prisma migration, custom runner); distribution shape | Goal 9 sub-issue |
| Backfill strategy for existing installs | Cross-cutting sub-issue |
| Numeric per-event overhead budget | Cross-cutting sub-issue |
| Worker identity model for `getActiveWorkers()` | Goal 5 sub-issue |
| Read-side connection pooling; audit-schema versioning | Within their respective sub-issues |
| Test-coverage targets, performance budgets | Operational, follows from success criteria |

Each is its own issue, scoped by the agreement reached here.

---

## Decision needed in this issue

Confirm or revise:

1. The **9-goal list** — anything missing, anything to remove?
2. The **non-goals list** — anything we should explicitly rule in or out?
3. The **3 constraints** — particularly the API-shape principle (overload vs new methods) and fail-open audit writes.
4. The **audience definition** — is descent-app the right primary, with OSS deferred?
5. The **success criteria** — are these the right five, or are we measuring the wrong things?

Once confirmed, this issue becomes the rubric against which every implementation issue is evaluated.

---

## Related

- Design doc capturing the refinement reasoning: [`docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md)
- [drunikbe/descent-app#342](https://github.com/drunikbe/descent-app/issues/342) — JobProgress fallback approach in the consumer
- [drunikbe/descent-app#343](https://github.com/drunikbe/descent-app/issues/343) — descent-app tracking issue for raw-SQL removal

pg-boss issues that justify individual goals and non-goals are cited inline in their respective sections.

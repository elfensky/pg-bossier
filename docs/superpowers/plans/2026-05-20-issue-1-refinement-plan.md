# Issue #1 Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the design from `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md` to the live repository — rewrite issue #1's body on GitHub, open 12 sub-issue stubs, update `CLAUDE.md`, and post a summary comment linking back to the design doc.

**Architecture:** Two-phase work. **Phase 1 (local):** draft all GitHub-bound content as files in a staging directory adjacent to this plan, update `CLAUDE.md` and commit + push the design doc. **Phase 2 (GitHub):** create labels, replace issue #1's body, create all 12 stubs in a loop (capturing their numbers), post the summary comment with the captured numbers substituted in. Every artifact destined for GitHub lives as a file in the repo first so the user can review it before publication; the GitHub state becomes a derivative of the committed artifacts.

**Tech Stack:** `gh` CLI for GitHub operations, `git` for commits/push, plain markdown files for content drafts. No code is being shipped by this plan — the deliverable is restructured GitHub issues + an updated repo doc.

---

## File structure

| Path | Created/Modified | Responsibility |
|---|---|---|
| `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md` | Already exists (untracked) — staged for commit | Design source of truth; referenced from the summary comment |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement-plan.md` | Already exists (this file) | Execution plan |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md` | Created | Rewritten issue #1 body, applied via `gh issue edit` |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md` | Created | Summary comment posted on issue #1 after stubs are created |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/01-audit-table.md` | Created | Stub body for Goal 1 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/02-terminal-detail.md` | Created | Stub body for Goal 2 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/03-retry-history.md` | Created | Stub body for Goal 3 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/04-input-snapshot.md` | Created | Stub body for Goal 4 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/05-new-apis.md` | Created | Stub body for Goal 5 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/06-progress.md` | Created | Stub body for Goal 6 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/07-lifecycle-events.md` | Created | Stub body for Goal 7 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/08-compatibility-tier.md` | Created | Stub body for Goal 8 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/09-install-uninstall.md` | Created | Stub body for Goal 9 sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/10-backfill.md` | Created | Stub body for cross-cutting sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/11-performance-budget.md` | Created | Stub body for cross-cutting sub-issue |
| `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/12-ts-generics.md` | Created | Stub body for cross-cutting sub-issue |
| `CLAUDE.md` | Modified | Updated to reflect the 9-goal structure, 4 constraints, and sub-issue references |

---

## Conventions

- All `gh` calls target `elfensky/pg-bossier` explicitly via `-R elfensky/pg-bossier` to avoid relying on the current directory's repo detection.
- Stub files are numbered 01–12 in `stubs/` so the engineer applies them in order and the GitHub issue numbers come out predictable (assuming no concurrent issue creation by other people).
- Where a step shows expected output, treat as "approximately this" — exact UUIDs, timestamps, and issue numbers will differ.

---

### Task 1: Pre-flight verification

**Files:** none modified.

- [ ] **Step 1: Verify gh CLI is installed and authenticated**

Run:
```bash
gh auth status
```

Expected: output includes `Logged in to github.com account elfensky` (or equivalent) and `Token scopes` listing at least `repo`. If not authenticated, run `gh auth login` interactively and re-verify before continuing.

- [ ] **Step 2: Verify working directory is the pg-bossier repo**

Run:
```bash
git remote get-url origin
```

Expected: `https://github.com/elfensky/pg-bossier.git` or `git@github.com:elfensky/pg-bossier.git`. If not, `cd` to the correct repo before continuing.

- [ ] **Step 3: Verify issue #1 exists and is currently open**

Run:
```bash
gh issue view 1 -R elfensky/pg-bossier --json number,state,title --jq '.'
```

Expected output approximately:
```json
{ "number": 1, "state": "OPEN", "title": "Requirements: what pg-bossier should achieve" }
```

If the issue is closed or missing, STOP and surface to the user before continuing.

- [ ] **Step 4: Verify the design doc exists locally**

Run:
```bash
ls -la docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md
```

Expected: file exists with non-zero size. If missing, STOP and surface to the user — the plan depends on this file.

- [ ] **Step 5: Verify CLAUDE.md exists locally**

Run:
```bash
ls -la CLAUDE.md
```

Expected: file exists. If missing, STOP and surface to the user.

---

### Task 2: Create the staging directory

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/`

- [ ] **Step 1: Create the staging tree**

Run:
```bash
mkdir -p docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs
```

Expected: command exits 0. No output.

- [ ] **Step 2: Verify the directory exists**

Run:
```bash
ls -d docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs
```

Expected: prints the path.

---

### Task 3: Draft the rewritten issue #1 body

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md`

- [ ] **Step 1: Write the file with the exact content below**

Write the following content to `docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md`:

````markdown
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
3. The **4 constraints** — particularly the API-shape principle (overload vs new methods) and fail-open audit writes.
4. The **audience definition** — is descent-app the right primary, with OSS deferred?
5. The **success criteria** — are these the right five, or are we measuring the wrong things?

Once confirmed, this issue becomes the rubric against which every implementation issue is evaluated.

---

## Related

- Design doc capturing the refinement reasoning: [`docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md)
- [drunikbe/descent-app#342](https://github.com/drunikbe/descent-app/issues/342) — JobProgress fallback approach in the consumer
- [drunikbe/descent-app#343](https://github.com/drunikbe/descent-app/issues/343) — descent-app tracking issue for raw-SQL removal

pg-boss issues that justify individual goals and non-goals are cited inline in their respective sections.
````

- [ ] **Step 2: Verify the file exists with non-zero size**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md
```

Expected: 100+ lines.

---

### Task 4: Draft the summary comment for issue #1

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md`

- [ ] **Step 1: Write the file with the exact content below**

Note: the `STUB_NUMBERS_HERE` token will be replaced in Task 21 once the sub-issues are created. The token is intentionally a placeholder *in this staging file*; the real comment text will be substituted before posting.

Write the following content to `docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md`:

````markdown
## Refinement: structure update — 2026-05-20

This issue has been refined to a clearer 9-goal structure, four explicit constraints, and a 12-sub-issue split for per-feature implementation. The full reasoning — diagnostic of the prior framing, the orthogonality decisions, the rename history, and the verification of pg-boss's actual behavior — lives in the committed design doc:

📄 [Design doc: `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`](https://github.com/elfensky/pg-bossier/blob/main/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md)

### Headline changes from the prior framing

- **Goal 1 (audit table)** split out from the prior "operational data plane" bundle as its own discrete goal.
- **Goal 2 (terminal-state detail)** replaces the prior 5-value failure-class enum with a `terminal_state` (pg-boss's three real terminal values — `completed` / `cancelled` / `failed`) + `terminal_detail` (JSONB, discriminated union; `class` field mandated for `failed`).
- **Goal 3 (retry history)** renamed from the prior "lineage" — disambiguated from data lineage / provenance.
- **Goal 4 (optional input-snapshot)** — new goal: opt-in JSONB slot for consumer-supplied data-provenance.
- **Goal 5 (new APIs)** renamed from "typed query API"; body distinguishes read methods (always new pg-bossier methods; some overlap pg-boss built-ins and name a differentiator) from write extensions (deferred per-feature).
- **Goal 6 (persistent progress)** unified into one mechanism with two documented usage patterns (resumable + non-resumable).
- **Goal 7 (lifecycle events)** clarified relative to pg-boss's existing "pub/sub" feature (which is queue fan-out, not real-time events) and pg-boss#570 (declined upstream). Verified by source-search that pg-boss does NOT use Postgres LISTEN/NOTIFY today.
- **Goal 8 (compatibility tier system)** unchanged from the prior framing.
- **Goal 9 (install/uninstall)** retained from the prior framing.
- **pg-boss baseline corrected.** The prior framing assumed a `pgboss.archive` table and `expired` / `superseded` job states; pg-boss 12 has neither (verified against pg-boss 12.18.2 source). Goal 8's transitional surface now names `pgboss.job` only; Goal 2 treats `expired` / `superseded` as pg-bossier-derived refinements, not pg-boss states.

### Three constraints made explicit in the body, plus the bounded-retention non-goal

- Constraint: audit writes are fail-open (never block pg-boss).
- Constraint: per-event overhead has a published budget.
- Constraint: API-shape principle — composition, not replacement; each write feature explores both overload-pg-boss and new-pg-bossier-method shapes.
- Non-goal added: bounded retention (consumer-owned — pg-bossier writes forever).

### Sub-issues opened

Per-goal implementation (9):

- STUB_NUMBERS_HERE

Cross-cutting (3):

- STUB_NUMBERS_HERE

Each sub-issue references this issue as its rubric. Per the original framing: anything not justifiable against the goals / non-goals here gets closed with a reference to this issue.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md
```

Expected: 30+ lines.

---

### Task 5: Draft stub for Goal 1 (Forensic audit table)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/01-audit-table.md`

- [ ] **Step 1: Write the file with the exact content below**

Note: the stub's *title* lives outside the body (passed to `gh issue create --title`); the body file contains only the body markdown. The title will be applied in Task 21.

**Title (for reference, applied later):** `Goal 1: Forensic audit table — schema, capture mechanism, write semantics`

Body file content:

````markdown
## Purpose

Decide pg-bossier's forensic audit table schema and capture mechanism. The table preserves every pg-boss state change forever, surviving pg-boss's in-place row deletion — the `deletion_seconds`-driven `DELETE` and the `DELETE`+`INSERT` cycle pg-boss runs on every retry.

## Parent

Sub-issue of #1 (Goal 1 — Permanent job history). Rubric for this issue is the goals / non-goals / constraints in #1.

## Decisions to make

- **Table schema.** Column set, types, indexes, constraints. Must accommodate `terminal_state` + `terminal_detail` (Goal 2), retry-history links (Goal 3), `input_snapshot` (Goal 4), and progress data (Goal 6).
- **Capture mechanism.** Postgres trigger on `pgboss.job` (database-side), app-level hook from pg-bossier's wrapping client (application-side), or both. Trade-off: trigger captures every state change including ones pg-bossier didn't initiate; app hook misses out-of-band changes but is easier to test.
- **Write semantics.** Confirmed in #1 as fail-open (audit failure never blocks pg-boss). This sub-issue confirms HOW — try-catch in app-side, defaults / exception suppression on trigger-side.
- **Transaction interaction.** pg-boss 12 lets consumers run a queue op inside an ORM transaction (`boss.send(q, data, { db: fromPrisma(tx) })`). "Fail-open / never block" implies the audit write happens *outside* that transaction — so a rolled-back op can still leave an audit row. Decide whether that inconsistency is acceptable or whether audit writes opt into the caller's transaction when one is supplied.
- **Forensic preservation.** The audit row must survive pg-boss's eventual DELETE of the source job. Verify no foreign-key from audit to `pgboss.job` (else CASCADE would defeat the purpose).
- **Indexes.** Likely indexes on `(job_id)`, `(queue, state, created_at)`, `(terminal_state)`. Confirm against expected query patterns from Goal 5.

## Out of scope

- The shape of `terminal_detail` (Goal 2 sub-issue).
- The retry-history column shapes (Goal 3 sub-issue).
- The exact backfill strategy (cross-cutting sub-issue).
- The numeric per-event performance budget (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope. This stub exists for visibility.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/01-audit-table.md
```

Expected: 20+ lines.

---

### Task 6: Draft stub for Goal 2 (Terminal-state detail)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/02-terminal-detail.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 2: Terminal-state detail — discriminated-union shape, worker signaling, class mandate`

Body file content:

````markdown
## Purpose

Decide the structure of `terminal_detail`, the worker signaling protocol for populating it, and the enforcement of the `class` field for failed jobs.

## Parent

Sub-issue of #1 (Goal 2 — Typed terminal-state detail capture).

## Decisions to make

- **Discriminated-union shape per `terminal_state`.** `terminal_state` carries only pg-boss's three real terminal values — `completed` / `cancelled` / `failed` (pg-boss 12 has no `expired` / `superseded` state). Confirm or refine:
  - `completed` → typically empty or `{ summary?: string }`
  - `failed` → `{ class: 'transient' | 'non_retryable', message?, where?, code?, [k]: unknown }` — `class` is mandated. When the failure was a timeout, also carry a pg-bossier-derived `expired` marker, e.g. `{ class, expired: true, deadlineMs?, exceededByMs? }`.
  - `cancelled` → `{ cancelledBy?, reason? }`. When a singleton was displaced by a newer job, carry a pg-bossier-derived `superseded` marker, e.g. `{ reason: 'superseded', supersededByJobId }`.
- **Deriving `expired` / `superseded`.** These are not pg-boss states — pg-bossier reconstructs them from pg-boss columns (timeout markers; singleton policy + the presence of a successor job). Decide the detection rules.
- **Worker signaling protocol.** Per the API-shape principle in #1, prototype both:
  - (a) Overload `boss.fail(id, err, opts)` to accept `opts.detail` / `opts.class`.
  - (b) New `bossier.recordTerminalDetail(id, detail)` method called alongside `boss.fail(id, err)`.
  Document the trade-off and pick one.
- **Storage location** when Goal 1 is not enabled. `pgboss.job.output` JSONB extension, or sidecar `pgbossier.terminal_detail`. Trade-off: `pgboss.job.output` is removed when pg-boss deletes the job row (`deletion_seconds`) and survives the retry `DELETE`+`INSERT` only because pg-boss's SQL is currently templated to carry it forward; sidecar requires pg-bossier-owned storage but is not exposed to that risk.
- **Validation strictness.** What does pg-bossier do when a worker calls `fail()` without a `class`? Reject (throws), warn (logs and stores `class: 'unknown'`), or quietly default to one value?
- **TypeScript surface.** How does the discriminated union appear to consumers reading audit rows? Tagged union, parsed JSONB with type guards, etc.

## Out of scope

- The audit table column for `terminal_detail` (Goal 1 sub-issue decides whether it lives there).
- Whether failures across the retry chain reuse the same `terminal_detail` or each attempt gets its own (Goal 3 sub-issue).
- TS generics surface for `Job<TInput, TOutput>` more broadly (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/02-terminal-detail.md
```

Expected: 30+ lines.

---

### Task 7: Draft stub for Goal 3 (Retry history)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/03-retry-history.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 3: Retry history columns — parent/successor links, supersession semantics`

Body file content:

````markdown
## Purpose

Decide the column shapes that link related job attempts (retries, reschedules, singleton supersession) into a reconstructable history. This enables `getRetryHistory(jobId)` to walk the chain across pg-boss's DELETE+INSERT retry path.

## Parent

Sub-issue of #1 (Goal 3 — Retry history tracking).

## Decisions to make

- **Link columns.** Names, types, nullability. Candidates:
  - `parent_attempt_id` UUID — immediately previous attempt, NULL for first
  - `root_job_id` UUID — original job in the chain, self-referential for first
  - `superseded_by_job_id` UUID — set on the older row when singleton supersession occurs
- **Population rules.** When pg-boss retries, pg-bossier's capture hook must read the previous row and set `parent_attempt_id` / inherit `root_job_id`. Confirm the hook timing (pre-INSERT vs post-INSERT trigger semantics; or app-side wrap).
- **Supersession semantics.** When a singleton job is replaced, what happens to the older row?
  - Mark with `superseded_by_job_id`, leave state as-is (e.g., `created`)?
  - Or set `terminal_state = 'superseded'` and add `terminal_detail.supersededByJobId`?
  - Trade-off: redundancy vs missing-information when only one is populated.
- **Reconstruction query.** Recursive CTE walking `parent_attempt_id` to root. Confirm performance characteristics with realistic data sizes (a job with 10 retries shouldn't trigger a table scan).
- **`getRetryHistory(jobId)` return shape.** Array of audit rows? Tree structure? Time-ordered list? (Affects Goal 5 method-signature decision.)

## Out of scope

- The audit table itself (Goal 1).
- `terminal_detail.supersededByJobId` shape (Goal 2 sub-issue, if we go that route).
- Worker identity tracking across retries (Goal 5 / `getActiveWorkers` sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/03-retry-history.md
```

Expected: 25+ lines.

---

### Task 8: Draft stub for Goal 4 (Input-snapshot)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/04-input-snapshot.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 4: Input-snapshot slot — opt-in JSONB column, consumer-defined shape, typed reader`

Body file content:

````markdown
## Purpose

Decide the structure and population API for the opt-in `input_snapshot` slot — a consumer-defined "what data did this job consume" manifest preserved alongside the job.

## Parent

Sub-issue of #1 (Goal 4 — Optional input-snapshot capture).

## Decisions to make

- **Column placement.** On the audit table (`pgbossier.job_audit.input_snapshot`) when Goal 1 is enabled, or on `pgboss.job.data` as a known sub-key when Goal 1 is not enabled. Confirm both paths.
- **Population API.** Per the API-shape principle in #1, prototype both:
  - (a) Overload `boss.send(queue, data, opts)` to accept `opts.inputSnapshot`.
  - (b) New `bossier.recordInputSnapshot(jobId, snapshot)` called by the worker at job start.
  Document the trade-off and pick one.
- **Typed reader.** `bossier.getInputSnapshot(jobId)` returns `unknown` (consumer decides shape) or `T extends JsonValue` (typed via generics).
- **Indexing.** GIN index on the JSONB column for arbitrary-shape queries, expression indexes on common consumer-defined fields, or no indexing (consumer-owned)?
- **Size limits.** What if a consumer tries to store a 10MB snapshot? Hard limit, warn, or unbounded with documentation note?

## Out of scope

- The semantics of *what* the snapshot should contain — that's consumer-owned (intentional non-goal in #1).
- pg-bossier auto-capture of consumed data — explicit non-goal.
- The audit table existence (Goal 1).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/04-input-snapshot.md
```

Expected: 20+ lines.

---

### Task 9: Draft stub for Goal 5 (New APIs)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/05-new-apis.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 5: New APIs — operational read method signatures, TS generics surface`

Body file content:

````markdown
## Purpose

Decide the exact signatures, return types, and surface of pg-bossier's new operational read methods. These replace the raw SQL queries descent-app currently runs against `pgboss.*`.

## Parent

Sub-issue of #1 (Goal 5 — New APIs).

## Decisions to make

- **Method signatures.** Confirm or refine names, parameters, return types for each:
  - `peek(queue: string, opts?: { limit?: number }) → Promise<Job<TInput>[]>` — show queued jobs without dequeuing
  - `findById<TInput, TOutput>(id: string) → Promise<Job<TInput, TOutput> | null>`
  - `listActive(opts?: { queue?: string, limit?: number, offset?: number }) → Promise<Job[]>`
  - `listStalled(opts?: { queue?: string, beyond?: number }) → Promise<Job[]>` — jobs past visibility timeout
  - `getRetryHistory(jobId: string) → Promise<AuditRow[]>` — full retry / supersession chain
  - `getActiveWorkers(opts?: { queue?: string }) → Promise<WorkerInfo[]>`
  - `count(queue: string, state?: JobState) → Promise<number>` / state-bucket counts
- **Overlap with pg-boss built-ins — name each method's differentiator.** pg-boss 12 already ships partial coverage; "always new APIs" is not true:
  - `findById` vs pg-boss `findJobs(name, opts)` — pg-boss can look up by id but *requires the queue name*. pg-bossier's `findById(jobId)` resolves across queues; the cross-queue lookup is the value-add.
  - state-bucket counts vs pg-boss `getQueueStats` / `getQueues` — pg-boss returns `deferred` / `queued` / `active` / `total` per queue, but no `failed` / `completed` counts and no cross-queue rollup. pg-bossier completes the set.
  - `getActiveWorkers` vs pg-boss `getWipData()` — pg-boss exposes worker WIP, but only for the *current Node process*. pg-bossier's value-add is real only if it gives cross-instance visibility — commit to that or drop the method.
  - `listStalled` — pg-boss now *resolves* stalled jobs itself (`heartbeatSeconds` + `failJobsByHeartbeat`) but exposes no read API for "what is stuck right now". The read shape is net-new; the resolution mechanism is upstream's.
  - `peek`, `getRetryHistory` — fully net-new; pg-boss has nothing comparable.
- **TS generics surface.** Where do `TInput` / `TOutput` types come from? Registered per-queue, inferred from a worker's handler, declared inline at call site? (Coordinate with the cross-cutting TS-generics sub-issue.)
- **Worker identity model.** What is a "worker" for `getActiveWorkers()` — pg-boss's internal `workId` UUIDs, OS process info, custom registration via pg-bossier hooks?
- **Pagination shape.** `limit`+`offset`, cursor-based, or first-class page tokens? Trade-off: simplicity vs scale.
- **Live vs historical reads.** Does `findById` read from `pgboss.job`, fall back to `pgbossier.job_audit`? (pg-boss 12 has no `archive` table.) Define the lookup order and what counts as "found".
- **Connection pooling.** Reuse pg-boss's pool, take its own, both?

## Out of scope

- Write-side methods — terminal_detail (Goal 2), input_snapshot (Goal 4), progress (Goal 6), and lifecycle event subscription (Goal 7) are decided in their own goals.
- The audit table schema (Goal 1).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/05-new-apis.md
```

Expected: 30+ lines.

---

### Task 10: Draft stub for Goal 6 (Persistent progress)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/06-progress.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 6: Persistent progress API — storage location, retry-survival semantics`

Body file content:

````markdown
## Purpose

Decide the storage location, write API, and read API for pg-bossier's persistent progress slot. One mechanism that supports both resumable-job and non-resumable-job usage patterns (consumer chooses semantics).

## Parent

Sub-issue of #1 (Goal 6 — Persistent job progress).

## Decisions to make

- **Storage location.** Survives pg-boss's DELETE+re-INSERT retry path. Candidates:
  - Sidecar table `pgbossier.job_progress` keyed by `(queue, original_job_id)` so it survives the per-attempt INSERT churn.
  - Audit table column updated by each attempt.
  - `pgboss.job.output` — but note this survives the retry `DELETE`+`INSERT` only because pg-boss's `failJobs` SQL is currently templated to carry `output` forward; it is one upstream SQL change from silently dropping progress. Weigh this against the sidecar option.
  - Extension to pg-boss via `touch()` carrying a `data` parameter (architectural alternative — see #1's API-shape principle).
- **Write API.** Per API-shape principle in #1, prototype both:
  - (a) Overload `boss.touch(jobId, opts)` to accept `opts.progress`.
  - (b) New `bossier.setProgress(jobId, progress)` called by the worker.
  Document trade-off, pick one.
- **Shape.** JSONB, consumer-defined. Document the resumable / non-resumable usage patterns from #1 with examples.
- **Retry-resume semantics.** On retry, what does the worker see when calling `getProgress(jobId)`? The previous attempt's value? The root attempt's value? The most recent value across all attempts in the chain?
- **Cleanup.** When a job reaches a terminal state (`completed` / `failed` / etc.), is the progress slot retained, cleared, or moved to the audit table? Trade-off: storage vs forensic continuity.

## Out of scope

- The audit table existence (Goal 1).
- Retry-history reconstruction (Goal 3).
- TypeScript generics surface for the progress payload (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/06-progress.md
```

Expected: 30+ lines.

---

### Task 11: Draft stub for Goal 7 (Lifecycle events)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/07-lifecycle-events.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 7: Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY), payload schema`

Body file content:

````markdown
## Purpose

Decide the publication mechanism and event payload schema for pg-bossier's lifecycle events. Consumers subscribe to job state transitions (`created` / `started` / `completed` / `failed` / `cancelled` / `retried` — mapped to pg-boss's actual six-state machine; `expired` / `superseded` are derived refinements in the payload, not separate event types) instead of polling.

## Parent

Sub-issue of #1 (Goal 7 — Lifecycle event API).

## Note on prior art

Verified against pg-boss 12.18.2 source: pg-boss does NOT use Postgres LISTEN/NOTIFY (workers poll). pg-boss's "pub/sub" API is queue fan-out, not real-time events. pg-boss#570 (request for job lifecycle events upstream) was declined `not planned`. This sub-issue's solution will be net-new. pg-boss's `persistWarnings` option (emit + optionally persist to a `warning` table) is the closest prior-art pattern. The maintainer's stated concerns when declining #570 — events are instance-bound (don't cross Node processes) and an internal event table can bottleneck high-volume job processing — directly shape the mechanism and performance-budget decisions below.

## Decisions to make

- **Mechanism.** In-process EventEmitter, Postgres `LISTEN/NOTIFY` on pg-bossier-owned channels, or both.
  - Trade-off: in-process is simplest, single-process only; LISTEN/NOTIFY enables cross-process subscribers but requires long-lived connections.
- **Channel namespacing** (if LISTEN/NOTIFY chosen). Must be `pgbossier_*` prefix per constraint in #1.
- **Event names and payload schema.** Tagged union per event type, or one event with `type` field? Payload fields per type (`job_id`, `queue`, `terminal_state`, `terminal_detail`, etc.).
- **Subscription API.** `bossier.on('job.failed', handler)` event-name strings, or typed `bossier.events.failed.subscribe(handler)`? Trade-off: discoverability vs type-safety.
- **At-least-once vs at-most-once semantics.** If a subscriber is offline when an event fires, is it lost? (Goal 1 enabled → recoverable from audit table; without Goal 1 → ephemeral.)
- **Ordering guarantees.** Are events delivered in causal order? Per-job order is required; cross-job ordering may not be.

## Out of scope

- The audit table (Goal 1) — events fire regardless.
- Whether to ship OpenTelemetry exporters (explicit non-goal in #1).
- The shape of `terminal_detail` carried in `failed` events (Goal 2).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/07-lifecycle-events.md
```

Expected: 30+ lines.

---

### Task 12: Draft stub for Goal 8 (Compatibility tier)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/08-compatibility-tier.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 8: pg-boss compatibility tier doc + CI matrix definition`

Body file content:

````markdown
## Purpose

Produce the compatibility tier document and CI matrix configuration that make pg-bossier's "stay close to pg-boss" promise enforceable.

## Parent

Sub-issue of #1 (Goal 8 — pg-boss compatibility tier system).

## Decisions to make

- **Stable tier membership.** Confirm the full list of pg-boss public API methods pg-bossier depends on: `send`, `fetch`, `complete`, `fail`, `work`, `touch`, `cancel`, `start`, `stop`, `findJobs`, `getQueueStats`, `getWipData`, others? Each named in the tier doc. pg-boss's ORM transaction adapters (`fromKnex` / `fromKysely` / `fromPrisma` / `fromDrizzle`) also need a tier — Stable for the function names, Transitional for the ORM-version-coupled wrapped types.
- **Transitional tier membership.** Confirm the list of `pgboss.*` tables / columns pg-bossier reads from: `pgboss.job` columns, `pgboss.queue` columns (if any), the schema version. Note: pg-boss 12 has **no `pgboss.archive` table** — do not list one.
- **Forbidden tier enumeration.** Which pg-boss internals are explicitly off-limits? Anything in `node_modules/pg-boss/src/*`, undocumented events, private SQL not in the public docs, and the `pgboss.bam` table and other internal maintenance machinery.
- **CI matrix config.** Supported pg-boss version set: latest + N-1 + N-2 minors, or some other window? Test runner integration (which pg-boss versions get installed in which CI jobs).
- **Detection of forbidden-tier violations.** Lint rule? Static analysis? Manual review checklist?
- **Cadence for updating the tier doc.** Updated on every pg-bossier PR that touches pg-boss APIs? Or on a separate audit cadence?
- **Definition of "supported within ~2 weeks".** Is "within 2 weeks of upstream publication" measured by: PR opened, PR merged, npm-published? Confirm.

## Out of scope

- Implementation details of how each goal uses pg-boss APIs (that's per-goal-sub-issue).
- Numeric per-event performance budget (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/08-compatibility-tier.md
```

Expected: 25+ lines.

---

### Task 13: Draft stub for Goal 9 (Install/uninstall)

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/09-install-uninstall.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Goal 9: Install/uninstall surface — migration tooling, distribution shape, Prisma coexistence`

Body file content:

````markdown
## Purpose

Decide the install + uninstall surface — distribution shape, migration tooling, and Prisma coexistence — that delivers the <1hr-install / clean-uninstall promise.

## Parent

Sub-issue of #1 (Goal 9 — One-step install, symmetric uninstall).

## Decisions to make

- **Distribution shape.** Single npm package, monorepo with main + adapters, or separate Prisma adapter? Each affects the install experience.
- **Migration tooling.** Raw SQL file the user runs with `psql`, custom Node script (`npx pg-bossier migrate`), Prisma migration consumers compose into their migration history, or some combination. Trade-offs: idempotency, Prisma coexistence, re-runnability, rollback support.
- **Idempotency.** Should the install migration be safe to re-run? Modern migrations usually are.
- **Schema name.** Confirm `pgbossier` as the schema name. Allow override via config?
- **Uninstall command / docs.** Ship `npx pg-bossier uninstall` CLI that runs `DROP SCHEMA pgbossier CASCADE`, or document the SQL only?
- **Versioning across pg-bossier upgrades.** When pg-bossier 0.3 changes the audit schema, how does an existing 0.2 install migrate? Forward-only with breaking-change docs, or rollback-capable?
- **Symmetric-uninstall verification.** What does CI assert to verify "uninstall leaves zero pgbossier remnants"? Listing all DB objects in pgbossier schema after CASCADE, checking for orphaned LISTEN/NOTIFY channels, etc.
- **Multi-database / multi-schema.** Does pg-bossier support pg-boss configured against a custom schema? Multiple pg-boss instances in one Postgres database?

## Out of scope

- The audit table schema itself (Goal 1).
- TypeScript generics surface (cross-cutting sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/09-install-uninstall.md
```

Expected: 25+ lines.

---

### Task 14: Draft cross-cutting stub: Backfill strategy

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/10-backfill.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Cross-cutting: backfill strategy for existing pg-boss installs`

Body file content:

````markdown
## Purpose

Decide how the audit table populates when pg-bossier is installed on an existing pg-boss instance that already has millions of historical jobs. Affects Goal 1's adoption story for descent-app and similar consumers.

## Parent

Sub-issue of #1 (cross-cutting — affects Goal 1 implementation).

## Decisions to make

- **Default strategy.** Three candidates:
  - **Capture-from-now.** Audit table starts empty; only state changes after install are captured. Simplest. Forensic queries for pre-install jobs return empty.
  - **Best-effort backfill.** Read `pgboss.job` at install time (pg-boss 12 has no `archive` table), populate audit rows for pre-existing jobs (with sentinel `backfilled: true` in `terminal_detail`). May be slow on large databases. Note: pre-install jobs already removed by pg-boss's `deletion_seconds` cleanup are unrecoverable — backfill only sees rows still present in `pgboss.job`.
  - **Toggleable.** Default to capture-from-now; expose a `bossier.backfill()` method consumers call when they want it.
- **Backfill semantics.** When backfilling, what's the `terminal_state` for jobs pg-boss hasn't fully resolved yet (`created` / `active` / `retry`)? Live state, or "as-of install time"?
- **Backfill performance.** Streaming inserts vs batch? Throttle / chunk size? Lock impact on `pgboss.job` during backfill?
- **User communication.** Docs, CLI output, or migration log about what happened during install (especially how much was backfilled).
- **Interaction with Goal 8 perf budget.** Backfill is one-time; should it count against the per-event budget, or is it exempted?

## Out of scope

- The audit table schema (Goal 1 sub-issue).
- pg-bossier upgrade migrations between versions (Goal 9 sub-issue).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/10-backfill.md
```

Expected: 25+ lines.

---

### Task 15: Draft cross-cutting stub: Performance budget

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/11-performance-budget.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Cross-cutting: performance budget — numeric per-event overhead target`

Body file content:

````markdown
## Purpose

Set the numeric per-event overhead budget that gives "stay close to pg-boss" (Goal 8) enforceable teeth. Without a number, the constraint in #1 is unenforceable.

## Parent

Sub-issue of #1 (cross-cutting — gives Goal 8's "stay close" constraint enforceable teeth; budgets every other goal's implementation).

## Decisions to make

- **Budget unit.** Absolute (e.g., "audit write must complete in <2ms p99") or relative (e.g., "<10% overhead vs pg-boss baseline")?
- **Numeric target.** Concrete value(s). Suggested anchors:
  - Audit-write overhead: target <2ms p99 per job state change
  - Event emission overhead: target <1ms p99
  - Read-path overhead: targets per method (`findById` <5ms p99, `listActive` <50ms p99 for 1000-job result, etc.)
- **Measurement methodology.** How does CI measure these — synthetic benchmarks against a fresh Postgres, or production-shape workloads?
- **Budget violation policy.** Hard block on PR? Warn-only with merge override? Tied to release process?
- **Per-feature budget allocation.** Each goal's implementation gets a fraction of total overhead budget. Confirm the split.
- **Reporting cadence.** Is the performance dashboard updated per-PR, per-release, or on a separate cadence?

## Out of scope

- The actual performance optimizations to achieve the budget (per-goal sub-issues).
- Test-coverage targets (separate operational concern).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/11-performance-budget.md
```

Expected: 25+ lines.

---

### Task 16: Draft cross-cutting stub: TypeScript generics surface

**Files:**
- Create: `docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/12-ts-generics.md`

- [ ] **Step 1: Write the file with the exact content below**

**Title (applied later):** `Cross-cutting: TypeScript generics surface — Job<TInput, TOutput> pattern`

Body file content:

````markdown
## Purpose

Decide how consumers parameterize types for their job payloads. Affects every method in Goal 5 that returns a `Job`, plus progress (Goal 6) and event payload (Goal 7) types.

## Parent

Sub-issue of #1 (cross-cutting — most affects Goal 5; also Goals 6 and 7).

## Decisions to make

- **Pattern.** Choose one (or a hybrid):
  - **Inline declaration.** `bossier.findById<MyInput, MyOutput>(id)` — explicit at call site. Simple, no setup, but verbose for repeated reads.
  - **Type registration.** `bossier.register('my-queue', { input: MyInput, output: MyOutput })`, then `bossier.findById(id)` infers from the queue. Less verbose, more setup.
  - **Inference from worker.** When a worker is registered via `boss.work('my-queue', handler)`, the handler's signature defines the types. Reads against that queue inherit. Requires runtime registration order discipline.
  - **Declaration merging / module augmentation.** Consumers declare their queues in a TS module that pg-bossier merges into. Type-only, no runtime cost.
- **Default type.** When the consumer hasn't parameterized, what's the type of `Job<TInput, TOutput>`? `Job<unknown, unknown>`? `Job<JsonValue, JsonValue>`? `Job<any, any>` (worst, but easiest)?
- **Backward compatibility.** JS consumers calling the same methods see plain method calls without compile-time checks. Confirm the .d.ts surface supports this.
- **Interaction with terminal_detail / progress / input_snapshot.** Are *those* JSONB shapes also generic-parameterizable? Trade-off: full type safety vs surface complexity.
- **Documentation strategy.** Where do consumers learn the pattern? README, tsdoc, separate types-guide doc?

## Out of scope

- The method signatures themselves (Goal 5 sub-issue).
- Storage schema (Goal 1).

## Blocked by

#1 — pending agreement on the refined scope.
````

- [ ] **Step 2: Verify the file exists**

Run:
```bash
wc -l docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/12-ts-generics.md
```

Expected: 25+ lines.

---

### Task 17: Update `CLAUDE.md` to reflect the new structure

**Files:**
- Modify: `CLAUDE.md`

The current `CLAUDE.md` has a goal list reflecting the *prior* framing. Update the relevant sections to match the refined 9-goal structure, four constraints, and 12-sub-issue split.

- [ ] **Step 1: Read the current `CLAUDE.md`**

Run:
```bash
wc -l CLAUDE.md
```

Note the line count for later verification.

- [ ] **Step 2: Replace the "What pg-bossier is" section**

In `CLAUDE.md`, locate the `## What pg-bossier is` heading and replace the section content (everything between that heading and the next `##` heading) with:

```markdown
## What pg-bossier is

A **JS/TS library that layers on top of [pg-boss](https://github.com/timgit/pg-boss)** to provide an **operational data plane** — capabilities pg-boss has explicitly declined to take on. Nine concrete goals:

1. **Permanent job history.** `pgbossier.job_audit` populated automatically, surviving pg-boss's in-place row deletion (the `deletion_seconds` `DELETE` and the retry `DELETE`+`INSERT`).
2. **Typed terminal-state detail.** `terminal_state` (pg-boss's three terminal values — `completed` / `cancelled` / `failed`) + `terminal_detail` (JSONB discriminated by state; `class` mandated when `failed`; `expired` / `superseded` are pg-bossier-derived markers, not pg-boss states). One typed read answers "why did this fail?" without string-matching error text.
3. **Retry history tracking.** Parent/successor links across retries, reschedules, singleton supersession. `getRetryHistory(jobId)` walks the chain.
4. **Optional input-snapshot capture.** Opt-in JSONB slot for consumer-supplied "what data did this job see" manifests. Pg-bossier preserves; consumers define shape.
5. **New APIs.** Operational read methods (`peek` / `findById` / `listActive` / `listStalled` / `getRetryHistory` / `getActiveWorkers` / state-counts). pg-boss 12 partially covers some (`findJobs` / `getQueueStats` / `getWipData`) — the Goal 5 sub-issue names each method's differentiator. Write extensions for Goals 2/4/6 are deferred per-feature per the API-shape principle.
6. **Persistent job progress.** One mechanism that survives DELETE+re-INSERT. Two usage patterns from the same slot: resumable (position) and non-resumable (display). Worker decides whether to use the persisted value on retry.
7. **Lifecycle event API.** Event emission on every state transition (in-process EventEmitter and/or `LISTEN/NOTIFY` on `pgbossier_*` channels). Maps to pg-boss#570 (declined upstream). Distinct from pg-boss's "pub/sub" feature (which is queue fan-out, not real-time events).
8. **pg-boss compatibility tier system.** Stable / Transitional / Forbidden classification + CI matrix.
9. **One-step install, symmetric uninstall.** One dependency + one migration + `DROP SCHEMA pgbossier CASCADE` for clean removal.

pg-boss stays an **unmodified npm dependency** — pg-bossier extends it, never replaces it.
```

- [ ] **Step 3: Replace the "Non-negotiable boundaries" section with the updated constraints set**

In `CLAUDE.md`, locate the `## Non-negotiable boundaries` heading and replace the section content with:

```markdown
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
- **Not introspecting handler behavior.** Goal 4's input-snapshot slot is for *consumer-supplied* data only.
- **Don't become an ORM.** Should work alongside Prisma without depending on it.
- **No bounded retention tooling.** pg-bossier writes to its audit table forever; retention is consumer-owned.
- **Symmetric drop-in.** Adding pg-bossier = one dependency + one migration. Removing it = `DROP SCHEMA pgbossier CASCADE` + uninstall the package.
- **No upstream PR campaign.** We're not trying to land these features in pg-boss itself.

### Constraints (load-bearing rules every implementation must respect)

- **Audit writes are fail-open.** pg-bossier failures never block pg-boss operations. Default: log and continue.
- **Per-event overhead has a published budget.** Decided in the cross-cutting performance-budget sub-issue. Exceeding the budget blocks release.
- **API-shape principle: composition, not replacement.** Read methods (Goal 5) are always new pg-bossier methods, not overloads of pg-boss methods. Write extensions (Goals 2, 4, 6) prototype both (a) overload pg-boss method via new options and (b) new sibling pg-bossier method, then document the trade-off and pick one per feature.
```

- [ ] **Step 4: Replace the "What's deliberately undecided" table with the updated sub-issue split**

In `CLAUDE.md`, locate the `## What's deliberately undecided` heading and replace the section content (the prose paragraph + table) with:

```markdown
## What's deliberately undecided

Each decision below is its own GitHub issue. Sub-issues opened during the issue #1 refinement:

**Goal implementation issues (one per goal):**

| Sub-issue | Goal |
|---|---|
| Forensic audit table — schema, capture mechanism, write semantics | Goal 1 |
| Terminal-state detail — discriminated-union shape, worker signaling, `class` mandate | Goal 2 |
| Retry history columns — parent/successor links, supersession semantics | Goal 3 |
| Input-snapshot slot — opt-in JSONB column, consumer-defined shape | Goal 4 |
| New APIs — operational read method signatures, TS generics surface | Goal 5 |
| Persistent progress API — storage location, retry-survival semantics | Goal 6 |
| Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY), payload schema | Goal 7 |
| pg-boss compatibility tier doc + CI matrix definition | Goal 8 |
| Install/uninstall surface — migration tooling, distribution shape | Goal 9 |

**Cross-cutting issues:**

| Sub-issue | Reason |
|---|---|
| Backfill strategy for existing installs | Affects Goal 1 implementation |
| Performance budget — numeric per-event overhead target | Gives Goal 8's "stay close" enforceable teeth |
| TypeScript generics surface — `Job<TInput, TOutput>` pattern | Most affects Goal 5; also Goal 6/7 |

If a task touches one of these and there's no companion issue, open one (or ask the user to) before writing code.
```

- [ ] **Step 5: Correct the "pg-boss compatibility contract" section**

In `CLAUDE.md`, locate the `## pg-boss compatibility contract` heading. This section was written against the prior framing — it references "Goal 4 from issue #1" (the compatibility goal is **Goal 8** in the refined structure) and a `pgboss.archive` table that pg-boss 12 does not have. Make two corrections, leaving the Stable and Forbidden bullets otherwise intact:

1. Change the opening "Goal 4 from issue #1 names..." to "Goal 8 from issue #1 names...".
2. In the **Transitional** bullet, change "Reads against `pgboss.job` and `pgboss.archive` schemas." to "Reads against the `pgboss.job` table (pg-boss 12 has no `archive` table — job rows are deleted in place by `deletion_seconds`)."

This keeps the contract consistent with the refined Goal 8 numbering and the corrected pg-boss baseline. If the surrounding `CLAUDE.md` text elsewhere mentions `pgboss.archive` or "archive→delete", correct those too — `grep -n 'archive' CLAUDE.md` to find them.

- [ ] **Step 6: Verify the changes parse and the file is still well-formed**

Run:
```bash
wc -l CLAUDE.md
grep -c '^## ' CLAUDE.md
grep -n 'archive' CLAUDE.md
```

Expected: line count is comparable to before (within ±50 lines). The `^## ` count should match the previous count if you replaced sections one-for-one (or be slightly different if the structure shifted intentionally). The `archive` grep should return only intentional mentions — no surviving `pgboss.archive` or "archive→delete" claims.

Visually scan the file:
```bash
grep -n '^## \|^### ' CLAUDE.md
```

Expected: section headings appear in a sensible order, no orphan headings.

---

### Task 18: Verify all draft files exist

**Files:** none modified.

- [ ] **Step 1: List the staging tree and confirm all expected files are present**

Run:
```bash
find docs/superpowers/plans/2026-05-20-issue-1-refinement -type f | sort
```

Expected output (15 files total):
```
docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/01-audit-table.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/02-terminal-detail.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/03-retry-history.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/04-input-snapshot.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/05-new-apis.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/06-progress.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/07-lifecycle-events.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/08-compatibility-tier.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/09-install-uninstall.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/10-backfill.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/11-performance-budget.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/stubs/12-ts-generics.md
docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md
```

If any file is missing, return to its drafting task before continuing.

- [ ] **Step 2: PAUSE here for user review**

This is the natural review point. The user reads `issue-1-body.md`, the 12 stub bodies, the `summary-comment.md`, and the `CLAUDE.md` diff (via `git diff CLAUDE.md`). They confirm or request changes. Do not proceed to Task 19 until the user has signed off.

---

### Task 19: Commit local changes

**Files:**
- Modify: git repo HEAD

- [ ] **Step 1: Verify the design doc is not yet tracked**

Run:
```bash
git status --porcelain docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md
```

Expected: `?? docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md` (untracked) OR a blank line (already tracked). Both are valid.

- [ ] **Step 2: Stage all the refinement artifacts**

Run:
```bash
git add CLAUDE.md
git add docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md
git add docs/superpowers/plans/2026-05-20-issue-1-refinement-plan.md
git add docs/superpowers/plans/2026-05-20-issue-1-refinement/
```

- [ ] **Step 3: Verify the staged changes**

Run:
```bash
git status
```

Expected: the four paths above are staged. Other untracked files (`.gitignore`, `package.json`, `src/`, etc.) remain untracked (they'll be committed separately by the user).

- [ ] **Step 4: Create the commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
docs: refine issue #1 — restructure to 9 goals + 4 constraints + 12 sub-issues

Applies the design from docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md.

Changes:
- Add design doc capturing the diagnostic, decisions, and rationale
- Add implementation plan with staged drafts for issue #1 body, 12 sub-issue stubs, and summary comment
- Update CLAUDE.md to reflect the refined 9-goal structure, 4 constraints, and sub-issue list

Headline structural changes:
- Goal 1 (audit table) split from prior 'operational data plane' bundle
- Goal 2 (terminal-state detail) replaces 5-value failure enum with terminal_state + JSONB terminal_detail
- Goal 3 (retry history) renamed from 'lineage' (disambiguated from data lineage)
- Goal 4 (input-snapshot, opt-in) — new goal for consumer-supplied data provenance
- Goal 5 (new APIs) renamed from 'typed query API'; reads name per-method differentiators vs pg-boss built-ins, writes deferred per-feature
- Goal 6 (progress) unified into one mechanism with two usage patterns
- Goal 7 (lifecycle events) clarified vs pg-boss's pub/sub (queue fan-out, not real-time)
- Goal 9 (install/uninstall) retained
- 3 constraints made explicit (fail-open writes / overhead budget / API-shape principle) + bounded-retention added to non-goals
- pg-boss baseline corrected vs pg-boss 12.18.2: no pgboss.archive table, 3 terminal states not 5, partial pg-boss overlap named for Goal 5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Verify the commit landed**

Run:
```bash
git log -1 --stat
```

Expected: the commit is HEAD with the four paths listed in the stat output. The shortlog should match the message above.

---

### Task 20: Push to remote

**Files:** none modified locally.

- [ ] **Step 1: Verify the current branch tracks origin**

Run:
```bash
git branch -vv | grep '^\*'
```

Expected: the current branch (likely `main`) shows `[origin/main: ...]`. If not, configure tracking before pushing.

- [ ] **Step 2: Push**

Run:
```bash
git push origin HEAD
```

Expected: push succeeds. The commit lands on origin's branch. No prompts for credentials (already authenticated via `gh`).

- [ ] **Step 3: Verify the design doc is now accessible on GitHub**

Run:
```bash
gh api repos/elfensky/pg-bossier/contents/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md --jq '.path'
```

Expected: `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md`. This confirms the GitHub URL referenced in the summary comment will resolve.

---

### Task 21: Create the `blocked-by-issue-1` label

**Files:** none modified locally.

- [ ] **Step 1: Check whether the label already exists**

Run:
```bash
gh label list -R elfensky/pg-bossier --json name --jq '.[] | select(.name == "blocked-by-issue-1") | .name'
```

Expected: empty output (label does not exist). If output is `blocked-by-issue-1`, skip to Task 22.

- [ ] **Step 2: Create the label**

Run:
```bash
gh label create blocked-by-issue-1 \
  --repo elfensky/pg-bossier \
  --description "Stub blocked until issue #1 (Requirements) is agreed and finalized" \
  --color FBCA04
```

Expected output: `✓ Label "blocked-by-issue-1" created in elfensky/pg-bossier`

- [ ] **Step 3: Verify**

Run:
```bash
gh label list -R elfensky/pg-bossier --json name --jq '.[] | select(.name == "blocked-by-issue-1") | .name'
```

Expected: `blocked-by-issue-1`

---

### Task 22: Replace issue #1's body

**Files:** none modified locally.

- [ ] **Step 1: Apply the new body**

Run:
```bash
gh issue edit 1 \
  --repo elfensky/pg-bossier \
  --body-file docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md
```

Expected: `https://github.com/elfensky/pg-bossier/issues/1` (URL of the edited issue).

- [ ] **Step 2: Verify the body was applied**

Run:
```bash
gh issue view 1 -R elfensky/pg-bossier --json body --jq '.body' | head -3
```

Expected: the first line is `## Purpose` (the first heading of the new body).

---

### Task 23: Create all 12 sub-issue stubs

**Files:** none modified locally.

- [ ] **Step 1: Create the 12 stubs in a loop, capturing issue numbers**

Run this loop, which reads each `stubs/NN-name.md` file, extracts the title from the plan's task header (or uses an array), and creates the issue:

```bash
declare -a TITLES=(
  "Goal 1: Forensic audit table — schema, capture mechanism, write semantics"
  "Goal 2: Terminal-state detail — discriminated-union shape, worker signaling, class mandate"
  "Goal 3: Retry history columns — parent/successor links, supersession semantics"
  "Goal 4: Input-snapshot slot — opt-in JSONB column, consumer-defined shape, typed reader"
  "Goal 5: New APIs — operational read method signatures, TS generics surface"
  "Goal 6: Persistent progress API — storage location, retry-survival semantics"
  "Goal 7: Lifecycle event API — mechanism (emitter vs LISTEN/NOTIFY), payload schema"
  "Goal 8: pg-boss compatibility tier doc + CI matrix definition"
  "Goal 9: Install/uninstall surface — migration tooling, distribution shape, Prisma coexistence"
  "Cross-cutting: backfill strategy for existing pg-boss installs"
  "Cross-cutting: performance budget — numeric per-event overhead target"
  "Cross-cutting: TypeScript generics surface — Job<TInput, TOutput> pattern"
)

declare -a FILES=(
  "stubs/01-audit-table.md"
  "stubs/02-terminal-detail.md"
  "stubs/03-retry-history.md"
  "stubs/04-input-snapshot.md"
  "stubs/05-new-apis.md"
  "stubs/06-progress.md"
  "stubs/07-lifecycle-events.md"
  "stubs/08-compatibility-tier.md"
  "stubs/09-install-uninstall.md"
  "stubs/10-backfill.md"
  "stubs/11-performance-budget.md"
  "stubs/12-ts-generics.md"
)

declare -a CREATED_NUMBERS=()
BASE="docs/superpowers/plans/2026-05-20-issue-1-refinement"

for i in "${!TITLES[@]}"; do
  URL=$(gh issue create \
    --repo elfensky/pg-bossier \
    --title "${TITLES[$i]}" \
    --body-file "$BASE/${FILES[$i]}" \
    --label blocked-by-issue-1)
  NUM=$(echo "$URL" | grep -oE '[0-9]+$')
  CREATED_NUMBERS+=("$NUM")
  echo "Created issue #$NUM: ${TITLES[$i]}"
done

echo
echo "All 12 stubs created. Issue numbers (for summary comment):"
printf '  #%s\n' "${CREATED_NUMBERS[@]}"
echo
echo "Save these to a file for Task 24:"
printf '%s\n' "${CREATED_NUMBERS[@]}" > /tmp/pg-bossier-stub-numbers.txt
echo "Saved to /tmp/pg-bossier-stub-numbers.txt"
```

Expected: 12 lines of `Created issue #N: ...`, followed by the saved numbers list. Each issue number is one greater than the previous (assuming no concurrent issue creation). The total time should be ~30s.

If any single issue creation fails (network glitch, label rejection, etc.), the loop continues but the saved list will have a gap. Inspect the output, retry the failing one manually, and update `/tmp/pg-bossier-stub-numbers.txt`.

- [ ] **Step 2: Verify all 12 stubs exist with the correct label**

Run:
```bash
gh issue list -R elfensky/pg-bossier --label blocked-by-issue-1 --state open --json number,title --jq 'length'
```

Expected: `12`

Run:
```bash
gh issue list -R elfensky/pg-bossier --label blocked-by-issue-1 --state open --json number,title --jq '.[] | "\(.number): \(.title)"'
```

Expected: 12 lines, each with a `<number>: <title>` pair matching the TITLES array.

---

### Task 24: Substitute the stub numbers into the summary comment

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md` (in-place replacement of the `STUB_NUMBERS_HERE` placeholders)

- [ ] **Step 1: Read the stub numbers**

Run:
```bash
cat /tmp/pg-bossier-stub-numbers.txt
```

Expected: 12 lines, each a single number.

- [ ] **Step 2: Build the substitution strings**

Goal-implementation lines (first 9 numbers; one per goal) — assume the saved file's lines correspond to stubs 01..09 in order:

```bash
GOAL_LINES=""
GOAL_NAMES=(
  "Goal 1 — Forensic audit table"
  "Goal 2 — Terminal-state detail"
  "Goal 3 — Retry history columns"
  "Goal 4 — Input-snapshot slot"
  "Goal 5 — New APIs"
  "Goal 6 — Persistent progress API"
  "Goal 7 — Lifecycle event API"
  "Goal 8 — pg-boss compatibility tier"
  "Goal 9 — Install/uninstall surface"
)
mapfile -t NUMS < /tmp/pg-bossier-stub-numbers.txt

GOAL_BLOCK=""
for i in {0..8}; do
  GOAL_BLOCK+="- #${NUMS[$i]} — ${GOAL_NAMES[$i]}"$'\n'
done

CROSS_NAMES=(
  "Backfill strategy"
  "Performance budget"
  "TypeScript generics surface"
)
CROSS_BLOCK=""
for i in {0..2}; do
  IDX=$((9 + i))
  CROSS_BLOCK+="- #${NUMS[$IDX]} — ${CROSS_NAMES[$i]}"$'\n'
done

echo "Goal block:"
echo "$GOAL_BLOCK"
echo "Cross-cutting block:"
echo "$CROSS_BLOCK"
```

Expected: two blocks of bullet-pointed `- #N — Description` lines, matching the issues created in Task 23.

- [ ] **Step 3: Substitute into the summary comment file**

Use `awk` to replace the first `STUB_NUMBERS_HERE` placeholder with `$GOAL_BLOCK` and the second with `$CROSS_BLOCK`:

```bash
FILE=docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md
awk -v goals="$GOAL_BLOCK" -v cross="$CROSS_BLOCK" '
  /STUB_NUMBERS_HERE/ {
    if (count == 0) { print goals; count++ }
    else { print cross }
    next
  }
  { print }
' "$FILE" > "${FILE}.new"
mv "${FILE}.new" "$FILE"
```

- [ ] **Step 4: Verify the substitution**

Run:
```bash
grep -n 'STUB_NUMBERS_HERE\|^- #' docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md
```

Expected: zero hits for `STUB_NUMBERS_HERE`; 12 lines matching `^- #` (the 9 goal + 3 cross-cutting bullets).

---

### Task 25: Post the summary comment on issue #1

**Files:** none modified locally.

- [ ] **Step 1: Post the comment**

Run:
```bash
gh issue comment 1 \
  --repo elfensky/pg-bossier \
  --body-file docs/superpowers/plans/2026-05-20-issue-1-refinement/summary-comment.md
```

Expected: a URL to the new comment is printed.

- [ ] **Step 2: Verify the comment was posted**

Run:
```bash
gh issue view 1 -R elfensky/pg-bossier --json comments --jq '.comments | length'
```

Expected: `1` (this is the first comment on issue #1, since it had zero comments before).

Run:
```bash
gh issue view 1 -R elfensky/pg-bossier --json comments --jq '.comments[-1].body' | head -3
```

Expected: the first line is `## Refinement: structure update — 2026-05-20` (the heading of the summary comment).

---

### Task 26: Final verification of GitHub state

**Files:** none modified.

- [ ] **Step 1: Verify issue #1's body matches the staged draft**

Run:
```bash
gh issue view 1 -R elfensky/pg-bossier --json body --jq '.body' > /tmp/issue-1-live.md
diff /tmp/issue-1-live.md docs/superpowers/plans/2026-05-20-issue-1-refinement/issue-1-body.md
```

Expected: no diff output (the live body matches the staged draft).

- [ ] **Step 2: Verify all 12 stubs reference issue #1 in their body**

Run:
```bash
for NUM in $(cat /tmp/pg-bossier-stub-numbers.txt); do
  BODY=$(gh issue view "$NUM" -R elfensky/pg-bossier --json body --jq '.body')
  if echo "$BODY" | grep -q "Sub-issue of #1"; then
    echo "#$NUM: OK"
  else
    echo "#$NUM: MISSING parent reference"
  fi
done
```

Expected: 12 lines of `#N: OK`.

- [ ] **Step 3: Verify the design-doc link in the summary comment resolves**

Run:
```bash
gh api repos/elfensky/pg-bossier/contents/docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md --jq '.path'
```

Expected: `docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md` (the link target exists on the default branch).

- [ ] **Step 4: Print a summary of what was done**

Run:
```bash
echo "Issue #1 refinement applied:"
echo "  - issue #1 body: replaced (per docs/superpowers/specs/2026-05-19-issue-1-refinement-design.md)"
echo "  - sub-issue stubs created: $(wc -l < /tmp/pg-bossier-stub-numbers.txt) (numbers $(paste -sd, /tmp/pg-bossier-stub-numbers.txt))"
echo "  - summary comment posted on issue #1"
echo "  - CLAUDE.md updated to reflect new structure"
echo "  - design doc + plan committed to git and pushed to origin"
echo
echo "Next: per-goal implementation. Each stub is blocked until #1 is agreed; once agreed, start with sub-issue #$(head -1 /tmp/pg-bossier-stub-numbers.txt) (Goal 1: Forensic audit table)."
```

Expected: the summary text above with values substituted in.

---

## Done condition

This plan is complete when:

1. `git log -1` shows the refinement commit.
2. The remote has the commit pushed.
3. `gh issue view 1 -R elfensky/pg-bossier` shows the new body.
4. `gh issue list -R elfensky/pg-bossier --label blocked-by-issue-1` shows 12 open issues.
5. `gh issue view 1 -R elfensky/pg-bossier --json comments --jq '.comments|length'` returns `1`.
6. `CLAUDE.md` reflects the 9-goal structure on the default branch.

---

## Notes for the executor

- **Order matters between Tasks 19 (commit) and Task 25 (summary comment).** The summary comment links to the design doc on the default branch; the design doc has to be pushed to that branch first.
- **Task 18 is a hard PAUSE for user review.** Do not skip it. The 12 stub bodies + the rewritten issue #1 body are substantial content the user needs to sign off on before they go live on GitHub.
- **If Task 23's loop partially fails**, you'll have N issues created (not all 12). Inspect `/tmp/pg-bossier-stub-numbers.txt`, manually create the missing ones, and append their numbers in the correct positions before Task 24.
- **There are no tests to run** because this plan ships no code. Verification is "the GitHub state matches the staged drafts" via `diff` and `gh ... --json ... --jq`.
- **Rollback is mostly manual.** If you need to undo: revert the local commit and force-push (if not yet shared), or revert with a new commit (if shared). For GitHub state: `gh issue edit 1 --body-file <previous-body>` to restore issue #1's body, `gh issue close <N>` for each stub created, and delete the summary comment via the UI (gh CLI doesn't support comment deletion in older versions).

# Round 1 — Goal 3 retry history lineage (pg-bossier)

You are a participant in a structured four-way design debate (Claude Opus, Claude Sonnet, OpenAI Codex, Google Gemini). Two rounds. This is Round 1 — write **independently**, without seeing the other three responses.

## What pg-bossier is

A TypeScript library that layers an **operational data plane** on top of [pg-boss](https://github.com/timgit/pg-boss) (a Postgres-backed job queue). pg-boss is unmodified — used as a normal npm dependency, **never forked, never patched, never reached into**. pg-bossier provides a permanent forensic history of every job through a Postgres `AFTER` trigger that writes each row-version of `pgboss.job` into `pgbossier.record` before pg-boss's natural `DELETE` discards it.

The capture mechanism, the schema, and the basic per-attempt history are **already shipped** (PR #15, v0.1.0, verified against pg-boss 12.18.2).

## Substrate already in place (do not redesign)

- **`pgbossier.record` table**, primary key `(job_id, attempt)`. One row per attempt of every job, never deleted.
- **Capture trigger** on `pgboss.job` fires `AFTER INSERT/UPDATE/DELETE` and writes/upserts into `pgbossier.record`.
- A job has a **single stable `id`** from creation through every retry to its terminal state. pg-boss's retry path is `DELETE`+`INSERT` that **reuses the id**. The capture trigger therefore yields rows `0, 1, 2, …` indexed by pg-boss's `retry_count`.
- **`getRetryHistory(jobId)`** already ships and returns the ordered attempt rows. **Do not redesign it.**
- pg-bossier writes are **fail-open** — must never block pg-boss.
- **Compatibility tiers:** pg-boss's documented public JS API = **Stable**; reads against `pgboss.job` table columns = **Transitional** (tested per pg-boss version); pg-boss internals / private SQL = **Forbidden**.
- Per-event overhead has a published budget (currently ~1ms per state transition). Any proposal that materially regresses it must say so.

## The three open decisions

### Decision A — Dead-letter lineage

When pg-boss exhausts retries on a job *and* the source queue has `deadLetter` configured, pg-boss `INSERT`s a **new job with a fresh `id`** into the dead-letter queue. No link column relates the DLQ job back to its source. From pg-bossier's chronicle, a forensic query against the DLQ id cannot reach back to the original job's attempts, inputs, or failure history.

**How should pg-bossier record the source→DLQ relationship, if at all?** Candidate options (propose better if you see one):

1. **New column `dead_letter_source_id uuid`** on `pgbossier.record`, populated by the capture trigger when it detects a DLQ INSERT. Requires the trigger to figure out which INSERTs are DLQ INSERTs *from inside the trigger*, using only pg-boss public surface.
2. **A separate `pgbossier.dead_letter_link` table** with `(dlq_job_id, source_job_id, captured_at)`.
3. **Encode the link inside the existing `terminal_detail` JSONB slot** on the *source* attempt's final `failed` row, as `{ deadLetteredAs: <new_id> }`. No schema change.
4. **Do nothing** — document the gap; let consumers join on `data` or `singletonKey`.

For each option you consider, address:
- (a) **Can the capture trigger actually detect this transition** using only pg-boss public columns? Be specific — name the columns / state values.
- (b) **Backfill story** for existing installs.
- (c) **Cost at trigger fire time** (relative to the current ~1ms budget).
- (d) **What a `getRetryHistory(dlqJobId)` user gets back** under your proposal.

### Decision B — Singleton supersession

**First step: name which pg-boss mechanism(s) actually produce a "displaced" job** that pg-bossier could mark.

Candidates: `singletonKey` (debounce), `singletonSeconds` (time-windowed), `useSingletonQueue` (one-active-per-queue). **Not all of them displace an existing job** — some reject the new send instead. Be precise: cite the pg-boss behavior that creates a *displaced* job, or argue that no such case exists for the configurations pg-bossier should care about. If you're uncertain about a mechanism's exact semantics, say so.

**Then,** assuming a displacement case exists, decide how the displaced→successor relationship is represented:

1. **Marker in `terminal_detail`** on the displaced attempt's row, e.g. `{ state: 'cancelled', supersededBy: <new_id> }`. No schema change; leverages Goal 2's writer surface.
2. **Dedicated columns** `superseded_by_job_id uuid`, `supersedes_job_id uuid` on `pgbossier.record`. Schema change; two-way navigation.
3. **The trigger derives "displaced" status** by examining sibling rows with the same `singletonKey`. Read-only at write time.
4. **Document and ignore** — let consumers correlate by `singletonKey`.

Same four sub-questions per option as Decision A.

### Decision C — Reschedule semantics

When a job is rescheduled (delayed retry, scheduled cron run, etc.), is the captured row:
- **(a)** just another row-version of the same id with a new `started_on`, indistinguishable from a normal retry, or
- **(b)** something the chronicle should mark distinctly?

Propose the simplest correct answer. This decision is likely short.

## Non-negotiable constraints

- **No fork of pg-boss.** Public JS API + transitional reads only. No reach into `node_modules/pg-boss/src/*`. No depending on private SQL invariants.
- **KISS.** Three similar lines beats a premature abstraction. Schema additions cost more than JSONB markers; argue why a schema change earns its keep.
- **Fail-open.** A failed pg-bossier write must never block pg-boss. Trigger logic that can raise must be wrapped.
- **Composition not replacement.** Goal 3 introduces new pg-bossier reads — must not overload or shadow pg-boss methods.
- **No backfill obligation by default.** Existing installs should keep working without manual data migration; if a proposal requires backfill, it must say so explicitly and offer a "new installs only" fallback.
- **API-shape principle.** Write extensions should prototype both (a) extending pg-boss method calls via options and (b) sibling pg-bossier method, then pick one and say why.

## Response format

~800 words total. Structure:

```
## Decision A — Dead-letter lineage
**Chosen option:** [number + name]
**Reasoning:** [2-4 sentences]
**Detection mechanism:** [be concrete about which pg-boss column reveals the DLQ transition, or admit it can't be detected]
**Strongest counter-argument against my own choice:** [1-2 sentences]

## Decision B — Singleton supersession
**Singleton mechanism scoping:** [which mechanism actually displaces; cite the behavior]
**Chosen option:** [number + name]
**Reasoning:** [2-4 sentences]
**Strongest counter-argument against my own choice:** [1-2 sentences]

## Decision C — Reschedule semantics
**Chosen answer:** [(a) or (b) + brief why]

## Bonus: anything I'd add that wasn't asked
[optional, 1-3 bullets max]
```

Write tightly. Cite the pg-boss column or method name where it matters. If you genuinely don't know a pg-boss semantic, say "I don't know" — bluffing here costs the user more than admitting uncertainty.

# Round 1 — Opus

## Decision A — Dead-letter lineage

**Chosen option:** A new **option 5** the prompt didn't list: **opt-in JS writer API `bossier.recordDeadLetter({ sourceJobId, dlqJobId })` that stores the link in `terminal_detail` on the source's final `failed` attempt row.** Trigger does *nothing* automatic for DLQ. No schema change.

**Reasoning:** None of options 1/2/3 hold up to the detection question. The trigger sees a fresh `INSERT` into `pgboss.job` with a new `id`. To know that row is a DLQ landing, the trigger has to (i) know which queues are DLQ targets and (ii) recover the source job's id. (i) is a transitional-tier read from `pgboss.queue.dead_letter` — fine. (ii) is the killer: pg-boss does **not** write a source_id onto the new DLQ row. The DLQ row's `data` is just the source's `data` copied through; the source's `id` is gone. Any trigger-side reconstruction (matching by `data` shape, by recency window, by transaction-local temp state) is either lossy or fragile under concurrency. A schema column or link table you can't reliably populate is worse than no column at all. The link information *does* exist — but at the DLQ-worker boundary, not at the source job's death. So write it there, on purpose, through a thin API.

**Detection mechanism:** Not from the trigger. The consumer's DLQ worker receives the DLQ job, knows (via `data` or its own bookkeeping) which source job it corresponds to, and calls `bossier.recordDeadLetter({ sourceJobId, dlqJobId })`. The writer UPDATEs the source's last `failed` attempt row's `terminal_detail` to add `{ deadLetteredAs: <dlqJobId> }`, and optionally upserts a forward index on the DLQ row.

**What `getRetryHistory(dlqJobId)` returns:** by default, only the DLQ job's own attempts. A new sibling read `getDeadLetterSource(dlqJobId)` returns the source job's id (resolvable from `data` if descent-app puts it there, or from a forward index). A `getRetryHistory(sourceJobId)` user sees `{ deadLetteredAs: <dlqJobId> }` on the source's terminal row — one hop away from the full DLQ chronicle.

**Backfill:** none. Pre-existing rows simply lack `deadLetteredAs`. Consumers opt in by calling the writer in new DLQ-handler code.

**Cost at trigger fire time:** zero — trigger is unchanged.

**Strongest counter-argument against my choice:** it pushes work onto every consumer that wants DLQ lineage, and a DLQ worker that forgets to call the writer creates silent gaps. A trigger-side "best effort" guess (e.g., matching by `data` checksum within the transaction) might be wrong sometimes but would never be silently empty. I think wrong-sometimes is worse than empty-by-default for a forensic store, but it's debatable.

## Decision B — Singleton supersession

**Singleton mechanism scoping:** I don't believe pg-boss 12's documented singleton mechanisms produce a "displaced cancelled" row in the common path. `singletonKey` (and `singletonKey + singletonSeconds`) cause the **second `send()` to return `null`** — the new job is rejected, the old one stays. `singletonNextSlot` *defers* the new send to the next slot, no displacement. `useSingletonQueue` enforces one-active-per-queue at fetch time — again, no displacement of a pending row. The only pg-boss case I'm aware of that resembles displacement is **cron schedule changes** that may cancel pending scheduled instances when the schedule definition is rewritten; that's a niche of `schedule()`, not of `send()`, and arguably is a `cancelled` row whose reason is "schedule rewritten."

**Chosen option:** **Option 4 — document the absence and do nothing in the substrate.** If a real displacement case surfaces from a consumer (cron rewriting included), the answer at that point is option 1 (marker in `terminal_detail`, leveraging Goal 2's writer), not a schema change.

**Reasoning:** building a schema column or trigger logic for a case that doesn't reliably exist is the exact "abstraction for hypothetical future needs" the project rules forbid. The COMPATIBILITY.md mention of `expired`/`superseded` as "pg-bossier-derived markers" is forward-looking, not load-bearing today.

**Strongest counter-argument against my choice:** I may be wrong about the singleton semantics — Sonnet is reading the source and Codex has direct pg-boss knowledge; one of them probably catches a case I missed. If `useSingletonQueue` or a newer mechanism does displace, option 1 (terminal_detail marker) becomes the right call without a schema change.

## Decision C — Reschedule semantics

**Chosen answer (a):** just another row-version of the same id with a new `started_on`. No distinct marker in the substrate. A reschedule is, from pg-boss's perspective, an UPDATE that resets `start_after` (and possibly `state` back to `created`). The capture trigger picks this up exactly like any other state transition. Consumers who want a "this was rescheduled" marker can write it via `terminal_detail` extended for non-terminal states, or derive it by inspecting the state sequence (`active` → `created` is a clear rescheduling fingerprint). Don't pay schema or trigger cost for derivable signal.

## Bonus: anything I'd add

- **A `getDeadLetterSource(dlqJobId)` sibling read** is the asymmetric counterpart to `getRetryHistory` and is what descent-app's forensic UI actually wants. Worth scoping into this issue, not punting.
- **Naming:** if we land the writer API for Decision A, it should be `recordDeadLetter` (verb-object, matches `recordTerminalDetail` from Goal 2), not `linkDeadLetter` or `markDeadLetter`. Consistency with Goal 2's surface matters more than the most natural English.
- **Failure mode:** the writer must be fail-open (consistent with the substrate). If `recordDeadLetter` fails, the DLQ job still gets processed; the link is just missing. Document that loudly.

# Round 1 — Codex

> Session trace stripped for readability; full transcript in the dispatch tmp log. Tokens used: ~41,491.

## Decision A — Dead-letter lineage
**Chosen option:** 4. Do nothing

**Reasoning:** I do not see a reliable trigger-time way to link the fresh DLQ row back to its source job using only pg-boss's public JS API plus transitional reads of `pgboss.job` columns. The DLQ row is a new `id`, and the prompt's key fact is that pg-boss does not persist a source-link column. Without a stable source pointer, any trigger-side inference would be heuristic and therefore too weak for a forensic feature. KISS wins here: document the gap rather than ship guessed lineage.

**Detection mechanism:** The capture trigger can certainly see a DLQ job row being inserted as just another `pgboss.job` insert, and if pg-bossier expands its transitional read set it could also read columns such as `name`, `state`, and likely `dead_letter` / `singleton_key` / `policy` where present in pg-boss 12.18.2. But none of those identifies the source job id for the new DLQ row. `state` is not enough, `name` is just the DLQ queue name, and the new row's payload columns (`data`, `output`, timestamps) are not a contract for lineage. So option 1 and 2 fail on detectability, and option 3 cannot populate `deadLetteredAs` without somehow discovering the new id.

**Strongest counter-argument against my own choice:** Users will reasonably expect `getRetryHistory(dlqJobId)` to reach the original failure chain, and "document the gap" is unsatisfying. If pg-boss ever exposes a public source-id on DLQ jobs, this decision becomes obsolete immediately.

## Decision B — Singleton supersession
**Singleton mechanism scoping:** I do not see evidence on the public surface of pg-boss 12.18.2 that `singletonKey`, `singletonSeconds`, or the queue `policy` values create a "displaced older job" that is cancelled/replaced by a newer one. The published type comments describe admission/processing constraints: `short` allows only one queued, `singleton` only one active, `stately` one per state, `exclusive` one queued or active, `key_strict_fifo` blocks same-key processing while one is active/retry/failed. That reads like duplicate suppression / blocking, not successor linkage. `send()`, `sendDebounced()`, and `sendThrottled()` returning `Promise<string | null>` also suggests "new send may be rejected/no-op," not "old row is mutated into superseded." `useSingletonQueue` does not appear in the public 12.18.2 types at all, so I would not design around it.

**Chosen option:** 4. Document and ignore

**Reasoning:** Because I cannot first prove a real displaced-job mechanism on the allowed pg-boss surface, I would not add `supersededBy` markers, columns, or trigger logic. All of options 1 to 3 assume a concrete predecessor/successor event that the current public contract does not establish. The least-wrong answer is to say pg-bossier does not currently model singleton supersession, and consumers may correlate by `singletonKey` where useful, understanding that correlation is not lineage.

If a future pg-boss release documents true replacement semantics, I would then prefer option 1 over option 2: write a marker into `terminal_detail` on the displaced row rather than add two permanent columns. That keeps schema cost down and matches Goal 2's "derived refinement" pattern. But I would not ship that until the underlying event is public and unambiguous.

**Strongest counter-argument against my own choice:** There is a real product cost to punting: operators may care exactly which job lost to a newer singleton send. If pg-boss's runtime behavior does replace older rows in some modes, documenting "ignore" would under-model a useful operational fact.

## Decision C — Reschedule semantics
**Chosen answer:** (a). Treat it as ordinary captured row-version history, not a new marked concept.

The simplest correct answer is that pg-bossier should preserve what `pgboss.job` already exposes: `state`, `retry_count`, `started_on`, `completed_on`, and timestamps across row versions. A delayed retry is already visible as the same stable `id` moving through `retry` and then later `active` with the next `retry_count`; that is enough. Cron runs are separate jobs, not reschedules of one existing `id`, so they do not need special lineage semantics either.

## Bonus: anything I'd add that wasn't asked
- I would not overload `getRetryHistory(jobId)`. If DLQ lineage is ever solvable, add a sibling read like `getLineage(jobId)` or `findDeadLetterSource(dlqJobId)`, not a magical expansion of retry history.
- Any future trigger expansion here should explicitly update `COMPATIBILITY.md` to name newly-read transitional columns such as `singleton_key`, `policy`, or `dead_letter`.

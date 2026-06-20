# Round 2 — Gemini

## My position changes since Round 1
I am moving from **"Document and do nothing"** to **"Document the gap + ship a dual-path bridge."** Sonnet’s deep-dive into the `plans.js` CTE order is a decisive fact: the DLQ row literally does not exist when the source's failure trigger fires, making fully automatic "invisible" linkage impossible. I now align with Opus and Sonnet on the necessity of a writer, but I will argue for an implementation that maintains our established API patterns rather than spawning new top-level methods.

## Open question A1 — Writer or document?
**My answer:** Extend `recordTerminalDetail` to accept an optional `deadLetteredAs` field in the `failed` state.
**Naming if writing:** `extend recordTerminalDetail with deadLetteredAs field`
**Counter to the other camp:** Opus proposes a new sibling method `recordDeadLetter`. I disagree. `recordTerminalDetail` is already our established "I'm telling you why this job ended" writer. Adding a new top-level method for a single metadata field is unnecessary API bloat. By extending the existing writer, we keep the client surface lean and reinforce the pattern that all terminal metadata flows through one pipe.

## Open question A2 — Ship findDeadLetterSource read?
**My answer:** Yes, ship now.
**Why:** Lineage is a two-way street. If we provide a way to record the link (source → target), we must provide the forensic entry point to traverse it backwards (target → source). This solves the "How did I get here?" question which is central to the descent-app use case.

## Open question A3 — Reserved data-key convention
**My answer:** Yes, adopt this as a "Trigger-Assisted Linkage" path.
**Why:** This is the most elegant way to get "automatic" linkage for power users. If a consumer includes `_pgbossier_source_id` in their payload, the capture trigger on the new (DLQ) job should detect it and populate a first-class `source_id` column. Since `pg-boss` copies the payload verbatim to the DLQ row, this enables **zero-API lineage** for anyone willing to control their data schema. It turns a manual bookkeeping task into a schema-driven one.

## Open question B1 — Capture singleton_key column
**My answer:** Yes, but in a separate PR.
**Why:** Sonnet makes a compelling case that `singleton_key` is a vital forensic missing piece. However, it is an *attribute* of an attempt, not a *link* between attempts. To keep Goal 3 surgical and focused on "lineage" (the lines between nodes), we should defer this narrow schema addition to a follow-up issue.

## Open question C1 — Skip housekeeping UPDATEs
**My answer:** Separate issue.
**Why:** This is a performance optimization for the trigger, not a functional requirement for lineage.

## Anything I want to flag that the synthesis must not lose
- **The "Data-Copy" synergy:** The "Reserved Key" convention is uniquely powerful here because `pg-boss` handles the "transport" of the ID for us via its internal `data` copy logic. We just provide the "pickup" and "drop-off" points in the chronicle.
- **Fail-Open Writer:** Consistent with Goal 2, `recordTerminalDetail` must remain fail-open. A missing lineage link is an operational nuisance; a crashed worker is an outage.
- **Lineage column:** To support both the writer (source-side) and the convention (target-side), we should add a `source_id` UUID column to `pgbossier.record`. The `findDeadLetterSource` read can then query this column efficiently.

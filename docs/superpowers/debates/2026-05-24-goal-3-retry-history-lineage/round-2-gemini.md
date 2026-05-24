# Round 2 — Rebuttal / concession (Goal 3 retry history)

## Round 2 verdict
SHIP-WITH-NAMED-CHANGES

The architectural approach is sound, but the implementation details regarding JSONB composition and metadata completeness require synchronization. Updating the Goal 2 writer is a prerequisite for Goal 3's correctness.

## Concessions
1. **Opus/Sonnet on the Goal 2 Overwrite Blocker** — Concede. The current `recordTerminalDetail` implementation uses a blind `SET`, which invalidates the spec's claim of associativity. This is a critical blocker that must be resolved by updating the Goal 2 writer to use JSONB merge (`||`).
2. **Sonnet/Opus on `dlqQueue` Metadata** — Concede. Storing only the `dlqJobId` is a missed opportunity for ergonomic forensics. Including the queue name in the JSONB object and the reader's return type adds minimal overhead and significant value for tracing.
3. **Opus on `_originalJobId` Contract** — Concede. The requirement for consumers to preserve the source ID in the DLQ job's `data` payload is a "load-bearing" convention that should be promoted from a README example to an explicit "Consumer Contract" section in the spec.

## Rebuttals
1. **Opus on Chained DLQ Ambiguity** — Rebut. Opus suggests `findDeadLetterSource` might return multiple rows for one DLQ ID. This is physically impossible in the pg-boss model: a `dlqJobId` is a unique UUID for a specific job instance. While a job can be a *source* for one link and a *target* for another (A -> B -> C), those links live on different rows (Row A and Row B). `findDeadLetterSource(B)` will only ever match Row A. `LIMIT 1` is safe and correct.
2. **Opus on Plural Cardinality** — Rebut. Storing a list of DLQ IDs on a single source attempt overcomplicates the schema for a scenario (one attempt -> many DLQs) that pg-boss 12 does not support. If a job is retried and fails again, it generates a *new* attempt row in the chronicle; each attempt row should link to at most one DLQ job. 1:1 cardinality at the attempt level is the correct grain.

## Position: how to fix the merge issue (blocker 1)
**OPTION-A (merge in Goal 2 and Goal 3).** 
Both `recordTerminalDetail` and `recordDeadLetter` must use `COALESCE(terminal_detail, '{}'::jsonb) || $new_data`. This transforms `terminal_detail` from a single-writer blob to a multi-writer registry. Opus’s concern about "last-writer-wins" is addressed by moving that semantic to the *key* level rather than the *object* level, which is more idiomatic for JSONB audit columns.

## Position: cardinality (1:1 vs plural)
**SINGLE.**
The "source" of a DLQ link is a specific `(jobId, attempt)` tuple. In pg-boss, one failure event produces exactly one DLQ job. Modeling this as a singleton string or a simple object `{ id, queue }` is cleaner and matches the reality of the platform.

## Final must-land list
1. **Update `recordTerminalDetail` (Goal 2)**: Change the SQL UPDATE to use `||` merge to prevent wiping out Goal 3 data.
2. **Expand `deadLetteredAs`**: Store as an object `{ jobId: string, queue: string }` rather than a raw string.
3. **Update `findDeadLetterSource`**: Return `{ jobId, attempt, queue }` to save the caller a lookup.
4. **Synchronize Types**: Add the named optional field to `TerminalDetailFailed` in `src/terminal-detail.ts`.
5. **Consumer Contract**: Add an explicit section to the README/spec documenting that consumers are responsible for `data` metadata preservation to enable the writer.
6. **Fail-Open Logging**: Differentiate between "Source not found" (expected/purged) and "Database error" in logs as suggested by Sonnet.

# Goal 3 Adversarial Review — Round 1 (Gemini)

## Verdict
SHIP-WITH-NAMED-CHANGES

## Must-land changes (blockers)
1. **Change `recordTerminalDetail` implementation to use JSONB merge (`||`).** The current implementation in `src/terminal-detail.ts` performs a blind `SET terminal_detail = $4`. This will wipe out the `deadLetteredAs` link if `recordTerminalDetail` is called after `recordDeadLetter` (e.g., due to an async race or late worker reporting). To fulfill the spec's claim that "both writers can be called in either order; the merge is associative," the Goal 2 writer MUST be updated to use the merge pattern: `SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb`.
2. **Synchronize `TerminalDetailFailed` type definition.** The implementation of the type in `src/terminal-detail.ts` must be updated to include the optional `deadLetteredAs?: string` field to ensure type safety for readers and satisfy the contract described in the "Composition with Goal 2" section.

## Should-land in v1 (not blockers, but cheap)
1. **Add `findDeadLetterTarget(sourceJobId)` as a convenience reader.** While the link is visible in `getRetryHistory`, a dedicated reader that returns the DLQ ID for a source job (if any) is a logical mirror to `findDeadLetterSource` and trivial to implement. It directly answers the "What did this job become?" question without requiring the consumer to parse the full history array.
2. **Refine `recordDeadLetter` "silent no-op" logging.** The spec mentions it "Logs and continues on any error." Ensure the implementation distinguishes between "Source row not found" (expected if purged) and "Database error" (unexpected) in its logs to assist developers during the adoption phase.

## Defer to follow-up
1. **Automatic DLQ detection via statement-level triggers.** If pg-boss ever adds a `source_id` to its `job` table or provides a reliable session-state link during `failJobs()`, this app-layer writer should be deprecated. Until then, the manual writer is the only robust path.
2. **Lineage-integrity diagnostic.** A utility to identify "orphan" DLQ jobs (jobs in a DLQ queue that lack a recorded source link) to help ops teams identify handlers that are forgetting to call `recordDeadLetter`.

## Architectural position — the writer
**APP-LAYER-WRITER.** This is the correct pragmatic choice for pg-boss 12. 
- **Trigger detection** is verified impossible/unreliable due to pg-boss's use of sibling CTEs for DLQ insertion without carrying the source ID.
- **Reserved data-key** (Gemini's earlier rejected proposal) is indeed inferior as it pollutes the consumer's `data` payload and requires the capture trigger to pay a per-row JSONB scanning cost for a rare event (dead-lettering).
- **No-writer** would leave a significant "forensic gap" for descent-app, failing the "one typed query to see what happened" rubric.

## Trigger-detection impossibility — verified?
**YES.** I have reviewed the pg-boss `failJobs` implementation (specifically `src/plans.js` around DLQ routing). Because the DLQ `INSERT` happens in a sibling CTE (`dlq_jobs`) to the failure `INSERT` (`failed_jobs`), and because pg-boss specifically *omits* the source ID from the DLQ row creation, there is no way for a standard Postgres trigger to correlate the two without heuristic matching on `data`/`output`. In high-concurrency environments, heuristic matching introduces the risk of false lineage, which is unacceptable for a forensic audit tool.

## Industry-comparison findings
- **Sidekiq / BullMQ**: Lineage is a non-issue because the job ID is immutable; moving to a dead-set is a state change, not a new job creation.
- **AWS SQS**: DLQ messages typically preserve the original `MessageId` (as per "Redrive policy" behavior), meaning the lineage is implicit in the ID.
- **pg-boss**: The "new row, new ID" architecture for DLQs is the primary driver for this feature. The spec's approach effectively "virtualizes" the immutable ID behavior of other systems by bridging the ID gap in the audit layer.

## Anything the spec missed entirely
- **Multi-hop DLQs.** The spec handles this elegantly. If Job A -> DLQ Job B -> DLQ Job C, calling `recordDeadLetter` at each hop creates a traversable chain. `findDeadLetterSource(C)` returns B, and `findDeadLetterSource(B)` returns A.
- **Race Condition Safety.** Since `recordDeadLetter` is called by the consumer *handling* the DLQ job, and that job only exists after the source job's `failed` state has been committed (same statement), there is no risk of the writer attempting to update a source row that hasn't been captured yet. The only "race" is with `recordTerminalDetail`, which is addressed by the "Must-land" merge requirement.

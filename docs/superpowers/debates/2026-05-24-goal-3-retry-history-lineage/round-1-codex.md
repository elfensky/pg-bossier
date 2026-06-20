## Verdict
BLOCK-UNTIL

## Must-land changes (blockers)
1. Fix the Goal 2 / Goal 3 composition contract. The spec says `recordTerminalDetail` is unchanged, but current Goal 2 semantics are overwrite-by-value, while Goal 3 assumes associative merge semantics. That means `recordTerminalDetail` called after `recordDeadLetter` can erase the lineage key. The race section is therefore wrong too. Either:
   - change `recordTerminalDetail` to preserve pg-bossier-managed lineage keys when overwriting user detail, or
   - drop the “either order” claim and make call ordering a hard requirement.
   I would not ship the second option.
2. Narrow the trigger claim from “detection is impossible at the trigger” to “reliable source↔DLQ correlation is impossible at the trigger.” PostgreSQL statement-level `AFTER` triggers can see all modifications from the statement, and transition tables can expose the inserted rows ([visibility](https://www.postgresql.org/docs/current/trigger-datachanges.html), [transition tables](https://www.postgresql.org/docs/current/trigger-definition.html)). The real blocker is that pg-boss does not propagate a source id or any stable correlation token into the DLQ row, so the trigger still cannot pair rows exactly.

## Should-land in v1 (not blockers, but cheap)
1. Make `recordDeadLetter` observable while staying fail-open. `Promise<void>` plus README is weak. Return `boolean` or a small status object so the DLQ worker can emit metrics when the link was not written.
2. Rename the managed field to `deadLetterJobId` or reserve a small namespaced object. `deadLetteredAs` is understandable, but vague and collision-prone inside an otherwise open consumer payload.
3. Add a reader predicate or invariant that reflects intent. `findDeadLetterSource` should at least be documented as one-hop and ideally constrain to failed-attempt rows.
4. Add upfront UUID validation on the writer, matching the defensive style already used in read APIs.
5. Expand tests to cover:
   - `recordTerminalDetail` then `recordDeadLetter`
   - `recordDeadLetter` then `recordTerminalDetail`
   - concurrent writes to the same row
   - source row purged before link
   - chained DLQs, explicitly proving the API is one-hop

## Defer to follow-up
1. Root-ancestry traversal such as `findDeadLetterRoot()` or a helper that follows multiple DLQ hops.
2. Extra metadata like recorded timestamp or DLQ queue name. Not needed for v1 if the value stays a single-hop job id.
3. Ops diagnostics for “expected link missing” across a date range or queue.
4. Any trigger-side experiment unless pg-boss later exposes a source identifier.

## Architectural position — the writer
APP-LAYER-WRITER — this is the right shape.

Reserved `data` keys are the wrong layer: they pollute app payloads and still rely on consumer discipline. A trigger-based solution can observe timing but not infer an exact pairing. No-writer leaves a real consumer need unsolved.

The closest industry analogue is not Sidekiq or BullMQ, because both mostly keep the same logical job identity across retries/failure handling. It is closer to SQS-style DLQ handling, where the broker gives you delivery metadata but application lineage usually rides in app-controlled metadata.

## Trigger-detection impossibility — verified?
YES — no trigger mechanism can reliably populate the source link from pg-boss as shown.

Nuance: a statement-level `AFTER INSERT` trigger with transition tables could inspect both inserted sets, but it still would not have a non-heuristic join key. `txid_current`, statement timing, row order, identical `data`, or copied `output` are all unsafe under concurrency and duplicates.

## Industry-comparison findings
1. Sidekiq keeps job payload identity available through retries / death handling and exposes exhaustion hooks with the job hash before dead placement, so it does not need this kind of back-link stitching ([Error Handling](https://github.com/sidekiq/sidekiq/wiki/Error-Handling), [Job Format](https://github.com/sidekiq/sidekiq/wiki/Job-Format)).
2. BullMQ treats the job id as the pointer through state changes; failures move the same job into the failed set and retries move it back to waiting, so again there is no “new id with lost ancestry” gap ([Job Ids](https://docs.bullmq.io/guide/jobs/job-ids), [Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)).
3. SQS is the closest analogue: consumers can receive `DeadLetterQueueSourceArn`, but broker-level provenance is still limited and message identity handling is distinct from app lineage, so app-supplied metadata is the normal pattern ([ReceiveMessage](https://docs.aws.amazon.com/cli/latest/reference/sqs/receive-message.html)).
4. Temporal solves this structurally with workflow/run-chain identifiers like `first_execution_run_id`; it models lineage as a first-class execution concept rather than as a DLQ patch-up ([Temporal API docs](https://api-docs.temporal.io/)).

## Anything the spec missed entirely
1. The current codebase’s Goal 2 writer is overwrite-oriented, so the spec’s merge/race claims are not just optimistic; they conflict with the existing implementation direction.
2. The current capture trigger swallows its own failures with a warning. That means “source row missing” is not only a consumer-adoption problem; it can also be a substrate-capture problem. This strengthens the case for returning a writer status.
3. Chained DLQs need explicit semantics. `findDeadLetterSource` is one-hop, not “find original source,” and that should be named in docs and tests.
4. The managed lineage key lives inside an open-ended consumer object. Without a reserved-name rule, collision semantics are underspecified.
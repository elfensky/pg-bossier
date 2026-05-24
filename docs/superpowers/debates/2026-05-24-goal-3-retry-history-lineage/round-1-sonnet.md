# Goal 3 Adversarial Review — Round 1 (Sonnet)

## Verdict

BLOCK-UNTIL

The spec has one concrete implementation error (blocker 1 below) that makes the "both writers associative in either order" claim false against the current `src/terminal-detail.ts` code. Everything else is ship-ready or cheap to fix before merge. The architectural decisions are sound and I stand by my prior-debate positions.

## Must-land changes (blockers)

1. **`recordTerminalDetail` overwrites, it does not merge — the spec's associativity claim is false today.** `src/terminal-detail.ts` line 98–105 issues `SET terminal_detail = $4::jsonb` — a blind overwrite. The spec at "Composition with Goal 2" says "both writers can be called in either order; the merge is associative." That is not true against the current implementation. If `recordDeadLetter` runs first (writing `{ deadLetteredAs: '<id>' }`) and then `recordTerminalDetail` runs second (writing `{ class: 'transient', message: '...' }`), the overwrite silently drops `deadLetteredAs`. The fix is in `src/terminal-detail.ts`: change the UPDATE to `SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb`. This PR cannot merge without that change because the spec's composability guarantee is the entire reason the "merge into existing terminal_detail" design was chosen over a separate column.

2. **`TerminalDetailFailed` in `src/terminal-detail.ts` must be updated before this PR merges.** Line 27–31 defines `TerminalDetailFailed` without `deadLetteredAs`. The spec explicitly says this field is added. A consumer who reads the type after calling `recordDeadLetter` will not see `deadLetteredAs` in the typed shape — TypeScript will report it as coming from `Record<string, unknown>` rather than being a named, documented field. The type extension is two lines and belongs in the same commit as the writer.

## Should-land in v1 (not blockers, but cheap)

1. **Distinguish "source row not found" from "DB error" in the fail-open log.** The spec says `recordDeadLetter` "Logs and continues on any error." During early adoption (which is when `recordDeadLetter` will be called most incorrectly), the two failure modes have different operator responses: "source row not found" means the consumer supplied a wrong `sourceJobId` or the row was purged; "DB unreachable" means infrastructure. Logging both at `WARNING` with the same message masks which is which. At minimum, the `RAISE WARNING` (or JS logger call) should name the cause.

2. **The `findDeadLetterSource` reader should return `queue` alongside `{ jobId, attempt }`.** The spec's return type is `{ jobId: string; attempt: number } | null`. In the actual forensic flow — "what original job is this DLQ entry?" — the consumer will immediately want to call `getRetryHistory(source.jobId)` and may also want to display the source queue name without a second round-trip. `queue` is on the same row in `pgbossier.record`; including it in the SELECT adds zero cost and makes the return type a complete answer. This is not a blocker but it is the shape I would use.

## Defer to follow-up

1. **`findDeadLetterTarget(sourceJobId)` forward-direction reader.** Gemini raised this; I agree it is a useful mirror but not a blocker. A consumer who has a `sourceJobId` and wants to find the DLQ job it produced can already get this from `getRetryHistory` + inspecting `terminal_detail.deadLetteredAs`. A dedicated method is a convenience. File separately.

2. **Ops diagnostic for unlinked DLQ jobs.** The spec names this as a "possible follow-up." It belongs under a separate issue. The shape would be: `findUnlinkedDlqJobs(dlqQueueName)` — returns jobs in that queue whose `pgbossier.record` row has no `deadLetteredAs` pointing at it from any source row. Legitimate use: periodic ops check to detect handlers that forgot to call `recordDeadLetter`. Not needed before v1.

3. **`singleton_key` capture as a plain column on `pgbossier.record`.** I flagged this in the prior debate and 4-of-4 agreed it ships separately. Still true.

4. **Chained DLQ traversal helper.** Multi-hop lineage (A → DLQ B → DLQ C) is handled correctly by the current design — each `findDeadLetterSource` call walks one hop. A convenience method to traverse the full chain is a nice-to-have. Defer.

## Architectural position — the writer

**APP-LAYER-WRITER.** My position from the prior debate is unchanged and the spec correctly captures the reasoning. The sibling-method shape (`recordDeadLetter` rather than an extension to `recordTerminalDetail`) is right for the reason I named in Round 2 of the prior debate: DLQ-handler call sites have neither `attempt` nor a valid `class`-bearing payload, so forcing them to supply those to `recordTerminalDetail` kills adoption. A narrow method that resolves `attempt` internally (via `ORDER BY attempt DESC LIMIT 1`) keeps the call site clean.

## Trigger-detection impossibility — verified?

**YES.** I read `node_modules/pg-boss/dist/plans.js` directly, specifically `failJobs()` at lines 1029–1189. Here is what the SQL actually does:

1. `deleted_jobs` CTE: DELETE the source job row, RETURNING *.
2. `retried_jobs` CTE: INSERT back with `state='retry'` for jobs below `retry_limit`. Fires row-level triggers on each inserted row.
3. `failed_jobs` CTE: INSERT back with `state='failed'` for jobs at `retry_limit`. **This fires the capture trigger.** At trigger time, `NEW.id` is the source job's UUID, `NEW.state='failed'`, `NEW.dead_letter=<dlq_queue_name>`.
4. `results` CTE: UNION of retried_jobs and failed_jobs.
5. `dlq_jobs` CTE (lines 1173–1187): `INSERT INTO pgboss.job (name, data, output, retry_limit, retry_backoff, retry_delay, keep_until, deletion_seconds) SELECT r.dead_letter, data, output, ...`. **The DLQ row's id is not in the INSERT column list** — it defaults to `gen_random_uuid()` via the table DEFAULT (plans.js line 264: `id uuid not null default gen_random_uuid()`). The new UUID is generated by Postgres at INSERT time, inside the DLQ CTE, which runs after `failed_jobs`. Nothing — no trigger, no session variable, no CTE output visible to `failed_jobs` — can see that UUID at the time the capture trigger fires on the `failed_jobs` INSERT.

**Is there any mechanism that defeats this?** I checked three candidates:

- **Statement-level trigger with transition tables (REFERENCING NEW TABLE AS ...)**: A `FOR EACH STATEMENT` trigger with `REFERENCING NEW TABLE` would see all rows inserted by the statement, including both `failed_jobs` and `dlq_jobs` rows. This is the one non-obvious path worth naming. However, it does not solve the problem: the dlq_jobs row carries no `source_id` column, so matching a failed row to its dlq row inside the transition table requires correlating via `data` + `output` content match or via `dead_letter = dlq_row.name` — both heuristic under concurrency (multiple jobs from the same source queue can fail simultaneously, all going to the same DLQ queue with identical data). The correlation is unreliable. Also, pg-bossier's trigger is already `FOR EACH ROW` and transitioning it to `FOR EACH STATEMENT` would require careful audit of what else depends on row-level semantics. Not worth pursuing.
- **Deferred constraint triggers**: PostgreSQL's `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` fires at end-of-transaction, which means all CTEs have already executed. This sounds like it could work — the DLQ row exists by then — but deferred constraint triggers fire per-row (for each row in the statement), not as a statement-level view. More critically, in a deferred trigger we would have `NEW.id` for the failed row but would still need to find the dlq row's UUID, which requires a query against `pgboss.job WHERE name = NEW.dead_letter AND state='created' AND created_on = NOW()` — a non-deterministic lookup under concurrency. Still heuristic.
- **Session state / `set_config`**: pg-boss does not write any session state before issuing `failJobs()`. Grep of `manager.js` and `plans.js` confirms: the only `SET LOCAL` is `idle_in_transaction_session_timeout`. No pg-boss code path writes a `set_config('pgboss.current_source_id', ...)` that a trigger could read.

**Conclusion:** The impossibility claim is correct. There is no mechanism that lets the capture trigger reliably populate a source→DLQ link at INSERT time. The application-layer writer is the only non-heuristic path.

## Industry-comparison findings

The prompt asked for Sidekiq, Bull/BullMQ, AWS SQS, and Temporal. My findings:

**Sidekiq (Ruby):** Sidekiq Pro's dead-set (`Sidekiq::DeadSet`) pushes a *copy* of the job payload (including the original `jid`) onto a sorted set keyed by failure time. The `jid` is immutable across retries — Sidekiq does not create a new job for the DLQ hop. Lineage is trivial: the dead-set entry *is* the original job. The pg-boss design — new UUID, new row — is fundamentally different. Sidekiq's pattern does not transfer because pg-boss's DLQ creates a genuinely new job.

**BullMQ (Node.js):** BullMQ does not have a "dead-letter queue" in the pg-boss sense. Failed jobs move to the `failed` set (still accessible by their original ID). There is no new-job-with-new-ID hop. Consumer access to the failed job is via the original ID. Same conclusion as Sidekiq: the source-id-preservation problem does not arise because IDs don't change.

**AWS SQS DLQ:** When a message exceeds `maxReceiveCount`, SQS moves it to the DLQ. The moved message retains its original `MessageId` and the metadata attribute `ApproximateFirstReceiveTimestamp`. More relevant: SQS also sets `DeadLetterQueueSourceArn` on the dead-letter queue configuration — but this identifies the *source queue*, not the *source message ID*. Individual message lineage (which original send produced this DLQ message) is traceable only via the preserved `MessageId`. The key observation: AWS preserves the original ID by *moving* the message rather than *copying* it. pg-boss copies it (the `data` and `output` from the failed row into a new job). The AWS pattern is not transferable for the same reason as Sidekiq.

**Temporal:** Temporal workflows use RunId chaining — a workflow failure that triggers a new workflow run links the new RunId to the previous one in the workflow history. This is a first-class platform concept, not a bolt-on. The new run ID is recorded at the point of continuation, not separately. The analogy to pg-bossier would be: pg-boss writing the source job's id into the DLQ job's `data` or a dedicated column at `failJobs()` time. Since pg-boss doesn't do this, the gap exists. The spec's design is the closest equivalent available without patching pg-boss: an application-layer write that records the link in the source's `terminal_detail`.

**Pattern the spec missed:** AWS SQS's `ApproximateReceiveCount` attribute (available on every DLQ message delivery) is analogous to what `attempt` provides in the pg-bossier chronicle. The spec already handles this correctly via `getRetryHistory`. No missed pattern here.

**One genuine gap:** AWS SQS's DLQ redrive (moving messages back from DLQ to the source queue) is a common operational pattern. pg-boss has `retryJobs()` which can move a failed job back to `retry` state — this is not DLQ-specific. The spec does not address the "DLQ job redriven back to source queue" case. This is an edge case worth naming: if `bossier.retryJobs(dlqJobId)` is called, what happens to the link? The answer is: nothing breaks — the DLQ job gets a new attempt, its `pgbossier.record` row gets a new row via the capture trigger, and the existing `deadLetteredAs` link on the *source* job's row is unaffected. The lineage stays intact. This is the correct behavior and the spec doesn't need to change — but the README should note it.

## Anything the spec missed entirely

1. **The `recordTerminalDetail` overwrite bug is the spec assuming a future-state implementation that doesn't exist yet.** The spec's "Composition with Goal 2" section describes merge semantics that `src/terminal-detail.ts` does not implement. This is the blocker named above, not a "missed" item — but it's important to be precise: the spec is not wrong about what *should* happen; the existing code is wrong about what *does* happen.

2. **`findDeadLetterSource` uses `LIMIT 1` without an ORDER BY.** The spec's SQL sketch (lines 127–131) is:
   ```sql
   SELECT job_id AS "jobId", attempt
   FROM pgbossier.record
   WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text)
   LIMIT 1;
   ```
   The `LIMIT 1` without `ORDER BY` is non-deterministic if (through a bug or duplicate write) two rows somehow have the same `deadLetteredAs` value. In normal operation there should be at most one, but defensive ordering (`ORDER BY captured_at DESC`) costs nothing and makes the behavior predictable. Low priority, but name it.

3. **No mention of what happens when `sourceJobId` is still in `retry` state (not yet `failed`) when `recordDeadLetter` is called.** The spec says the writer targets `state = 'failed'` rows. If a consumer calls `recordDeadLetter` prematurely — before the source's final failure has committed — the `ORDER BY attempt DESC LIMIT 1` query may find a `retry`-state row (which has `state='retry'` in `pgbossier.record`) and the UPDATE's `state = 'failed'` filter will match zero rows. The writer silently does nothing. The spec documents "call from DLQ-handler" as the supported pattern (correct — DLQ job only exists after the source committed `failed`), but the failure mode for wrong-ordering callers is invisible. One sentence in the JSDoc naming this would close the gap.

4. **The spec does not address the `progress` column interaction.** Goal 6's `setProgress` writes to `pgbossier.record.progress`. If a source job had progress data and was dead-lettered, the DLQ job starts with no progress (it's a new job). The spec does not mention whether `progress` should be copied from the source to the DLQ job's `pgbossier.record` row. It should not be — the DLQ job has no attempts yet and its progress history is its own — but this edge case is worth one sentence in the "What does NOT change" section to prevent implementers from thinking it was accidentally omitted.

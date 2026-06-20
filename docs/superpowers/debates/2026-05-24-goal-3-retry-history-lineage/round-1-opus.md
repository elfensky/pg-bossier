# Round 1 — Opus review: Goal 3 retry history / DLQ lineage spec

## Verdict

BLOCK-UNTIL

The architectural shape (app-layer writer + reader composing with Goal 2's JSONB column) is sound. But the spec's "associative merge" claim — load-bearing for the writer's correctness — is structurally false against the code Goal 2 actually shipped. That falsifies the central composition story and needs to be addressed before merge. Two smaller issues compound it.

---

## Must-land changes (blockers)

**1. The "associative merge" claim is false. Goal 2's writer overwrites.**

The spec's composition section says: "Both writers can be called in either order; the merge is associative." This is structurally untrue against the shipped Goal 2 code. `src/terminal-detail.ts:100` does:

```sql
SET terminal_detail = $4::jsonb
```

This is a blind overwrite, not a JSONB merge. Concrete failure mode:

```
T1: recordDeadLetter({sourceJobId, dlqJobId})   → terminal_detail = {deadLetteredAs: 'x'}
T2: recordTerminalDetail({state: 'failed', detail: {class: 'transient'}})
    → terminal_detail = {class: 'transient'}   -- deadLetteredAs SILENTLY LOST
```

The spec's example "the merge produces `{ class: 'transient', message: 'fetch timed out', deadLetteredAs: '<id>' }`" only works in the OPPOSITE call order. The spec must either:

a. Update Goal 2's writer to use the same `COALESCE(...) || jsonb_build_object(...)` pattern. This is a behavior change to Goal 2 — Goal 2's `recordTerminalDetail` would lose its "last-writer-wins on the full terminal_detail object" semantic and become a key-level merge. Worth doing IF we accept that consumers can no longer overwrite `class`. It also means calling `recordTerminalDetail({state: 'failed', detail: {class: 'transient'}})` after `recordTerminalDetail({state: 'failed', detail: {class: 'non_retryable'}})` would now produce `{class: 'non_retryable'}` (the first write wins for keys not re-supplied), reversing Goal 2's documented contract.

b. Pick a different storage location for `deadLetteredAs`. Candidates: a new JSONB column (`dead_letter_link`) or a new typed column (`dead_letter_target_id UUID`). Both are schema changes — the spec's "no schema change" claim is then false instead.

c. Mandate call ordering. "Consumers MUST call `recordTerminalDetail` before `recordDeadLetter` on the same source row, never after." This is fragile (workers and DLQ-handlers run in different code paths; ordering across processes is non-trivial to enforce).

d. Make `recordDeadLetter` ITSELF perform the merge and let `recordTerminalDetail` stay overwrite. Then ordering matters in one direction only: `recordTerminalDetail` MUST be called before `recordDeadLetter`. This is the simplest fix but it inverts the spec's "either order" claim. It also matches the natural lifecycle (terminal detail signaled at failure-time; dead-letter recorded at DLQ-handle-time, which by definition happens later).

Whichever you pick, the spec must say which one explicitly. The current "associative merge" framing is a documented behavior the code doesn't provide.

**2. The reader returns only the first match. Multi-hop and re-DLQ cases break silently.**

`findDeadLetterSource(dlqJobId)` runs:

```sql
WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text) LIMIT 1
```

If a DLQ job is itself dead-lettered later (re-DLQ), then TWO source rows could carry `deadLetteredAs: dlqJobId` — one source from the first DLQ leg, plus the intermediate DLQ that itself became a source. `LIMIT 1` returns whichever Postgres picks first. The reader silently returns the wrong source for chained DLQs.

The fix is either:

- Document explicitly that "a DLQ job can be the source of exactly one upstream link," and at write time refuse to record a second `deadLetteredAs` for a `dlqJobId` already present (verify in SQL via `WHERE NOT EXISTS (... deadLetteredAs := dlqJobId ...)`).
- Or have the reader return `Array<{jobId, attempt}>` and let the caller decide.

The spec doesn't choose. Default behavior is "whichever Postgres picks" — which is correct never.

**3. `deadLetteredAs` cardinality is wrong for one-source-many-DLQ-jobs.**

A single source job can fail across multiple retries, each of which (in principle) could result in a separate DLQ job — though pg-boss 12's `failJobs` path emits ONE DLQ insert per final failure. Pluralization aside, the field name `deadLetteredAs: <single-id>` implies 1:1 cardinality. The shape can't represent "this source produced DLQ jobs A, then B (after manual re-fail), then C." That isn't a pg-boss-native scenario but it's a consumer-pattern that may emerge (manual ops re-dispatch).

Cheap fix: make the field a `string[]` or `Array<{dlqJobId, recordedAt}>`. The writer becomes "append if not present." Costs a few lines; future-proof.

If we DON'T make it plural, the spec must document explicitly that `recordDeadLetter` on a source that already has `deadLetteredAs` set is a no-op or an error. Currently it overwrites (because of blocker #1, depending on resolution).

---

## Should-land in v1 (not blockers, but cheap)

**4. The writer's "find most recent failed row" via `ORDER BY attempt DESC LIMIT 1` is correct for the normal case but doesn't address: source row was deleted-and-reinserted between failure and recordDeadLetter.** Goal 1's chronicle preserves the row across pg-boss's retry DELETE+INSERT, but if a manual `boss.retry()` is called and the chronicle row's `state` is no longer `failed` at the time `recordDeadLetter` runs, the writer's WHERE clause silently no-ops. Document this explicitly; consider adding a state-relaxation (`state IN ('failed', 'retry')` mirroring Goal 2's pattern).

**5. `findDeadLetterSource` should also expose dlq queue name in its return type.** Currently it returns `{jobId, attempt}` only. The DLQ-handler context often knows the DLQ queue name (it's the queue the handler is consuming from) but a forensic UI tracing through `getRetryHistory` then `findDeadLetterSource` may want the queue name without an extra round-trip. Cheap to add.

**6. JSONB index assumption.** The reader claims to "use the existing `record_terminal_detail_gin` index." Verify the planner actually picks it for `@> jsonb_build_object('deadLetteredAs', $1::text)`. The default `jsonb_ops` operator class supports `@>` indexed lookups for containment, so this should work — but the test plan should include an EXPLAIN ANALYZE check.

**7. Test plan: add the three scenarios the spec mentions but doesn't enumerate as tests.** Concurrent recordDeadLetter + recordTerminalDetail on the same source (the race the merge claim is supposed to handle); source row was deleted/purged between the failure and the DLQ-handler call; chained DLQs (A → B → C).

---

## Defer to follow-up

1. **Statement-level after-trigger correlation** — even if some clever CTE-aware mechanism existed (it doesn't, per the spec's verification), it would be too fragile for v1. Stay with the app-layer writer.
2. **Lineage-integrity diagnostic** (e.g., "find DLQ jobs without a recorded source link") — useful ops tool but not Goal 3's responsibility.
3. **Auto-detecting reschedule transitions** — out of scope; spec correctly punts.

---

## Architectural position — the writer

**APP-LAYER-WRITER.**

The trigger-detection impossibility argument is correct (see next section). The reserved data-key approach was already rejected in the prior debate for sound reasons (pollutes consumer payload; the key copies through into the DLQ row creating a self-reference). No-writer leaves the forensic gap permanently open and fails the issue #1 success criterion.

The app-layer writer's main risk is consumer-discipline: forgotten calls leave silent gaps. The spec's mitigation (loud README + JSDoc) is necessary but not sufficient. A periodic ops diagnostic that surfaces "DLQ rows without a recorded source" would be the right complement — but that's a follow-up, not v1.

---

## Trigger-detection impossibility — verified?

**YES.** Independently verified by reading the included `failJobs` SQL.

The proof: pg-boss's `failJobs` runs as ONE multi-CTE statement. The `dlq_jobs` CTE has no reference to `r.id` — pg-boss explicitly does NOT carry the source id into the DLQ INSERT. The new row's id comes from `DEFAULT gen_random_uuid()`. So at the moment the AFTER INSERT trigger fires for the DLQ row, the trigger function sees a `NEW` whose only correlation hint to the source is the `data` payload and the queue's `dead_letter` config.

Theoretical workarounds (and why each fails):

- **Statement-level after trigger.** Postgres supports `AFTER INSERT ... FOR EACH STATEMENT` with `REFERENCING NEW TABLE`. The trigger would see all inserted rows. But it would still need to correlate "this DLQ row corresponds to that failed row" — which means matching by `data` and queue-target, which is heuristic (mis-matches under concurrent identical-data failures).
- **Deferred constraint trigger.** Same correlation problem; deferral just changes WHEN the trigger fires, not WHAT info it has.
- **`txid_current()` correlation.** All rows from one `failJobs` call share a txid, but multiple `failJobs` calls can interleave under concurrent worker pools. Same fundamental ambiguity.
- **Sequence read or fresh-id timestamp.** The DLQ row's `id` is a fresh UUID with no information content. No way to derive source from it.
- **Listen/notify.** Requires pg-boss to publish a notification; it doesn't.
- **Reading `pg_stat_xact` or other system catalogs.** Same correlation problem.

There is no general mechanism in standard Postgres + pg-boss 12's public surface that defeats the impossibility. The trigger genuinely cannot reliably populate the link.

---

## Industry-comparison findings

The spec didn't engage with industry comparison; I'll fill that in.

- **AWS SQS DLQ.** The redrive policy preserves the original `MessageId` when a message moves to the DLQ. Lineage is implicit in the id. Different from pg-boss; pg-boss creates a new id. Not directly portable.
- **Sidekiq dead set.** Sidekiq doesn't create a "new job" for the dead set — it just sets a flag/queue on the same JID. Lineage is preserved automatically. Different model from pg-boss.
- **BullMQ failed-state.** Similar to Sidekiq: failed jobs stay in the same record with the same id. The failure is a state on the original job. Different model.
- **Temporal continueAsNew.** When a workflow continues itself, the new workflow execution has a new `runId` but the same `workflowId`. The `runId` chain forms the lineage. Closest analogue to pg-boss's DLQ situation. Temporal solves it by exposing the `previousRunId` field on workflow start.
- **Apache Airflow DAG retry.** Airflow's task instances preserve the `task_id` across retries; lineage is implicit via `try_number` indexing. Closer to pg-boss's retry preservation (Goal 1) than its DLQ-to-new-job model.

The pg-boss "new id" DLQ model is genuinely unusual. The spec's app-layer writer is the right kind of bridge — it gives consumers the same kind of `previousRunId`-like field Temporal provides, without forking pg-boss.

What the spec MISSED in industry comparison: **the bridge is asymmetric.** Temporal stores `previousRunId` on the SUCCESSOR run's record. pg-bossier's `recordDeadLetter` stores `deadLetteredAs` on the SOURCE row. This means:

- Source-to-DLQ lookup: simple (read source row → field).
- DLQ-to-source lookup: requires the GIN index + JSONB containment query.

The asymmetry isn't wrong but it's worth noting. Temporal-style "on the new row" storage would put the field on the DLQ row's audit record, not the source's. That would make DLQ-to-source the simple lookup and source-to-DLQ the complex one. Different bias, similar total cost. The spec's choice biases toward DLQ-to-source which is the more common forensic question — defensible.

---

## Anything the spec missed entirely

**1. The dlq queue name belongs in the recorded link.**

The spec stores `deadLetteredAs: '<dlqJobId>'` (just the id). For forensic queries that want to know "what queue did this end up in?" — the consumer has to do a second lookup against pgbossier.record using the dlqJobId. Storing `{dlqJobId, dlqQueue}` upfront makes the link self-describing. Two extra bytes per write; meaningful operational ergonomics.

**2. The writer's idempotency claim isn't quite right.**

The spec says: "Calling twice with the same `(sourceJobId, dlqJobId)` produces one merged value." Technically true for the JSONB merge (the SET produces the same result), but the SQL still runs an UPDATE that touches the row. If a consumer's DLQ-handler retries (e.g., it crashes mid-way and replays), the second UPDATE still bumps any `updated_at` or trigger-firing columns. Document that idempotency is at the data level, not the write-side-effect level.

**3. What happens if `sourceJobId` and `dlqJobId` are the same?**

A misconfigured DLQ pointing back at itself (`createQueue('foo', {deadLetter: 'foo'})`) — pg-boss probably disallows this (`notStrictEqual(name, options.deadLetter)` in manager.js, line 658). But what about a consumer bug where they pass the same UUID twice to `recordDeadLetter`? Currently the writer just sets `deadLetteredAs: $self_id` on the row. That's a self-referencing audit row. Spec should either reject this in the writer or document it explicitly.

**4. No test for the spec's "Goal 2 + Goal 3 compose" claim.**

The whole composition story depends on writers playing nice with each other. Test plan should explicitly verify: (a) call Goal 2 first, then Goal 3, read merged result. (b) Call Goal 3 first, then Goal 2 — this is where blocker #1 surfaces.

**5. The README example uses `dlqJob.data._originalJobId` as a convention.**

The spec's README example (lines 188-198) shows the consumer pulling `sourceJobId` from `data._originalJobId`. This implies pg-boss copies through `data._originalJobId` from source to DLQ. It does — but only if the consumer set it. The spec gestures at "consumer's bookkeeping" but a real DLQ-handler that received the DLQ job without `_originalJobId` set has no way to call `recordDeadLetter` correctly. The README should explicitly state: "consumers MUST set a self-identifying field in the source job's `data` payload BEFORE the source is sent." This is a non-trivial discipline requirement that's currently buried in the example.

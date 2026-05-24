## Decision A — Dead-letter lineage

**Chosen option:** Option 3 — Encode the link in `terminal_detail` JSONB on the source job's final `failed` row

**Reasoning:** The trigger cannot reliably detect a DLQ INSERT. Looking at `plans.js`, the DLQ INSERT is `INSERT INTO pgboss.job (name, data, output, retry_limit, ...) SELECT r.dead_letter, data, output, ...` — it does not copy the source `id`, does not write any link column, and does not emit any signal a trigger on the DLQ row can see at INSERT time. The DLQ row's trigger fires with `NEW.name = <dlq_queue>`, `NEW.retry_count = 0`, `NEW.state = 'created'` — indistinguishable from any other created job. Attempting to infer the link by correlation (matching `data` JSONB) is fragile and wrong. The only place where the link is derivable is on the *source* job's terminal `failed` row, written *before* the DLQ INSERT, and that's where option 3 puts it: `{ class: 'transient', deadLetteredAs: '<new_uuid>' }`. But even there, the capture trigger does not see the DLQ UUID — the DLQ INSERT happens in the same CTE (`dlq_jobs`) that runs after `failed_jobs`, in the same statement, and the trigger on `failed_jobs` fires before `dlq_jobs` executes. The link cannot be populated automatically by any trigger on `pgboss.job` using only public columns. It requires an application-layer write: the consumer calls `recordTerminalDetail` on the source job with `{ class: 'transient', deadLetteredAs: <dlqId> }` — if they know the DLQ id, which they can't easily get from pg-boss's public API either. This is the honest position.

**Detection mechanism:** The capture trigger cannot detect a DLQ INSERT using only public columns. `NEW.name`, `NEW.state = 'created'`, `NEW.retry_count = 0`, and `NEW.data` are available, but the DLQ row is structurally identical to a regular `send()` at trigger time — no source link column is written into `pgboss.job` by `dlq_jobs`. Option 3 is chosen not because the trigger can auto-populate it, but because it is the lowest-cost schema (no migration) and places the link in the right row (source's terminal `failed` attempt). The link must be populated by application code that has knowledge of both IDs, not by pg-bossier automatically. Document this gap honestly; do not promise what the trigger cannot deliver.

**Backfill story:** No schema change, no backfill needed. Existing installs unaffected. New installs can start writing `deadLetteredAs` in `terminal_detail` immediately if they have the DLQ id from their application layer.

**What a `getRetryHistory(dlqJobId)` user gets back:** The DLQ job's own attempt rows only — its retry sequence if it was retried. The reverse lookup from DLQ to source is: find the source job whose `terminal_detail->>'deadLetteredAs' = dlqJobId` via a GIN index query on `pgbossier.record`. A sibling read method `findDeadLetterSource(dlqJobId)` is the right shape — a simple `WHERE terminal_detail @> '{"deadLetteredAs":"<id>"}'` with the existing `record_terminal_detail_gin` index.

**Strongest counter-argument against my own choice:** If the application layer never calls `recordTerminalDetail` with `deadLetteredAs`, the link is silently absent — this leaves consumers who don't write terminal detail in the dark with no fallback, which is worse than documenting a known gap in option 4.

---

## Decision B — Singleton supersession

**Singleton mechanism scoping:** The concrete displacement case is `singletonSeconds` / `singleton_on`. Looking at `plans.js`, the unique index `job_i4` is `(name, singleton_on, COALESCE(singleton_key, '')) WHERE state <> 'cancelled'`. When a new `send()` arrives for the same time window and `singleton_on` already has an active or queued row, `ON CONFLICT DO NOTHING` drops the *new* send silently — no row is written, no existing job is displaced. The same silent-drop behavior applies to `short` (index `job_i1` on `state = 'created'`), `stately`, `exclusive`, and `singleton` policies. These all reject the newcomer, not the incumbent. I do not know of a pg-boss mechanism that deletes an existing queued job and inserts a new one to replace it. `useSingletonQueue` is not a pg-boss 12 API surface I can verify in the current types — the types show `QueuePolicy` with `singleton`, not `useSingletonQueue`. In pg-boss 12, the displacement case I'd expect does not exist: the new send is dropped, not the existing job.

**Chosen option:** Option 4 — Document and ignore

**Reasoning:** If no pg-boss 12 mechanism actually displaces an existing job (the incumbent always wins when a policy conflict occurs), then there is no "displaced job" to mark. Adding a schema column or JSONB field to represent a relationship that never materializes is pure overhead. The honest answer is: `singletonKey` is available on `pgbossier.record` (it flows through the trigger as a column we could add to the capture), and consumers who want to correlate singleton key runs can query `WHERE data->>'singletonKey' = <key>` — or better, capture `singleton_key` into `pgbossier.record` as a plain column (a narrow schema addition that earns its keep for multi-consumer forensics). The "supersession" frame is a wrong model for how pg-boss policies actually work.

**Strongest counter-argument against my own choice:** If a future pg-boss version introduces a policy that genuinely displaces incumbents, we have no hook for it and would need a migration — option 2's dedicated columns would have been ready. But building for a pg-boss behavior that does not exist yet is exactly the kind of premature abstraction KISS rules out.

---

## Decision C — Reschedule semantics

**Chosen answer:** (a) — just another row-version with a new `started_on`, indistinguishable from a normal retry. A rescheduled or cron job goes through `state = 'created'` on INSERT, then `state = 'active'` on fetch — the same trigger-visible state transitions as any other job attempt. The `retry_count` is the disambiguator that already exists: attempt 0 is the first run, attempt N is the Nth. Cron jobs each get a fresh `id` on each scheduled send — they are not a single job being retried, they are distinct jobs. No additional marking needed. Adding a `rescheduled` flag would require the trigger to distinguish a pg-boss maintenance-generated INSERT from a consumer `send()` — which it cannot do from the public column surface without reading pg-boss internals.

---

## Bonus

- **`singleton_key` capture gap:** The capture trigger currently does not write `singleton_key` into `pgbossier.record`. Adding it as a plain nullable column is a small, non-breaking schema addition that would make singleton forensics (and any future supersession analysis) trivially queryable without a JSONB GIN path. Worth evaluating as a separate narrow PR.
- **DLQ gap disclosure:** The Goal 3 implementation should include an explicit section in the API docs: "pg-bossier cannot auto-populate the dead-letter link because pg-boss's DLQ INSERT carries no source id column. The link is consumer-supplied via `recordTerminalDetail`." Silence here would produce support tickets.

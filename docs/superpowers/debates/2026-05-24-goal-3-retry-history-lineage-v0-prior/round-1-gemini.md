# Round 1 — Gemini

## Decision A — Dead-letter lineage
**Chosen option:** 4. Do nothing (at the trigger level) / Document the gap.
**Reasoning:** Detection is impossible inside an `AFTER` trigger without forking `pg-boss`. When `pg-boss` moves a job to the dead-letter queue, it performs a standard `INSERT` of a new job with a fresh `id` and a payload (`data`) that wraps the original data but—crucially—does not include the source `job_id` in any public column. Since the trigger lacks a "Transitional" column linking the two, any attempt at correlation would be a non-deterministic guess based on timestamps and payloads, violating the "forensic" integrity of the chronicle.
**Detection mechanism:** It cannot be detected. `pg-boss` v12 internal `deadLetter()` logic inserts the new job into the `__dlq__` queue without exposing the source UUID to the database schema during that operation.
**Strongest counter-argument against my own choice:** Forensic value is significantly diminished for the most critical failure cases (DLQ), forcing users to manually correlate via `singletonKey` or business data in the `data` JSONB.

## Decision B — Singleton supersession
**Singleton mechanism scoping:** `pg-boss` does not actually "displace" (delete/replace) existing jobs via its singleton mechanisms. `singletonKey` (debounce) and `singletonSeconds` (throttle) are "First-In-Wins": if a qualifying job already exists, the `send()` call simply returns `null` and no database `INSERT` occurs. Consequently, there is no "displaced" job record for `pg-bossier` to mark.
**Chosen option:** 4. Document and ignore.
**Reasoning:** Since `pg-boss` rejects the *new* job rather than cancelling/displacing the *old* one, there is no state transition or new row for the trigger to capture. `pg-bossier` cannot record the history of a job that the underlying substrate refused to create.
**Strongest counter-argument against my own choice:** A user might expect `pg-bossier` to log the *attempt* to send a duplicate job, but doing so would require wrapping the `send()` method rather than relying on the database trigger.

## Decision C — Reschedule semantics
**Chosen answer:** (a) Just another row-version.
**Reasoning:** In `pg-boss`, a reschedule (whether via retry-delay or manual `startafter` update) is simply a state/metadata update to the existing row. The `retry_count` and `id` remain stable. Treating this as a normal row-version in `pgbossier.record` maintains the "forensic stream" without adding unnecessary complexity to the schema.

## Bonus: anything I'd add that wasn't asked
- **`pgbossier.link(sourceId, targetId)`:** Since the trigger cannot detect DLQ lineage, I would provide a sibling JS API method to manually record links in a lightweight `pgbossier.link` table. This allows users to explicitly bridge the gap when they handle DLQ jobs or manually "chain" jobs.
- **Data-Convention Linkage:** I propose that `pg-bossier` documents a "reserved key" in the `data` payload (e.g., `_pgbossier_source_id`). If the trigger detects this key in a new `INSERT`, it should automatically populate a `source_id` column in `pgbossier.record`. This enables opt-in lineage without forking.
- **Trigger Optimization:** For Decision C, the trigger should skip writing a new `record` row if *only* `keepuntil` or `expireat` changed, as these are "housekeeping" updates that don't represent a functional "attempt" transition.

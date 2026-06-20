# Round 2 — Opus

## My position changes (or doesn't) since Round 1

**Hold firm on A and B, sharpen A on the new evidence.** Sonnet's `dlq_jobs`-CTE discovery hardens my Round 1 argument rather than weakening it: the trigger genuinely can't ever know the DLQ id at the moment the source's `failed` row gets captured, because the DLQ INSERT doesn't exist yet in that SQL statement. That kills options 1, 2, and any "auto-populate option 3" reading — but it doesn't kill the **opt-in writer**, which runs later, from the DLQ worker's side, after the DLQ id exists. So I am where I was. **Where I sharpen:** I move from "new sibling method `recordDeadLetter`" to a position that takes the naming question seriously (see A1).

## Open question A1 — Writer or document?

**My answer:** **Ship the writer.** Codex's "document only" is the conservative-correct answer if shipping cost a schema change. It doesn't. The writer is a thin JS method that writes through Goal 2's already-existing `terminal_detail` slot. The gap is real and consequential for descent-app — forensic queries against DLQ jobs are exactly what its raw-SQL extraction is trying to clean up. The cost of shipping is one method + one read + ~50 lines of test. The cost of *not* shipping is "open an issue every time a consumer asks for DLQ lineage" forever.

**Naming if writing:** **New sibling method `recordDeadLetter({ sourceJobId, dlqJobId })`** — not an extension to `recordTerminalDetail`. Goal 2's `recordTerminalDetail` is state-bound by tagged union: caller must pass `{ state: 'failed', detail: { class, ... } }` and the writer maps state to allowed row states. Squeezing `deadLetteredAs` into that discriminated payload either breaks the union or forces callers to know the previous `detail` to preserve it (so they don't overwrite it). A focused sibling method that does a narrow JSONB merge (`UPDATE … SET terminal_detail = terminal_detail || jsonb_build_object('deadLetteredAs', $1)`) keeps `recordTerminalDetail`'s contract clean and gives the DLQ-link writer its own simple call site.

**Counter to the other camp (document only):** Codex's strongest line is "if pg-boss ever exposes a public source-id on DLQ jobs, this decision becomes obsolete immediately." True, but a one-method API surface is trivially replaced by trigger-side auto-population when that day comes — and we'd want the API alive in the meantime so descent-app stops carrying the gap.

## Open question A2 — Ship `findDeadLetterSource` read?

**My answer:** **Yes, ship now, same PR.** The asymmetry of writer-without-reader is the worst possible shape — consumers would have to roll their own GIN query against `terminal_detail`. The reader is one SQL line against the existing `record_terminal_detail_gin` index: `SELECT job_id, attempt FROM pgbossier.record WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text) LIMIT 1`. Returns the source `(jobId, attempt)`. From there, `getRetryHistory(sourceJobId)` gives the full retry chain. That's the descent-app forensic flow: "DLQ job X → who was I? → my full history."

## Open question A3 — Reserved data-key convention

**My answer:** **No, reject as primary mechanism. Mention as a possible escape hatch only.**

**Why:** Gemini's `_pgbossier_source_id` baked into `data` has three concrete problems. (1) It requires every consumer's `send()` site to opt in by mutating their data shape, which couples lineage to consumer-data contracts they may not own (legacy producers, third-party code). (2) The trigger would have to scan `data` JSONB on every INSERT to detect the key — that's a real (small but real) per-fire cost paid by *every* job, lineage-relevant or not. (3) It still doesn't solve the source→DLQ direction: pg-boss copies the source's `data` through into the DLQ row, so a `_pgbossier_source_id` set by the source would appear in the DLQ row claiming the source as its own source — meaningless. The writer API is explicit, post-hoc, and doesn't pollute data.

## Open question B1 — Capture `singleton_key` column

**My answer:** **Separate issue — not in this PR.** Sonnet is right that it's small. But Decision B = "no supersession to model" means the singleton-key capture isn't load-bearing for Goal 3; it's a correlation convenience for Goal 5-ish read patterns. Bundling unrelated schema changes under a Goal 3 PR muddies the diff and the rollback story. File it as a sibling issue; it'll move fast on its own.

## Open question C1 — Skip housekeeping-only UPDATEs

**My answer:** **Separate issue — goes to #21 (perf follow-ups), not here.** Decision C as agreed says "capture every row-version, no marker." That's correct for the storage contract. Skipping housekeeping UPDATEs is a perf optimization with its own correctness question (what counts as housekeeping? `keepuntil` only? what about NULL→value transitions?). It rides the perf-budget rail, not the lineage rail. Don't tangle them.

## Anything I want to flag that the synthesis must not lose

- **Fail-open is mandatory for the new writer.** `recordDeadLetter` failing must never propagate back to the DLQ worker's job processing. Log and continue.
- **`recordDeadLetter` should be idempotent** — calling it twice with the same `(sourceJobId, dlqJobId)` should produce one merged `deadLetteredAs` value, not duplicate or conflict. The JSONB merge handles this naturally.
- **The synthesis must explicitly state which compatibility tier each new pg-boss surface touches.** Reading `pgboss.queue.dead_letter` (if we ever do, e.g., for documentation generation) is Transitional. The new writer only writes to `pgbossier.record`, no pg-boss surface touched — Stable, by absence.

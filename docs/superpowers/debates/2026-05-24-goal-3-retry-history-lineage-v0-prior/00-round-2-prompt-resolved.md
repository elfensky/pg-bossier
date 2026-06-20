# Round 2 — Goal 3 retry history lineage (pg-bossier)

Round 1 produced strong convergence on the *what-the-substrate-can-do* questions and surfaced one new fact that changes Decision A's framing. Read the four Round 1 answers below, then **refine your position** with the new information in mind.

## What Round 1 established (strong agreement, four-of-four)

- **Decision A (trigger detection):** the capture trigger **cannot** auto-populate a source→DLQ link using only pg-boss public columns. **New load-bearing fact from Sonnet (read out of `pg-boss/src/plans.js`):** the DLQ INSERT lives in a `dlq_jobs` CTE that runs *after* `failed_jobs` in the **same SQL statement**. So the trigger on the source's failed row fires *before* the DLQ row exists — even if we wanted to write `{ deadLetteredAs: <dlqId> }` to `terminal_detail` automatically, the trigger doesn't yet have the DLQ id.

- **Decision B (singleton):** no pg-boss 12 mechanism actually displaces an existing job. `ON CONFLICT DO NOTHING` on the `(name, singleton_on, COALESCE(singleton_key, ''))` unique index (`job_i4`) drops the **newcomer**, never the incumbent (`pg-boss/src/plans.js`). `singletonKey`, `singletonSeconds`, `singleton`, `short`, `stately`, `exclusive` all behave this way. `useSingletonQueue` is not part of the pg-boss 12 type surface.

- **Decision C (reschedule):** answer (a) — same row-version of the same id. No marker. All four agree.

## Where you may still disagree (this is where Round 2 work is)

### Open question A1 — Ship the writer API, or document the gap?

Two camps in Round 1:
- **Gemini, Codex:** Decision A = Option 4 ("do nothing"). Document the gap; defer the writer until pg-boss exposes a public source-id or a real consumer request lands.
- **Opus, Sonnet:** ship an **opt-in writer** — Opus calls it `bossier.recordDeadLetter({ sourceJobId, dlqJobId })`; Sonnet routes it through the existing `recordTerminalDetail` writer with `{ deadLetteredAs }`. Storage in `terminal_detail` on the source's last `failed` row.

**Refine:** if you're in the "document" camp, do you change position now that Opus/Sonnet have proposed a concrete writer that costs no schema change and no trigger work? If you're in the "ship the writer" camp, do you ship `recordDeadLetter` as a new sibling method, or extend `recordTerminalDetail` to accept `deadLetteredAs`? Pick one. Name it.

### Open question A2 — Reverse lookup `findDeadLetterSource(dlqJobId)`?

Both Opus and Sonnet propose a sibling read (`getDeadLetterSource` / `findDeadLetterSource`) that scans `pgbossier.record` for `terminal_detail @> '{"deadLetteredAs": <id>}'` using the existing `record_terminal_detail_gin` index. Gemini and Codex didn't address this.

**Refine:** is this read worth shipping in the same PR as the writer? What's the descent-app forensic use-case it actually solves?

### Open question B1 — Capture `singleton_key` as a plain column?

Sonnet's Round 1 bonus: "the capture trigger currently does not write `singleton_key` into `pgbossier.record`. Adding it as a plain nullable column is a small, non-breaking schema addition that would make singleton forensics (and any future supersession analysis) trivially queryable without a JSONB GIN path."

**Refine:** does this earn its keep under KISS, given Decision B = "ignore supersession"? Or is it an unrelated improvement that should live in a separate issue?

### Open question A3 — Gemini's "reserved data key" convention

Gemini's Round 1 bonus: pg-bossier documents a reserved key in the `data` payload (e.g., `_pgbossier_source_id`). If the trigger detects this key in a new INSERT, it auto-populates a `source_id` column. Enables opt-in lineage without forking.

**Refine:** is this a better shape than the writer API? It moves the consumer's bookkeeping into the `data` they already control. Critique it.

### Open question C1 — Skip housekeeping-only UPDATEs?

Gemini's Round 1 bonus: "the trigger should skip writing a new `record` row if *only* `keepuntil` or `expireat` changed." Not strictly a Goal 3 question, but if it lands the answer to Decision C should account for it.

**Refine:** scope creep or genuine improvement?

## Constraints (unchanged from Round 1, restated for completeness)

- No fork of pg-boss; public JS API + transitional reads only.
- KISS — three lines beat an abstraction.
- Fail-open writes.
- Composition not replacement.
- No backfill obligation by default.

## Response format

~600–800 words.

```
## My position changes (or doesn't) since Round 1
[2-4 sentences. If you change a position, say which decision and why. If you don't, say what you're holding firm on and why the others' arguments don't move you.]

## Open question A1 — Writer or document?
**My answer:** [pick one + 2 sentences]
**Naming if writing:** [recordDeadLetter as new sibling | extend recordTerminalDetail with deadLetteredAs field]
**Counter to the other camp:** [1-2 sentences naming the strongest opposing point and why it doesn't move you]

## Open question A2 — Ship findDeadLetterSource read?
**My answer:** [yes ship now | yes but later | no]
**Why:** [1-2 sentences, tie to descent-app use case]

## Open question A3 — Reserved data-key convention
**My answer:** [yes adopt | no reject | combine with writer]
**Why:** [1-2 sentences with concrete critique]

## Open question B1 — Capture singleton_key column
**My answer:** [yes in this PR | yes separate issue | no don't bother]
**Why:** [1-2 sentences]

## Open question C1 — Skip housekeeping UPDATEs
**My answer:** [in scope here | separate issue | reject]
**Why:** [1 sentence]

## Anything I want to flag that the synthesis must not lose
[optional, 1-3 bullets]
```

Be sharp. If you disagree with another participant's specific claim, name the participant and the claim. Don't restate everything — the synthesis will see all four answers.

---

# Round 1 answers (verbatim)

## 🟡 Gemini — Round 1

```
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
```

## 🔴 Codex — Round 1

```
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
```

## 🟠 Sonnet — Round 1

```
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
```

## 🐙 Opus — Round 1

```
# Round 1 — Opus

## Decision A — Dead-letter lineage

**Chosen option:** A new **option 5** the prompt didn't list: **opt-in JS writer API `bossier.recordDeadLetter({ sourceJobId, dlqJobId })` that stores the link in `terminal_detail` on the source's final `failed` attempt row.** Trigger does *nothing* automatic for DLQ. No schema change.

**Reasoning:** None of options 1/2/3 hold up to the detection question. The trigger sees a fresh `INSERT` into `pgboss.job` with a new `id`. To know that row is a DLQ landing, the trigger has to (i) know which queues are DLQ targets and (ii) recover the source job's id. (i) is a transitional-tier read from `pgboss.queue.dead_letter` — fine. (ii) is the killer: pg-boss does **not** write a source_id onto the new DLQ row. The DLQ row's `data` is just the source's `data` copied through; the source's `id` is gone. Any trigger-side reconstruction (matching by `data` shape, by recency window, by transaction-local temp state) is either lossy or fragile under concurrency. A schema column or link table you can't reliably populate is worse than no column at all. The link information *does* exist — but at the DLQ-worker boundary, not at the source job's death. So write it there, on purpose, through a thin API.

**Detection mechanism:** Not from the trigger. The consumer's DLQ worker receives the DLQ job, knows (via `data` or its own bookkeeping) which source job it corresponds to, and calls `bossier.recordDeadLetter({ sourceJobId, dlqJobId })`. The writer UPDATEs the source's last `failed` attempt row's `terminal_detail` to add `{ deadLetteredAs: <dlqJobId> }`, and optionally upserts a forward index on the DLQ row.

**What `getRetryHistory(dlqJobId)` returns:** by default, only the DLQ job's own attempts. A new sibling read `getDeadLetterSource(dlqJobId)` returns the source job's id (resolvable from `data` if descent-app puts it there, or from a forward index). A `getRetryHistory(sourceJobId)` user sees `{ deadLetteredAs: <dlqJobId> }` on the source's terminal row — one hop away from the full DLQ chronicle.

**Backfill:** none. Pre-existing rows simply lack `deadLetteredAs`. Consumers opt in by calling the writer in new DLQ-handler code.

**Cost at trigger fire time:** zero — trigger is unchanged.

**Strongest counter-argument against my choice:** it pushes work onto every consumer that wants DLQ lineage, and a DLQ worker that forgets to call the writer creates silent gaps. A trigger-side "best effort" guess (e.g., matching by `data` checksum within the transaction) might be wrong sometimes but would never be silently empty. I think wrong-sometimes is worse than empty-by-default for a forensic store, but it's debatable.

## Decision B — Singleton supersession

**Singleton mechanism scoping:** I don't believe pg-boss 12's documented singleton mechanisms produce a "displaced cancelled" row in the common path. `singletonKey` (and `singletonKey + singletonSeconds`) cause the **second `send()` to return `null`** — the new job is rejected, the old one stays. `singletonNextSlot` *defers* the new send to the next slot, no displacement. `useSingletonQueue` enforces one-active-per-queue at fetch time — again, no displacement of a pending row. The only pg-boss case I'm aware of that resembles displacement is **cron schedule changes** that may cancel pending scheduled instances when the schedule definition is rewritten; that's a niche of `schedule()`, not of `send()`, and arguably is a `cancelled` row whose reason is "schedule rewritten."

**Chosen option:** **Option 4 — document the absence and do nothing in the substrate.** If a real displacement case surfaces from a consumer (cron rewriting included), the answer at that point is option 1 (marker in `terminal_detail`, leveraging Goal 2's writer), not a schema change.

**Reasoning:** building a schema column or trigger logic for a case that doesn't reliably exist is the exact "abstraction for hypothetical future needs" the project rules forbid. The COMPATIBILITY.md mention of `expired`/`superseded` as "pg-bossier-derived markers" is forward-looking, not load-bearing today.

**Strongest counter-argument against my choice:** I may be wrong about the singleton semantics — Sonnet is reading the source and Codex has direct pg-boss knowledge; one of them probably catches a case I missed. If `useSingletonQueue` or a newer mechanism does displace, option 1 (terminal_detail marker) becomes the right call without a schema change.

## Decision C — Reschedule semantics

**Chosen answer (a):** just another row-version of the same id with a new `started_on`. No distinct marker in the substrate. A reschedule is, from pg-boss's perspective, an UPDATE that resets `start_after` (and possibly `state` back to `created`). The capture trigger picks this up exactly like any other state transition. Consumers who want a "this was rescheduled" marker can write it via `terminal_detail` extended for non-terminal states, or derive it by inspecting the state sequence (`active` → `created` is a clear rescheduling fingerprint). Don't pay schema or trigger cost for derivable signal.

## Bonus: anything I'd add

- **A `getDeadLetterSource(dlqJobId)` sibling read** is the asymmetric counterpart to `getRetryHistory` and is what descent-app's forensic UI actually wants. Worth scoping into this issue, not punting.
- **Naming:** if we land the writer API for Decision A, it should be `recordDeadLetter` (verb-object, matches `recordTerminalDetail` from Goal 2), not `linkDeadLetter` or `markDeadLetter`. Consistency with Goal 2's surface matters more than the most natural English.
- **Failure mode:** the writer must be fail-open (consistent with the substrate). If `recordDeadLetter` fails, the DLQ job still gets processed; the link is just missing. Document that loudly.
```

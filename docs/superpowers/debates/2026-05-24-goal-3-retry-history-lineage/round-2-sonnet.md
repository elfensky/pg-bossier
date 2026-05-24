# Goal 3 Adversarial Review — Round 2 (Sonnet)

## Round 2 verdict

BLOCK-UNTIL — unchanged. The merge-overwrite blocker is real and the fix choice has a clear winner. One of Opus's three blockers (re-DLQ ambiguity) dissolves on examination. The other two survive. Cardinality is 1:1 with an explicit idempotency contract. Must-land list is tightened below.

---

## Concessions

**1. Opus on cardinality — partially concede.**

My R1 did not address cardinality. Opus raises it and the question is real. I am conceding that the spec needs an explicit idempotency contract for the "same source, second `recordDeadLetter` call" case — but I am NOT conceding that plural cardinality is required (see Rebuttals below).

**2. Opus on `_originalJobId` as implicit consumer contract — concede.**

My R1 mentioned `_originalJobId` in the "What does NOT change" framing but did not call it out as an implicit contract consumers must satisfy before the source job is sent. Opus is right that this is buried in the README example and needs surface-level documentation. The spec's success criterion ("one typed query answers the forensic question") fails silently if the consumer never wrote `_originalJobId` into the source's `data`. This should be a named doc requirement, not a gestured-at convention.

**3. Gemini on `findDeadLetterTarget` — partial concede.**

I deferred this in R1. After reading Gemini's framing ("logical mirror, trivial to implement, answers 'what did this job become?'"), I agree it belongs in the same spec unit if we agree on 1:1 cardinality — at 1:1 it is two lines of SQL and its absence is a genuine ergonomic gap. However, I maintain it is not a blocker and should stay in the "should-land" tier rather than must-land. Concede only on "should ship in v1."

---

## Rebuttals

**1. Opus on "re-DLQ produces two rows with the same `deadLetteredAs`" — rebut.**

Opus's scenario: DLQ job B is itself dead-lettered later, making two source rows carry `deadLetteredAs: B`. Therefore `findDeadLetterSource(B)` with `LIMIT 1` returns the wrong row.

This is not a re-DLQ scenario — it is a confusion between two distinct relationships:

- `source_A.terminal_detail.deadLetteredAs = B` — written by DLQ handler for B (when A failed and produced B).
- `source_B.terminal_detail.deadLetteredAs = C` — written by DLQ handler for C (when B itself failed and produced C).

`findDeadLetterSource(B)` queries `WHERE terminal_detail @> {deadLetteredAs: B}`. Only source_A has that value. source_B has `{deadLetteredAs: C}`. There is no ambiguity; the `LIMIT 1` without ORDER BY is a style issue (and I named it in R1), not a cardinality issue. Opus's scenario requires two *different* sources to both have recorded the same dlqJobId — which would require two separate source jobs to somehow both fail and produce the exact same DLQ job UUID. That is impossible under Postgres UUIDs.

My R1 multi-hop position ("each call walks one hop, forming a traversable chain") is correct. Opus's chained-DLQ claim and my position are about different shapes. They are compatible: my position describes the normal hop-by-hop chain; Opus describes a scenario that cannot occur because UUID collision is impossible.

**What does survive from Opus's point:** the `LIMIT 1` without `ORDER BY` is still sloppy. Defensive `ORDER BY captured_at DESC` is right hygiene even if normal operation never surfaces two rows. I named this in R1; it stands.

**2. Opus on plural cardinality (`string[]`) — rebut.**

Opus's argument: a source job could, in principle, produce multiple DLQ jobs (manual ops re-dispatch, or some future multi-DLQ-target scenario), so `deadLetteredAs` should be an array.

The spec is explicit in "Decisions locked" section 1: pg-boss 12's `failJobs` CTE emits exactly one DLQ INSERT per final failure — one source row, one DLQ job, per pg-boss execution. The plural case (a source that reaches `failed` multiple times across retry cycles and each time triggers a separate DLQ job) does not happen in pg-boss 12 because the source row is deleted-and-reinserted on retry; each retry is a new attempt that can produce at most one DLQ. The chronicle captures each attempt as a separate row. Each attempt's `terminal_detail` can carry its own `deadLetteredAs`. The "multiple DLQ ids per source" case is already handled by the per-attempt storage model — not by making the field plural on a single row.

The 1:1 constraint also makes `findDeadLetterTarget(sourceJobId)` trivially expressible. If we go plural, that reader becomes `findDeadLetterTargets` (plural), and the spec's composition story gets more complex for no benefit against any pg-boss 12 scenario.

**3. Gemini on "extend `recordTerminalDetail` with a `deadLetteredAs` field" — rebut (carry from R1).**

Gemini was outvoted 3-of-4 in the prior debate. For completeness: the DLQ-handler call site has neither `attempt` nor a valid `class`-bearing payload. Extending `recordTerminalDetail` would require the DLQ handler to supply those. The adoption-killing cost is the reason for a sibling method. This position is unchanged and is now locked in the spec.

---

## Position: how to fix the merge issue (blocker 1)

**OPTION-A: Update `recordTerminalDetail` to use JSONB merge.**

Change line 100 in `src/terminal-detail.ts` from:

```sql
SET terminal_detail = $4::jsonb
```

to:

```sql
SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb
```

Opus raised the objection that this changes Goal 2's "last-writer-wins on the full object" semantic: calling `recordTerminalDetail` twice with different payloads would now produce a merged result rather than the second overwriting the first. That objection is correct but the changed semantic is *better*, not worse. Goal 2's contract says the field captures "the worker's classification of the terminal state." A second call to `recordTerminalDetail` on the same row is either a bug (wrong jobId/attempt supplied) or a deliberate enrichment (the worker wants to add fields). In neither case should the second write silently destroy the first. Key-level merge makes both calls additive, which is the right behavior for an audit field that multiple code paths might write to.

The one case that does change: `recordTerminalDetail({state: 'failed', detail: {class: 'non_retryable'}})` followed by `recordTerminalDetail({state: 'failed', detail: {class: 'transient'}})` on the same row. With overwrite, the second wins. With merge, both keys exist and `class` gets the SECOND value (because `{class: 'non_retryable'} || {class: 'transient'}` = `{class: 'transient'}`). So `class` IS still last-writer-wins at the key level, which is the correct behavior — the worker's most recent classification wins per-key. This is the right semantic.

OPTION-B (mandate ordering, make `recordTerminalDetail` the sole pre-condition of `recordDeadLetter`) is fragile across process boundaries and contradicts the spec's "call from DLQ-handler" pattern. DLQ-handlers run in different processes than the failure-time worker. Ordering across them is not enforceable.

OPTION-C (separate column `dead_letter_link`) contradicts the "no schema change" claim and removes the natural ergonomic advantage of a self-describing `terminal_detail`. The forensic query for a DLQ source would then need to join two columns.

OPTION-A is the right fix. It is a two-line change to `src/terminal-detail.ts`. The semantics are strictly better. The spec's "associative merge" claim becomes true.

---

## Position: cardinality (1:1 vs plural)

**SINGLE.**

Rationale already given in Rebuttals above. pg-boss 12 produces exactly one DLQ job per final-failure event. The per-attempt row model in `pgbossier.record` means multi-DLQ cardinality is already handled by storage structure, not by making the field plural. The 1:1 constraint enables the simple reader signatures and the `findDeadLetterTarget` mirror.

What the spec MUST add (not a plural change, but a contract clarification): `recordDeadLetter` called a second time on a source that already has `deadLetteredAs` set should be documented explicitly. The current JSONB `||` merge behavior means the second call overwrites the id if the caller passes a different `dlqJobId`, or is a no-op at the value level if the same id is passed (SQL runs, data unchanged). For the case where `dlqJobId` differs (consumer bug), this is silent data corruption. The writer should check whether `deadLetteredAs` is already set and either raise a warning or treat the call as a no-op if the value conflicts. Document the behavior explicitly either way.

---

## Final must-land list

1. **Fix `recordTerminalDetail` to use JSONB merge (OPTION-A).** `src/terminal-detail.ts` line 100: `SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb`. Blocker — the spec's "associative merge" claim is false without it.

2. **Add `deadLetteredAs?: string` to `TerminalDetailFailed` type.** `src/terminal-detail.ts` lines 27–31. Two lines. Same commit as the writer. A named documented field on the type, not an `unknown` escape hatch.

3. **Explicit idempotency contract for conflicting second writes.** The writer must document (and implement) behavior when `recordDeadLetter` is called on a source row that already has a *different* `deadLetteredAs` value. Recommended: log a warning and treat as no-op (fail-open, don't overwrite an existing link with a different id). This protects against consumer bugs where the DLQ-handler retries with a new dlqJobId.

4. **`findDeadLetterSource` SQL: add `ORDER BY captured_at DESC`.** The `LIMIT 1` without ordering is non-deterministic in the presence of bugs. Defensive ordering is one word. Low-risk change, closes the nit.

5. **Include `queue` in `findDeadLetterSource` return type.** `{ jobId: string; attempt: number; queue: string } | null`. Zero extra SQL cost (column is on the same row); removes a round-trip in the most common forensic flow.

6. **README/JSDoc: make the `_originalJobId` consumer requirement explicit.** State clearly: "The DLQ worker needs to know the source job's id at handle-time. pg-bossier does not supply this — it is the consumer's responsibility to encode it in the source job's `data` payload before calling `boss.send()`." This is the only contract the spec currently buries.

7. **Test: write-then-overwrite scenario.** Cover the case where `recordDeadLetter` is called twice with two different `dlqJobId` values for the same source. Verify whichever behavior (no-op or last-wins) is the one documented.

8. **Spec note on `progress` column non-interaction.** One sentence in "What does NOT change": `progress` is not copied from source to DLQ job. DLQ job's progress history starts fresh. Prevents implementers from thinking the omission was accidental.

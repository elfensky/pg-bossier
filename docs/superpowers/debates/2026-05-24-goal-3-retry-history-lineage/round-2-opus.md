# Round 2 — Opus rebuttal / concession (Goal 3)

## Round 2 verdict

BLOCK-UNTIL (same as R1)

All three reviewers converged in R1 on the merge-vs-overwrite blocker. The remaining R2 work is to pick the FIX shape and resolve the cardinality / chained-DLQ ambiguities. After reading Gemini and Sonnet's R1s, I'm narrowing my R1 positions on two items and conceding one.

---

## Concessions

**1. Sonnet on the `findDeadLetterSource` non-deterministic LIMIT 1 — concede.**

My R1 raised the chained-DLQ duplicate-source case but framed it as a writer issue. Sonnet's R1 §"Anything missed" #2 names the same problem at the READER: `LIMIT 1` without `ORDER BY` is non-deterministic if any duplicate exists. Adding `ORDER BY captured_at DESC` to the reader is cheap and removes the non-determinism regardless of which writer-side fix lands. Should be in the must-land list as a cheap defensive fix.

**2. Sonnet on the `progress` interaction — concede as a should-land.**

My R1 didn't address what happens to `progress` data across the DLQ hop. Sonnet's R1 §"Anything missed" #4 is right: a one-sentence "What does NOT change" entry stating that the DLQ job starts with no progress (it's a new job; its row gets a fresh chronicle entry) prevents implementer confusion. Add to the spec's "What does NOT change" section.

**3. Sonnet on the retry-redrive case — concede the README addition.**

Sonnet's industry-comparison section names an operational pattern I missed: AWS SQS redrive (moving DLQ messages back to the source queue) maps onto pg-boss's `boss.retry(dlqJobId)`. Sonnet correctly notes our design is unaffected by this and the existing `deadLetteredAs` on the source row stays valid. Adding one sentence to the README makes this explicit. Cheap.

**4. Gemini's industry-comparison framing on Sidekiq / BullMQ — concede partial.**

Gemini's framing — "lineage is a non-issue for those tools because the job id is immutable" — is more precise than mine. The pg-boss "new id" model is the source of our problem; Sidekiq / BullMQ avoid the problem by not creating a new id. My R1 said pg-boss's model is "unusual"; Gemini's framing names exactly WHY it's unusual. The spec's industry-comparison section (if added) should use Gemini's framing.

---

## Rebuttals

**1. Sonnet on multi-hop NOT being a problem — partial rebut.**

Sonnet R1 §"Anything missed" — claims multi-hop works correctly because "each `findDeadLetterSource` call walks one hop." That's TRUE for a linear chain (A → B → C, no re-DLQ at any node). It's FALSE for the case I named: a DLQ job re-fails and is itself dead-lettered into the same DLQ queue. Concretely:

```
Source job A fails → DLQ job B in queue dlq1
DLQ job B fails → DLQ job C in queue dlq1 (same queue)
```

Now both A's `terminal_detail` row AND B's `terminal_detail` row carry `deadLetteredAs: <B's id or C's id>`. Whichever comes first in the index is what the reader returns. The non-determinism Sonnet flagged on `LIMIT 1` is the same root cause. So we agree on the symptom (non-deterministic reader), we disagree on the root cause framing (Sonnet: "improbable bug producing duplicates"; Opus: "real pattern under operational re-dispatch"). My framing matters because it argues for a structural prevention (uniqueness constraint or `WHERE NOT EXISTS` check at write time), not just an `ORDER BY`.

**Mitigation either way:** the `ORDER BY captured_at DESC` (Sonnet's fix) ALSO chooses the most-recent source, which in the chained case is the right answer (B is the more-recent ancestor of C than A is). So Sonnet's cheap fix coincidentally handles my case too. **Conceding the practical outcome; rebutting only the framing.**

**2. Gemini on `recordTerminalDetail` being the writer to change (Gemini's blocker 1) — rebut.**

Gemini's blocker 1 says "Change `recordTerminalDetail` implementation to use JSONB merge." This is one of four possible fixes. Gemini frames it as obvious. Three problems with that framing:

a. Changing Goal 2's writer to merge SILENTLY REVERSES Goal 2's documented "last-writer-wins" semantic. Goal 2's test 8 ("Concurrent calls — last-writer-wins") asserts the second call's payload is what the reader returns. After this change, the second call's payload merges into the first's — old keys not in the new payload survive. That's a documented behavior change to a shipped feature.

b. The merge semantic in Goal 2 has a different valid use case from Goal 3's: if a worker calls `recordTerminalDetail({state: 'failed', detail: {class: 'transient', message: 'attempt 1'}})` then later calls `recordTerminalDetail({state: 'failed', detail: {class: 'non_retryable', message: 'attempt 2 made it permanent'}})`, the consumer EXPECTS the second call to fully replace the first's classification. Under merge semantics, that's broken — `class` updates but `message: 'attempt 1'` would survive if the second payload didn't include `message`. Goal 2's overwrite IS the right call for Goal 2's contract.

c. The cleanest fix is the OTHER direction: have `recordDeadLetter` perform the merge (it already does in the spec's SQL sketch), and document that `recordTerminalDetail` MUST be called BEFORE `recordDeadLetter` for the same source row. The natural lifecycle puts `recordTerminalDetail` at failure-time and `recordDeadLetter` at DLQ-handle-time, which is after by definition (the DLQ job only exists after the source committed failed). The "either order" claim in the spec is wrong; the spec should say "`recordDeadLetter` must be called after the source's terminal_detail has been signaled (if at all)."

This is my OPTION-B below.

**3. Sonnet on storing only `dlqJobId` (vs Opus's "add `dlqQueue`") — strengthen, partial rebut.**

Sonnet's "Should-land #2" supports adding `queue` to the READER's return type. My R1 §"Anything missed" #1 advocated storing `dlqQueue` at WRITE time (in the JSONB value itself). These are different things:

- Sonnet's fix: reader does an additional SELECT of `record.queue` for the matched row. Costs zero extra storage. Costs one column in the SELECT projection. Right answer for self-describing return types.
- Opus's fix: writer stores `{dlqJobId, dlqQueue}` in the JSONB. Costs ~30 bytes per write. Makes the JSONB self-describing without a JOIN.

Sonnet's is the simpler and right approach. The JSONB stays minimal; the reader does the work. **Concede that direction; my R1 framing was over-engineered.** What we both agree on: the consumer should be able to get `queue` from `findDeadLetterSource` without a second round-trip.

---

## Position: how to fix the merge issue (blocker 1)

**OPTION-B — Mandate ordering. `recordTerminalDetail` runs first (if at all), `recordDeadLetter` runs after.**

Justification:

1. **Preserves Goal 2's contract.** Goal 2's "last-writer-wins on the full terminal_detail object" semantic remains intact. No existing tests break. No documentation rewrites.

2. **Matches the natural lifecycle.** A worker calls `recordTerminalDetail` at failure-time (synchronous with `boss.fail`). The DLQ job only exists AFTER the source committed `state='failed'`. The DLQ-handler that calls `recordDeadLetter` necessarily runs after that. The temporal order is structurally enforced by pg-boss's flow.

3. **Cross-process ordering concern.** What if the worker calls `recordTerminalDetail` LATE — e.g., after the DLQ-handler has already received the job and called `recordDeadLetter`? This is theoretically possible if the worker has retry-aware delayed bookkeeping. But it's an antipattern: terminal detail should be written at failure-time, not after the fact. The README + JSDoc should explicitly name this and recommend the failure-time call.

4. **`recordDeadLetter` is then the only merger.** Its SQL already does the right thing (`COALESCE(...) || jsonb_build_object(...)`). No code change in Goal 2.

**What this rejects:**

- OPTION-A (merge in Goal 2): reverses Goal 2's documented contract. Too invasive.
- OPTION-C (separate column): adds a schema change, contradicting the spec's "no schema change" claim. Worse architectural footprint than necessary.

**What this requires:**

- Spec edit: remove the "either order" claim. Replace with "`recordDeadLetter` MUST be called after the source's `recordTerminalDetail` (if any). Calling them in reverse order is undefined behavior."
- Test: assert that calling them in the wrong order produces the overwrite (documented behavior, not a bug).

---

## Position: cardinality (1:1 vs plural)

**SINGLE (1:1).**

I argued for plural in R1, but on reflection:

- Sonnet's industry-comparison framing matters: pg-boss's DLQ creates ONE new job per source failure. The 1:1 cardinality matches pg-boss's actual behavior.
- The "manual ops re-dispatch" scenario I named (one source spawning multiple DLQ jobs over time via manual re-fails) is NOT something pg-bossier should design for in v1. It's a consumer-pattern edge case.
- If it ever matters, JSONB extension is cheap (add a `deadLetteredHistory: Array<...>` field next to `deadLetteredAs`). Future-compatible without committing now.

**Concede to the natural 1:1 cardinality.**

---

## Final must-land list

1. **Adopt OPTION-B for the merge issue.** Spec edits:
   - Remove the "both writers can be called in either order; the merge is associative" claim. Replace with explicit ordering requirement.
   - Remove the symmetric-merge example from the composition section.
   - Add a test that asserts the documented overwrite behavior when called in reverse order (so the contract is locked in).

2. **Add `deadLetteredAs?: string` to `TerminalDetailFailed`** in `src/terminal-detail.ts`. Two reviewers raised this.

3. **`findDeadLetterSource` must `ORDER BY captured_at DESC LIMIT 1`** — defensive against any duplicate-source edge case.

4. **`findDeadLetterSource` return type expands to `{jobId: string; attempt: number; queue: string} | null`** — Sonnet's R1 should-land #2.

5. **Spec must explicitly name the ordering requirement in the README's "Recording dead-letter lineage" section.** Loud documentation that calling `recordDeadLetter` BEFORE `recordTerminalDetail` overwrites the terminal_detail payload.

6. **Spec must add a sentence in "What does NOT change" stating that DLQ jobs have their own progress (Goal 6) chronicle and don't inherit the source's progress.** Sonnet's R1 should-land #4.

7. **Distinguish "source not found" from "DB error" in the writer's fail-open log.** Sonnet's R1 should-land #1. Cheap.

8. **Test plan additions** (Sonnet + Opus both flagged):
   - Concurrent recordTerminalDetail + recordDeadLetter on same source (verifies overwrite semantic from OPTION-B is locked).
   - Source row was deleted/purged between failure and DLQ-handler call (silent no-op).
   - Chained DLQ (A → B → C) with each hop calling recordDeadLetter.

9. **README must explicitly state the consumer contract** that they pass `sourceJobId` from their own bookkeeping (typically `data._originalJobId` set at send time). Opus R1 §"Anything missed" #5.

10. **No `dead_letter_source_id` schema column.** No separate JSONB column. No trigger-side correlation. Stay with the app-layer writer-only path. 3-of-3 verified the impossibility.

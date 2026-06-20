# Adversarial review — synthesis (Goal 3 retry history)

**Spec under review:** [`docs/superpowers/specs/2026-05-24-goal-3-retry-history-lineage-design.md`](../../specs/2026-05-24-goal-3-retry-history-lineage-design.md)
**Participants:** Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet via Agent), Opus (Claude Opus, this session)
**Codex CLI:** unavailable this round due to repeated CLI failures (output capture issues). Effectively a 3-way debate.
**Rounds:** 2 (attack + rebuttal)
**Prior debate:** archived at `2026-05-24-goal-3-retry-history-lineage-v0-prior/` (from earlier session)

## Headline

The architectural shape (app-layer writer + reader composing with Goal 2's JSONB column) is sound. **The spec has one critical implementation defect** that 3-of-3 reviewers identified in R1 with strong convergence — the spec's "associative merge" claim is structurally false against the code Goal 2 actually shipped. The fix is small and the reviewers converged on OPTION-A by R2 (2-of-3 explicit; Opus dissented in favor of OPTION-B then was persuaded by Sonnet's correction on the semantics — see synthesis note below).

## Verdicts

| Reviewer | Round 1 | Round 2 | Movement |
| --- | --- | --- | --- |
| Gemini | SHIP-WITH-NAMED-CHANGES | SHIP-WITH-NAMED-CHANGES | unchanged |
| Sonnet | BLOCK-UNTIL | BLOCK-UNTIL | unchanged |
| Opus | BLOCK-UNTIL | BLOCK-UNTIL | unchanged |
| Codex | (CLI failure) | (CLI failure) | n/a |

Two BLOCK + one SHIP-WITH-NAMED-CHANGES. The change list is identical across all three; the verdict difference is semantic.

## Unanimous must-land changes

All three reviewers named these in some form. Spec v2 must include them.

**1. Change Goal 2's `recordTerminalDetail` to use JSONB merge.** `src/terminal-detail.ts:100` currently does `SET terminal_detail = $4::jsonb` — blind overwrite. The fix:

```sql
SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb
```

This is **OPTION-A**. 2-of-3 picked it explicitly (Gemini, Sonnet); Opus argued for OPTION-B (mandate ordering instead) in R2 but Sonnet's defense of OPTION-A is the deciding argument:

> Goal 2's `class` field doesn't survive incorrectly under `||`. JSONB `||` does *key-level* overwrite: `{class: 'non_retryable'} || {class: 'transient'}` = `{class: 'transient'}`. So the second call's class wins at the key level, which is the correct behavior for an audit field. Goal 2's documented "last-writer-wins" semantic survives at the key level; it only changes at the "wipe-out-old-keys-not-in-the-new-payload" level — which is not what consumers actually want (`recordTerminalDetail({class: 'transient'})` followed by `recordTerminalDetail({message: 'enriched'})` should produce both fields, not lose `class`).

This corrects Opus's R1+R2 framing. The semantic change is an improvement, not a regression. OPTION-B (mandate ordering across processes) is fragile and contradicts the spec's "call from DLQ-handler" pattern. OPTION-C (separate column) contradicts the spec's "no schema change" promise. OPTION-A is the right fix.

**2. Add `deadLetteredAs?: string` to `TerminalDetailFailed`.** `src/terminal-detail.ts` lines 27–31. Two lines. Named documented optional field, not an `unknown` escape hatch. All three reviewers raised this.

**3. Add `ORDER BY captured_at DESC` to `findDeadLetterSource` SQL.** The current `LIMIT 1` without ordering is non-deterministic in the (improbable but possible) presence of duplicates. Defensive hygiene, one keyword. All three flagged.

**4. Expand `findDeadLetterSource` return type to include `queue`.** Current `{jobId, attempt} | null` becomes `{jobId, attempt, queue} | null`. Zero extra SQL cost (column is on the same row); removes a round-trip in the most common forensic flow. All three agreed.

**5. Make the `_originalJobId` consumer contract explicit.** Today the spec buries the requirement in a README example. Three reviewers all said this needs surface-level documentation:

> "The DLQ worker needs to know the source job's id at handle-time. pg-bossier does not supply this — it is the consumer's responsibility to encode it in the source job's `data` payload before calling `boss.send()`."

Surface this in README + JSDoc on `recordDeadLetter`. Cannot stay buried in an example.

## Cardinality decision: 1:1 (single, not plural)

**3-of-3 unanimous after R2.** Opus argued for plural in R1, conceded in R2 after Sonnet's argument:

> pg-boss 12's `failJobs` CTE emits exactly one DLQ INSERT per final failure. The "multiple DLQ ids per source" scenario is handled by the per-attempt row model in `pgbossier.record` — each retry attempt is a separate row that can carry its own `deadLetteredAs`. The plural case is structurally accommodated by storage, not by making the JSONB field plural on a single row.

Settled. `deadLetteredAs: string` (single), not `deadLetteredAs: string[]`.

## Chained-DLQ ambiguity: dissolves on examination

Opus R1 claimed re-DLQ produces two source rows with the same `deadLetteredAs` value, causing reader ambiguity. **Both Gemini and Sonnet rebutted in R2** with the same correction:

> A→B→C chains produce `source_A.deadLetteredAs = B` and `source_B.deadLetteredAs = C` — no overlap. The scenario Opus described requires two *different* sources to record the same DLQ UUID, which would require UUID collision. Not possible.

Opus conceded the framing in R2. The `ORDER BY captured_at DESC` (must-land #3) covers any genuine bug or edge case anyway.

## Trigger-detection impossibility: verified 3-of-3

All three reviewers independently confirmed the spec's central architectural claim. Sonnet did the deepest verification, reading `node_modules/pg-boss/dist/plans.js` `failJobs()` directly (lines 1029–1189):

1. `failed_jobs` CTE INSERTs source's new state='failed' row. Trigger fires here.
2. `dlq_jobs` CTE INSERTs DLQ row in same statement, AFTER `failed_jobs` by CTE data dependency.
3. DLQ row's UUID generated by `gen_random_uuid()` DEFAULT — not knowable at the failed-row trigger time.

Three escape hatches checked (statement-level trigger with transition tables, deferred constraint triggers, session state via `set_config`). All collapse on the same heuristic-matching problem under concurrency. **No general mechanism defeats the impossibility.** The app-layer writer is the only non-heuristic path.

## Should-land in v1 (2+ reviewers)

**6. Distinguish "source not found" from "DB error" in fail-open logs.** Sonnet R1, Gemini R2. Early-adoption ergonomics. The two failure modes warrant different operator responses.

**7. One-sentence note in spec's "What does NOT change" stating progress column is not copied source→DLQ.** Sonnet R1, Opus R2. Prevents implementer confusion that the omission was accidental.

**8. README sentence on the SQS-redrive analogue** (`boss.retry(dlqJobId)` doesn't disturb the existing `deadLetteredAs` link). Sonnet R1. Cheap clarity.

**9. Document explicit behavior for second `recordDeadLetter` call with conflicting `dlqJobId`.** Sonnet R2. Recommended: log warning + treat as no-op (don't overwrite existing link with a different id). Idempotency contract.

**10. `findDeadLetterTarget(sourceJobId)` forward-direction reader.** Gemini R1, Sonnet R2 conceded as should-land. Logical mirror of `findDeadLetterSource`. Two lines of SQL.

## Test plan additions

All three agreed:

- Concurrent `recordTerminalDetail` + `recordDeadLetter` on same source — verifies the merge correctness from must-land #1.
- Source row purged between failure and DLQ-handler call — verifies silent no-op.
- Chained DLQ (A → B → C) — verifies each hop walks correctly.
- Second `recordDeadLetter` call with different `dlqJobId` — locks the documented idempotency behavior from should-land #9.
- EXPLAIN ANALYZE of `findDeadLetterSource` — verify the GIN index is actually used.

## Defer to follow-up (3-of-3 agreed)

1. Statement-level after-trigger with transition tables — impossible to make non-heuristic; not v1.
2. Lineage-integrity diagnostic (find DLQ rows without recorded source) — useful ops tool, separate issue.
3. Chained-DLQ traversal helper (walk full A→B→C in one call) — nice-to-have; defer.
4. `singleton_key` capture as plain column — Sonnet's prior-debate observation; separate issue.

## Areas of disagreement (one item, mitigated)

**Opus initially preferred OPTION-B (mandate ordering) over OPTION-A (merge in Goal 2).** Sonnet's R2 correction on the JSONB `||` key-level overwriting behavior dissolved the rationale for OPTION-B — the OPTION-A semantic isn't a regression to Goal 2's contract; it's a key-level extension of it. **Practical outcome: 3-of-3 effectively agree on OPTION-A after R2.** No further work needed on this.

**Gemini's preference to also store `dlqQueue` inside the JSONB value (not just the reader return).** Opus and Sonnet preferred storing just the id and reading the queue from the same row. Resolved: store only `dlqJobId` in JSONB; reader joins to get `queue` (zero JOIN cost — it's on the same row).

## Recommended path forward

1. **Update the spec to v2** incorporating must-land items 1–5 and should-land items 6–10. The "associative merge" framing must be corrected — it's now true (under OPTION-A) but the spec's example needs to clarify that key-level merge means `recordTerminalDetail` after `recordDeadLetter` does NOT wipe `deadLetteredAs` (it's preserved as a non-overlapping key).
2. **Plan must explicitly task the Goal 2 writer fix as part of Goal 3's PR.** The two changes ship together; Goal 2's correctness depends on it.
3. **No re-review needed** for the unanimous must-lands. Items 1–10 are mechanical or documentation fixes.
4. **Then proceed to writing-plans skill** for the implementation plan.

The full v2 change footprint: 1 SQL edit in Goal 2's existing writer, 1 type field on `TerminalDetailFailed`, 2 new methods (`recordDeadLetter` + `findDeadLetterSource` + optional `findDeadLetterTarget`), ~8 documentation additions across README/JSDoc/CHANGELOG/CLAUDE.md. No schema change. No new pg-boss surfaces. ~150-200 lines of new code + ~5 new tests.

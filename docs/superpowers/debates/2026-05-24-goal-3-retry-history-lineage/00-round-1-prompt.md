# Round 1 — Adversarial spec review (Goal 3 retry history / DLQ lineage)

You are reviewing the **Goal 3 design spec** for pg-bossier (a JS/TS library layering on pg-boss to provide an operational data plane). This is round 1 of a 4-way adversarial review (Codex, Gemini, Sonnet, Opus).

**Spec under review:**
`docs/superpowers/specs/2026-05-24-goal-3-retry-history-lineage-design.md`

**Project context (read before answering):**
- `CLAUDE.md` — project guidance, constraints, non-goals.
- `COMPATIBILITY.md` — pg-boss compatibility tier system.
- The tracking issue: GitHub issue #4.
- The charter: GitHub issue #1.
- `node_modules/pg-boss/dist/plans.js` — pg-boss's SQL planner. The DLQ INSERT path is around lines 1100–1190 (search for `dlq_jobs`).
- `node_modules/pg-boss/dist/manager.js` — pg-boss's queue manager (for singleton + DLQ option handling).
- `src/sql.ts` — the existing capture trigger.
- `src/terminal-detail.ts` — Goal 2's writer the new method composes with.

**Existing precedents the spec leans on:**
- Goal 2's `recordTerminalDetail` shape and `terminal_detail` JSONB column.
- Goal 1's chronicle preservation across pg-boss's DELETE+INSERT retry path.
- Goal 6's `setProgress` — separate method, single-writer convention.

## Your job

Read the spec critically. Identify problems that would block merge, problems that should land before merge but aren't blockers, and problems that can defer to follow-ups. Be specific — name files, sections, lines.

Focus particularly on:

1. **The trigger-impossibility claim.** The spec says "trigger-side detection is impossible" because pg-boss's DLQ INSERT runs in a CTE after `failed_jobs` and the trigger on the source's `failed` row fires before the DLQ row exists. **Verify this for yourself by reading pg-boss's SQL.** Is there ANY mechanism (statement-level trigger, deferred constraint, session-state, listen/notify, sequence read, txid_current correlation, etc.) that would let the trigger reliably populate a link column at INSERT time? If you find one, name it precisely.

2. **The application-layer writer architectural shape.** The spec ships `bossier.recordDeadLetter({ sourceJobId, dlqJobId })` as an opt-in JS method called from the DLQ-handler side. Is this the right shape?
   - Alternatives: reserved data-key convention, statement-level after trigger with CTE-aware correlation, ML-style "match data payload within transaction" heuristic, no writer at all (Codex's prior position).
   - Take a position on which is most stable and least fragile.

3. **The `deadLetteredAs` field name and shape.** Is "deadLetteredAs" the right name? Should it carry more than just the dlqJobId (e.g., timestamp, dlq queue name)? Should it be plural (`deadLetteredAs` array) for cases where a single source spawns multiple DLQ jobs?

4. **The "silent absence" risk.** Consumers who forget to call `recordDeadLetter` get a permanent invisible gap in their lineage — no error, no warning, no telemetry. The spec proposes loud README + JSDoc. Is that sufficient? Are there design alternatives that fail loudly (e.g., a periodic ops query that detects DLQ rows without a recorded source and warns)?

5. **Industry comparison.** How do analogous tools handle "linking related jobs across boundaries"?
   - Sidekiq DLQ — does it record source linkage?
   - Bull dead-letter feature — does it preserve source-id metadata?
   - AWS SQS DLQ — does the AWS SDK preserve the source message?
   - Temporal workflow continuation — uses RunId chaining.
   Are there patterns from these the spec missed?

6. **Composition with Goal 2.** The spec extends `TerminalDetailFailed` with optional `deadLetteredAs`. Is this clean composition or does it muddy the type? Does it have unintended consequences for Goal 2's discriminated-union narrowing?

7. **Test plan adequacy.** The implementation hint at the end of the spec lists 5 test scenarios. What's missing? Specifically:
   - Failure modes under concurrent writes to the same source row.
   - Behavior when the source row was purged before `recordDeadLetter` is called.
   - Behavior when a DLQ job is itself DLQ'd (chained DLQs).

## Output format

Structure your response as:

```
## Verdict
SHIP / SHIP-WITH-NAMED-CHANGES / BLOCK-UNTIL

## Must-land changes (blockers)
1. ...
2. ...

## Should-land in v1 (not blockers, but cheap)
1. ...

## Defer to follow-up
1. ...

## Architectural position — the writer
APP-LAYER-WRITER / TRIGGER-DETECTION / RESERVED-DATA-KEY / NO-WRITER — reasoning.

## Trigger-detection impossibility — verified?
YES / NO — if NO, name the mechanism.

## Industry-comparison findings
(what other tools do; whether the spec missed a pattern)

## Anything the spec missed entirely
```

Be specific. Don't restate the spec; pressure-test it. If a claim is correct, say so briefly and move on.

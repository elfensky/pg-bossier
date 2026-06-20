# Round 2 — Rebuttal / concession (Goal 3 retry history)

You completed round 1 of the 4-way adversarial review. Codex CLI was unavailable this round (CLI failures), so this is effectively a 3-way debate (Gemini, Sonnet, Opus). Read the other two reviewers' round-1 outputs and respond.

- `round-1-gemini.md` — Gemini's review (SHIP-WITH-NAMED-CHANGES)
- `round-1-sonnet.md` — Sonnet's review (BLOCK-UNTIL)
- `round-1-opus.md` — Opus's review (BLOCK-UNTIL)

(Skip your own.)

## Your job in round 2

Address each other reviewer's specific points where they differ from yours OR add something you missed. For each:

- **Concede** with reasoning if their point is right and you missed it.
- **Rebut** with reasoning if their point is wrong (cite spec, code, or evidence).
- **Strengthen** if their point is in the right direction but underspecified.

## Focus areas for round 2 specifically

1. **All three reviewers identified the merge-vs-overwrite blocker in Goal 2's `recordTerminalDetail`.** That's settled. The question is the FIX:
   - Update Goal 2's writer to merge (changing Goal 2's last-writer-wins semantics).
   - Make recordDeadLetter the only merger; mandate Goal 2 always runs first.
   - Move `deadLetteredAs` out of `terminal_detail` to a separate JSONB column or typed column.
   - Other.
   
   Take a position. Which fix preserves the most existing behavior with the least surprise?

2. **Opus raised the chained DLQ / re-DLQ ambiguity** (a DLQ job is itself dead-lettered later — two source rows could carry the same `deadLetteredAs`). Sonnet says current design handles multi-hop correctly because each call walks one hop. Are these compatible views, or is one wrong?

3. **Plural cardinality.** Opus suggested `string[]` or `Array<{...}>` for the field name. Gemini and Sonnet didn't address this. Is the 1:1 cardinality fine, or do we need plural?

4. **Storing `dlqQueue` alongside `dlqJobId`** — Opus and Sonnet both flagged this; spec stores only the id. Both said: include queue name. Confirm or rebut.

5. **The README "consumer must set `_originalJobId` in data" requirement** — Opus surfaced it as an implicit consumer contract. Should the spec make this explicit, or design around it?

6. **Final must-land list** after seeing the others. Be concrete.

## Output format

```
## Round 2 verdict
SHIP / SHIP-WITH-NAMED-CHANGES / BLOCK-UNTIL — same or updated.

## Concessions
1. <reviewer> on <point> — concede because ...

## Rebuttals
1. <reviewer> on <point> — rebut because ...

## Position: how to fix the merge issue (blocker 1)
OPTION-A (merge in Goal 2) / OPTION-B (mandate ordering) / OPTION-C (separate column) / OTHER — reasoning.

## Position: cardinality (1:1 vs plural)
SINGLE / PLURAL — reasoning.

## Final must-land list
1. ...
```

Be specific. Don't restate round 1.

# Round 2 — Rebuttal / concession (Goal 4 input-snapshot)

You completed Round 1 of the 4-way adversarial review. All four reviewers (Codex, Gemini, Sonnet, Opus) verdict-converged on SHIP-WITH-NAMED-CHANGES. The change list is mostly aligned. Three points to refine in R2.

Read the other three reviewers' R1 outputs (skip your own):
- `round-1-codex.md`
- `round-1-gemini.md`
- `round-1-sonnet.md`
- `round-1-opus.md`

## Specific R2 questions

1. **`recordInputSnapshot(null)`.** Codex/Gemini/Opus say REJECT (3 of 4). Sonnet says ACCEPT — argument: rejecting leaves no clean path to clear a snapshot. Take a refined position. If REJECT: is there a separate "clear" path that's needed? If ACCEPT: how do you fix the "JSON null hides earlier non-null" reader bug all four reviewers flagged?

2. **Server-resolve `attempt` (writer).** Gemini says yes (match `setProgress`). Codex + Opus say no (the "exact attempt observed exact input" semantic requires explicit). Sonnet didn't take a strong position on this in R1. Pick.

3. **Narrow `recordPatch.input_snapshot`.** Gemini says narrow (matches Goal 2). Codex + Opus say keep (cooperate via last-writer-wins). Sonnet's R1 doesn't pick. Pick.

4. **The pre-existing `recordPatch` COALESCE bug.** Sonnet R1 surfaced it: `COALESCE($3, input_snapshot)` makes `null` a no-op (preserves existing) rather than a clear. The spec's replace-on-write claim is false against the current `recordPatch` code. Must-land — but: does the fix belong in Goal 4's PR, or as a separate prep commit? Take a position.

5. **Final must-land list.** Tightened after seeing the others.

## Output format

```
## Round 2 verdict
SHIP / SHIP-WITH-NAMED-CHANGES / BLOCK-UNTIL — same or updated.

## Concessions
1. <reviewer> on <point> — concede because ...

## Rebuttals
1. <reviewer> on <point> — rebut because ...

## Final positions

1. `recordInputSnapshot(null)`: ACCEPT / REJECT — reasoning.
2. Server-resolve `attempt` in writer: SERVER / EXPLICIT — reasoning.
3. Narrow `recordPatch.input_snapshot`: NARROW / KEEP — reasoning.
4. `recordPatch` COALESCE fix scope: GOAL-4-PR / SEPARATE-PREP — reasoning.

## Final must-land list
1. ...
```

Be specific. Don't restate R1.

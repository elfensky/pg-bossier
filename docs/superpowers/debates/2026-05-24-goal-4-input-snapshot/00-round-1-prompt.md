# Round 1 — Adversarial spec review (Goal 4 input-snapshot slot)

You are reviewing the Goal 4 design spec for pg-bossier. Round 1 of a 4-way adversarial review (Codex CLI, Gemini CLI, Sonnet, Opus). The other goals' debates have produced strong convergence; this one is the last charter feature.

**Spec under review:**
`docs/superpowers/specs/2026-05-24-goal-4-input-snapshot-design.md`

**Project context:**
- `CLAUDE.md` — project guidance, constraints, non-goals.
- `COMPATIBILITY.md` — pg-boss compatibility tier system.
- Tracking issue: #5.
- Charter: #1.

**Precedents the spec leans on:**
- Goal 2's `recordTerminalDetail` (sibling-method shape; JSONB merge OPTION-A).
- Goal 6's `setProgress` / `getProgress` (sibling-method shape; server-resolved attempt; fail-open).
- Goal 3's `recordDeadLetter` (conflict-aware write).
- The shared `src/json.ts` `stringifyOrThrow` utility.

## Your job

Pressure-test the spec. Focus areas:

1. **API shape — sibling method + typed reader.** Is `recordInputSnapshot(jobId, attempt, snapshot)` the right shape? Should it match `setProgress`'s server-resolved `attempt` (omit the parameter and use `max(attempt)`) instead of explicit `attempt`?
2. **The reader's dual mode.** `getInputSnapshot<T>(jobId, attempt?)` — explicit-attempt vs most-recent fallback. Necessary or scope creep?
3. **JSONB merge vs replace.** Goal 3 fixed `terminal_detail`'s writer to use JSONB merge (`||`). Should `input_snapshot` also use merge, or is the spec's "replace" semantic correct? The spec argues replace is right for capture-at-job-start; verify or refute.
4. **`recordPatch` keeping its `input_snapshot` field.** Goal 2 narrowed `recordPatch` to remove `terminal_detail`. Goal 4 deliberately does NOT narrow `input_snapshot` out. Decision 5 in the spec explains; is that right?
5. **GIN index on `input_snapshot`.** Consistency argument vs storage cost. Right call?
6. **Size limit decision (unbounded + docs).** Will an accidental 10MB write cause real ops problems? Should the spec have a warn-above-threshold heuristic anyway?
7. **`recordInputSnapshot(jobId, attempt, null)` semantic.** Spec says it writes JSON null (no error). Open question 5 asks if this should be rejected. Take a position.
8. **Generic surface `<T>`.** Is the local generic on `getInputSnapshot` sufficient, or does it pre-commit to issue #13 (TS generics) in a way that boxes us in?
9. **Test plan adequacy.** Tests 1-12; what's missing?
10. **Anything the spec missed entirely.**

## Output format

```
## Verdict
SHIP / SHIP-WITH-NAMED-CHANGES / BLOCK-UNTIL

## Must-land changes (blockers)
1. ...

## Should-land in v1 (not blockers, but cheap)
1. ...

## Defer to follow-up
1. ...

## Positions on the five open questions
1. Merge vs replace: REPLACE / MERGE — reasoning.
2. Explicit-attempt reader: KEEP / DROP — reasoning.
3. Migration: CREATE-INDEX / CREATE-INDEX-CONCURRENTLY — reasoning.
4. README pattern guidance: YES / NO — reasoning.
5. `recordInputSnapshot(null)`: ACCEPT / REJECT — reasoning.

## Anything the spec missed entirely
```

Be specific. Cite file paths and line numbers when possible.

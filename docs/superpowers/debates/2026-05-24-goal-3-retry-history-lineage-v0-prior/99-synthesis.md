# Four-way debate — synthesis

**Topic:** Goal 3 retry history — lineage edge cases (dead-letter, singleton, reschedule)
**Tracking issue:** [#4](https://github.com/elfensky/pg-bossier/issues/4)
**Participants:** Codex CLI (GPT-5), Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet via Agent), Opus (Claude Opus, this session)
**Rounds:** 2 (independent → refinement)
**Outcome:** spec at [`docs/superpowers/specs/2026-05-24-goal-3-retry-history-lineage-design.md`](../../specs/2026-05-24-goal-3-retry-history-lineage-design.md)

## Headline

Three of the three decisions converged cleanly enough to write a spec without a Round 3.

| Decision | Round 1 votes | Round 2 votes | Outcome |
|---|---|---|---|
| **A — DLQ lineage** | trigger detection: 4-of-4 "impossible" | ship writer + reader: 3-of-4 (Codex dissents) | Ship opt-in `recordDeadLetter` + `findDeadLetterSource`; document Codex's dissent as adoption risk |
| **B — Singleton supersession** | document & ignore: 4-of-4 | unchanged: 4-of-4 | No pg-boss 12 mechanism displaces an incumbent; mark this issue resolved by absence |
| **C — Reschedule** | (a) same row-version, no marker: 4-of-4 | unchanged: 4-of-4 | Resolved trivially |

The interesting work happened in Round 2 on Decision A's sub-questions (writer-or-document, naming, reverse lookup, reserved-data-key, singleton_key capture, housekeeping UPDATE skip). All five of those landed with 3-of-4 or 4-of-4 consensus.

## Two load-bearing facts surfaced during the debate

Both are Sonnet contributions from reading `node_modules/pg-boss/src/plans.js`. They are the reason the debate converged so quickly — they collapsed all the "maybe the trigger can detect this" options into a single substrate impossibility:

1. **DLQ INSERT happens in the same SQL statement as the source's failure UPDATE**, in a `dlq_jobs` CTE that runs *after* `failed_jobs`. The trigger on the source's `failed` row therefore fires *before* the DLQ row exists. Auto-populating a `deadLetteredAs` field in `terminal_detail` from the trigger is impossible — the trigger doesn't yet have the DLQ id.
2. **No pg-boss 12 singleton mechanism displaces an incumbent.** `ON CONFLICT DO NOTHING` on the `(name, singleton_on, COALESCE(singleton_key, ''))` unique index (`job_i4`) drops the newcomer. `singletonKey`, `singletonSeconds`, `singleton`, `short`, `stately`, `exclusive` all behave this way. `useSingletonQueue` is not part of the pg-boss 12 type surface and is out of scope.

These two facts are why Decision A reduces to "application-layer writer or nothing" and why Decision B reduces to "nothing to model."

## Decision A — recommended path

**Ship a small, opt-in writer + a sibling reader.** Storage is the existing `terminal_detail` JSONB on the source's last `failed` attempt row. No schema change.

- `bossier.recordDeadLetter({ sourceJobId, dlqJobId })` — JSONB merge that adds `{ deadLetteredAs: <dlqJobId> }` to `terminal_detail` on the most recent `failed` row for `sourceJobId`. Caller does NOT supply `attempt` (Sonnet's flag: callers at DLQ-handler time don't have it).
- `bossier.findDeadLetterSource(dlqJobId)` — `WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text) LIMIT 1`. Uses the existing `record_terminal_detail_gin` index.

**Why not extend `recordTerminalDetail`?** (Gemini's alternative.) Sonnet's Round 2 swing names the concrete reason: `recordTerminalDetail` requires `attempt` as a positional key and enforces `class` on `failed` payloads. The DLQ-handler call site has neither. A focused sibling method keeps both API surfaces legible. **3-of-4 picked the sibling shape** (Sonnet moved from "extend" to "sibling" on Opus's argument; Gemini held "extend").

**Codex's dissent is preserved as a risk note in the spec.** Codex's strongest line: "The writer creates a misleading sense that pg-bossier *supports* DLQ lineage when the public pg-boss contract still does not give most consumers the source↔DLQ mapping in the first place." The spec mitigates this by (a) naming the writer as opt-in, (b) requiring fail-open behavior, (c) documenting the silent-absence failure mode loudly.

## Decision A — recommendations REJECTED

- **Gemini's reserved-data-key convention (`_pgbossier_source_id` in `data`).** 3-of-4 rejected. Three concrete problems all three rejectors named: (1) pollutes consumer's `data` payload with substrate bookkeeping, (2) trigger pays a per-fire JSONB scan cost for the magic key on every INSERT, (3) doesn't solve source→DLQ because pg-boss copies `data` through into the DLQ row, so a source-set key shows up in the DLQ row claiming the source as its own ancestor.
- **Schema column `dead_letter_source_id`** (option 1) and **separate link table** (option 2). 4-of-4 rejected. The trigger-time detection problem is unsolvable without a public pg-boss surface change; a column or table you can't reliably populate is worse than no column.

## Decision B — recommended path

**Document the absence and ship nothing.** No pg-boss 12 mechanism produces a displaced job to mark. If a future pg-boss release introduces true replacement semantics, the right answer at that point is Option 1 (marker in `terminal_detail` via Goal 2's writer) — not a schema change.

**Sonnet's secondary suggestion to capture `singleton_key` as a plain column moves to a separate issue.** It's a legitimate observational improvement (turns singleton-correlation queries from JSONB-path lookups into plain WHERE clauses), but it's an attribute-of-attempt enhancement, not a lineage decision. Bundling it with Goal 3 muddies the diff. 4-of-4 agreed it ships independently.

## Decision C — recommended path

**(a) Same row-version with a new `started_on`, no marker.** A reschedule is, from pg-boss's perspective, an UPDATE that resets `start_after` (and possibly `state` back to `created`). The capture trigger picks this up exactly like any other state transition. Consumers who want a "this was rescheduled" marker can derive it from the state-transition sequence (e.g., `active → created` is a clear rescheduling fingerprint) or write it via `recordTerminalDetail` on a non-terminal state. 4-of-4 agreed.

**Gemini's suggestion to skip housekeeping-only UPDATEs (`keepuntil` / `expireat`) moves to a separate issue** under #21 (perf follow-ups). It's a trigger optimization with its own correctness questions; doesn't tangle with the lineage substrate. 4-of-4 agreed.

## Areas of agreement (4-of-4 unanimous)

- Trigger cannot auto-populate any DLQ link from public pg-boss columns. Period.
- No pg-boss 12 singleton mechanism displaces an incumbent.
- Reschedule = ordinary row-version, no special marker.
- `singleton_key` capture is unrelated to Goal 3 lineage and ships separately.
- Housekeeping-only UPDATE skip is a perf optimization, separate issue.
- Any writer must be fail-open.
- Composition principle: do not overload pg-boss methods; new sibling methods only.

## Areas of disagreement (preserved in the spec as risks)

- **Codex on shipping the writer at all.** 3-of-4 ship it; Codex argues defer until a concrete consumer request lands. **Mitigation:** spec documents writer as opt-in with explicit silent-absence semantics; descent-app is the concrete consumer in Codex's sense, which is the tiebreaker.
- **Gemini on the writer's shape.** Wants extension to `recordTerminalDetail`; the other three want a sibling method. **Mitigation:** Sonnet's Round 2 argument (callers don't have `attempt` at DLQ-handler time) is the deciding fact.

## Quality scores

| Participant | Round 1 words | Round 2 words | Quality score |
|---|---|---|---|
| Gemini | 545 | 537 | 75 (proceed) |
| Codex | 700* | 627 | 75 (proceed) |
| Sonnet | 1081 | 884 | 100 (proceed) |
| Opus | 700 | 700 | 100 (proceed) |

\* Codex R1 cleaned from a 15,960-word session trace; only the answer block scored.

## What's next

Implementation plan to follow on a feature branch (`feature/goal-3-retry-history-lineage`), following the pattern from Goal 2 — small atomic TDD commits, each green CI, one `--no-ff` merge.

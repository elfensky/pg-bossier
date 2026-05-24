# Adversarial review — synthesis (Goal 4 input-snapshot slot)

**Spec under review:** [`docs/superpowers/specs/2026-05-24-goal-4-input-snapshot-design.md`](../../specs/2026-05-24-goal-4-input-snapshot-design.md)
**Participants:** Codex CLI (GPT-5), Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet via Agent), Opus (Claude Opus, this session)
**Rounds:** 2 (attack + rebuttal)

## Headline

This is the cleanest debate of the four. All four reviewers verdict-converged on SHIP-WITH-NAMED-CHANGES in both rounds. By R2, four of the five original divergent points have full 4-of-4 convergence; the last (where to scope the `recordPatch` COALESCE fix commit) is 3-of-4 with Sonnet's well-reasoned dissent that's worth honoring in the implementation plan.

The architecture is the same shape as Goals 2/3/6: sibling method + typed reader + JSONB column. Nothing novel about it. The debate work was tightening four edge cases plus surfacing one pre-existing bug.

## Verdicts

| Reviewer | Round 1 | Round 2 | Movement |
| --- | --- | --- | --- |
| Codex | SHIP-WITH-NAMED-CHANGES | SHIP-WITH-NAMED-CHANGES | unchanged |
| Gemini | SHIP-WITH-NAMED-CHANGES | SHIP-WITH-NAMED-CHANGES | unchanged |
| Sonnet | SHIP-WITH-NAMED-CHANGES | SHIP-WITH-NAMED-CHANGES | unchanged |
| Opus | SHIP-WITH-NAMED-CHANGES | SHIP-WITH-NAMED-CHANGES | unchanged |

Unanimous SHIP-WITH-NAMED-CHANGES. The strongest of the four debates by convergence.

## Decisions locked (4-of-4 unanimous after R2)

**1. `recordInputSnapshot(null)`: REJECT.** Sonnet's R1 ACCEPT position conceded in R2 after Opus exposed the actual reader bug: JSON `null` satisfies `IS NOT NULL` in SQL terms, so the "most-recent non-null" reader returns the cleared row and the caller gets `null as T` — indistinguishable from "never recorded." Fixing the reader to defend against this (`AND jsonb_typeof(input_snapshot) != 'null'`) adds complexity in both reader branches. Rejecting null at the writer keeps the SQL clean. If a future use case wants explicit clearing, a dedicated `clearInputSnapshot(jobId, attempt)` method ships as a follow-up.

**2. Server-resolve `attempt` in writer: NO. Explicit attempt required.** Gemini's R1 server-resolve argument conceded in R2 after Codex/Opus/Sonnet made the provenance argument: input snapshots are "this exact attempt observed this exact input" — server-resolving `max(attempt)` can misattribute to a newer attempt if a retry races. `setProgress` accepts the race because progress is current-state semantics; input-snapshot doesn't. Workers have `job.retryCount` available; the cost of passing it is minimal. **Explicit is correct, and the asymmetry with `setProgress` is deliberate.**

**3. `recordPatch.input_snapshot`: KEEP (do not narrow).** Gemini's R1 "narrow it like Goal 2 did" position conceded in R2. The Goal 2 narrowing precedent doesn't apply: `terminal_detail` was removed because its dedicated writer (`recordTerminalDetail`) has stronger validation (`class` mandate, state-bound SQL). `recordInputSnapshot` has no validation advantage over `recordPatch.input_snapshot`. Keep both; document `recordInputSnapshot` as the preferred path; `recordPatch` is the low-level backfill/multi-column-write escape hatch.

**4. UUID guard on `getInputSnapshot`.** All four reviewers flagged this in R1 or R2. `setProgress` short-circuits to `null` on malformed UUIDs (`src/progress.ts:78`); the new reader should match for behavioral consistency.

## The pre-existing `recordPatch` COALESCE bug (4-of-4 must fix; 3-of-4 say in Goal 4 PR)

Sonnet's R1 surfaced this: `src/record.ts:28` does `SET input_snapshot = COALESCE($3, input_snapshot)`. That means `recordPatch({input_snapshot: null})` is a SQL no-op (preserves the existing value) rather than a clear. The spec's "replace-on-write" claim is false against the current code.

**4-of-4 agree this must be fixed before Goal 4 ships.** Scope is the only disagreement:

- **3-of-4 (Codex, Gemini, Opus) say GOAL-4-PR** — fix lands as the first commit in Goal 4's PR.
- **1-of-4 (Sonnet R2) says SEPARATE-PREP** — fix lands as its own commit on develop before Goal 4 PR opens. Mixing a pre-existing bug fix into the Goal 4 PR obscures what Goal 4 changed.

**Synthesis recommendation:** SEPARATE-PREP. Sonnet's reasoning is correct — the fix is independent of Goal 4 (it's just a pre-existing bug exposed by the debate), it's small and trivially testable, and shipping it as its own commit makes both PRs easier to review independently. The Goal 4 plan should make Task 1 the prep commit (and label it accordingly), or land it directly on develop before the Goal 4 worktree is created. Either way, the Goal 4 PR doesn't carry the COALESCE diff in its own delta.

This is one place where the synthesis overrides the simple-majority vote because Sonnet's reasoning is unrebutted in the other reviews (Codex/Gemini/Opus picked "Goal 4 PR" mostly out of habit, not against Sonnet's argument).

## Unanimous must-land changes

1. **Fix `src/record.ts` COALESCE bug.** Change `SET input_snapshot = COALESCE($3, input_snapshot)` to `SET input_snapshot = $3::jsonb` (or a conditional SET that skips when undefined). Ship as a separate prep commit (per synthesis above). Test that `recordPatch({input_snapshot: null})` actually clears.

2. **`recordInputSnapshot` rejects null.** Validation throws on `snapshot === null` with `pg-bossier: input_snapshot validation: snapshot must not be null`. Tests updated to assert the throw instead of accepting.

3. **`recordInputSnapshot` takes explicit `attempt`.** No server-resolve. Spec § Decision 1 codifies the asymmetry with `setProgress` and names the provenance reason.

4. **`getInputSnapshot` UUID guard.** Short-circuit to `null` for malformed `jobId` without hitting the DB. Match `src/progress.ts:78`.

5. **Reader return shape.** When `attempt` provided: `T | null`. When `attempt` omitted: `{snapshot: T, attempt: number} | null` (matches `ProgressResult` from `src/progress.ts`). Export `InputSnapshotResult<T>` from `src/index.ts`.

6. **GIN index on `input_snapshot`.** Plain `CREATE INDEX IF NOT EXISTS`, not CONCURRENTLY (Goal 9's transactional install precludes it). README documents that large installs should pre-create with CONCURRENTLY before calling `install()`.

7. **Trigger-preservation test for `input_snapshot`.** Mirror Goal 2's test. Assert the capture trigger's `ON CONFLICT DO UPDATE` SET list excludes `input_snapshot`. Lock the structural guarantee that makes single-writer durable across retry trigger fires.

8. **Dual-writer collision test.** Call `recordPatch({input_snapshot: X})` and `recordInputSnapshot(jobId, attempt, Y)` in each order; verify last-writer-wins.

9. **README pattern guidance.** "Use `recordInputSnapshot` for normal worker-start capture. Use `recordPatch` for intentional multi-column batched writes or backfill."

10. **README "call at job-START, not job-FINISH" warning.** Otherwise consumers will capture outputs as inputs and Goal 4's audit value evaporates.

## Should-land in v1 (2+ reviewers)

11. **Non-finite-number documentation.** `NaN` / `Infinity` → JSON `null` via `JSON.stringify`. Document in JSDoc the same way `src/progress.ts:25-28` documents it for progress. (Codex R1 + Opus R2.)

12. **`recordPatch` and `recordInputSnapshot` share serialization path.** Both should route through `stringifyOrThrow(value, fieldName)` from `src/json.ts` so dual writers have identical acceptance/error behavior. (Codex R2 — caught a real gap; current `recordPatch` bypasses the shared utility.)

13. **Test for primitive snapshots.** `recordInputSnapshot(id, 0, 42)` → `getInputSnapshot(id) === 42`. JSON primitives are valid snapshots; test the path. (Opus R1.)

## Defer to follow-up

1. **`clearInputSnapshot(jobId, attempt)` method** — if real demand for explicit clearing surfaces. Not v1.
2. **Batch reader `getInputSnapshots(jobIds[])`** — `findById` already provides a slower path. Defer.
3. **Compression of large snapshots** — TOAST handles transparently. Defer.
4. **Issue #13 `Job<TInput, TOutput>` generic** — the `<T>` on `getInputSnapshot` is forward-compatible.
5. **Per-snapshot retention policy** — explicit non-goal in issue #1.
6. **Warn-above-threshold size heuristic** — 4/4 agreed unbounded + docs is the right v1 call.

## Recommended path forward

1. **Revise spec to v2** incorporating the 10 must-lands + the 3 should-lands.
2. **Ship the COALESCE fix as a prep commit on develop** before opening the Goal 4 worktree. Self-contained; reviewable independently.
3. **Write the Goal 4 plan** decomposing the work into TDD tasks (writer → reader → index → trigger test → docs → merge).
4. **Implementation via subagents**, same pattern as Goals 2/3.

The Goal 4 implementation is the smallest of the remaining feature deltas: ~50 LOC writer + ~30 LOC reader + 1 SQL change in `src/sql.ts` + ~10 tests + docs. After Goal 4, all charter goals are delivered and the only remaining v1 work is descent-app validation per CLAUDE.md.

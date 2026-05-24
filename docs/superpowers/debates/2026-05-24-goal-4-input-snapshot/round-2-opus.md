# Round 2 — Opus rebuttal / concession (Goal 4)

## Round 2 verdict

SHIP-WITH-NAMED-CHANGES (same as R1, with a tightened must-land list).

After reading the other three R1 reviews, R1 convergence was strong. Two specific position refinements + one concession.

---

## Concessions

**1. Sonnet on the `recordPatch` COALESCE bug — concede fully.**

My R1 §"Should-land #5" gestured at this ("recordPatch cannot clear input_snapshot once set") but didn't elevate it to a blocker. Sonnet's R1 is right: this is a real bug in pre-Goal-4 code that contradicts the spec's "replace" claim. It must be fixed; the question is just WHERE the fix lands (see "Final positions #4 below").

**2. Codex on the UUID-guard requirement — concede.**

My R1 didn't mention this. Codex is right: `setProgress` short-circuits to `null` on malformed UUIDs (`src/progress.ts:78`). `getInputSnapshot` should match for behavioral consistency. Trivial addition; would be surprising to omit.

**3. Codex on non-finite numbers — concede the documentation need.**

`JSON.stringify({x: NaN})` → `'{"x":null}'`. Same as `setProgress`. Goal 6 documents this in `src/progress.ts:25-28`. Goal 4 should mirror — even if just one JSDoc sentence. Cheap.

**4. Gemini on result-shape consistency with `getProgress` — partial concede.**

`getProgress` returns `{progress, attempt}` (ProgressResult). My R1 spec said `getInputSnapshot` returns `T | null`. Gemini's argument: the "attempt this came from" is forensically valuable. **Refined position: keep `T | null` when `attempt` is provided (caller knows the attempt); return `{snapshot: T, attempt: number} | null` when `attempt` is omitted (caller doesn't know which attempt won).** This matches `getProgress`'s shape for the omitted-attempt mode and minimizes surface area for the explicit-attempt mode. Net add: one new exported type `InputSnapshotResult<T>`.

---

## Rebuttals

**1. Gemini on server-resolve `attempt` (writer) — rebut.**

Gemini argues `recordInputSnapshot` should match `setProgress` and server-resolve `attempt` via `max(attempt)`. Codex's R1 is more precise on why this is wrong:

> Input snapshot is "this exact attempt observed this exact input." Server-resolving `max(attempt)` invites misattribution during retry timing edges.

Concretely: if a worker is on attempt 0, fails, pg-boss DELETE+INSERTs attempt 1 (which becomes the new `max(attempt)`), and ONLY THEN the worker's `recordInputSnapshot` call lands — it writes to attempt 1's row, not attempt 0's. The worker's snapshot describes what attempt 0 saw, but the audit row attributes it to attempt 1. That's wrong.

Goal 6's `setProgress` has the same race but the consequence is different: progress is a "current state" semantic; misattributing the progress value to the next attempt is mostly cosmetic. For input snapshots, misattribution destroys the forensic value of the whole feature.

**EXPLICIT attempt is correct.** This is not symmetric with `setProgress`; it's a deliberate asymmetry justified by semantics.

**2. Gemini on narrowing `recordPatch.input_snapshot` — rebut.**

Gemini argues for narrowing `recordPatch` to remove `input_snapshot` (matching Goal 2's pattern that removed `terminal_detail`). I disagree because the precedents aren't symmetric:

- Goal 2 narrowed `recordPatch.terminal_detail` because `recordTerminalDetail` has stronger validation (`class` mandate, state-bound SQL). A second writer with weaker validation would bypass the safety net.
- `recordInputSnapshot` has NO stronger validation — both writers accept "any JSON-serializable value." The reason to consolidate doesn't exist here.

Codex's R1 captures the right answer: keep `recordPatch.input_snapshot` available but document it as the "general-purpose, multi-field, legacy" path; document `recordInputSnapshot` as the "preferred single-purpose" path. Both work; last-writer-wins; the README explains which to use when.

KEEP `recordPatch.input_snapshot`.

**3. Sonnet on `recordInputSnapshot(null)` accept being acceptable — rebut, with a counter-proposal.**

Sonnet's R1 picks ACCEPT, arguing rejecting null "leaves no clean path to clear a snapshot." I disagree because:

a. **The "clean clear path" Sonnet wants doesn't exist anyway under either choice.** The pre-existing `recordPatch({input_snapshot: null})` is a no-op (COALESCE preserves), not a clear. `recordInputSnapshot(null)` (under ACCEPT) writes JSON null, which is not SQL NULL, so it's also not a "clear" — the column reads back as JSON `null`, which is a value, not absence.

b. **The reader bug Sonnet flagged exists under ACCEPT.** `getInputSnapshot(jobId)` with `WHERE input_snapshot IS NOT NULL` would pass the JSON-null row, returning it. That's the "ghost data" Gemini's R1 names — a `null` from a past attempt blocks fallback to a real earlier value. Under REJECT, the reader's existing SQL is correct.

c. **Counter-proposal: REJECT for v1; add a `clearInputSnapshot(jobId, attempt)` if real demand surfaces.** This is the same pattern Goal 4 already follows (start narrow, extend if needed). A `clear` method that runs `UPDATE ... SET input_snapshot = NULL WHERE ...` is two lines and unambiguous. It does not duplicate any existing writer's behavior. Defer until requested.

REJECT for v1. Add `clearInputSnapshot` as a follow-up issue if needed.

---

## Final positions

**1. `recordInputSnapshot(null)`: REJECT.**

Throws with prefixed message. Consumers wanting to clear use a direct SQL UPDATE (or wait for a follow-up `clearInputSnapshot` method). REJECT eliminates the reader-bug class. The "no clean clear path" concern is real but addressable separately.

**2. Server-resolve `attempt` in writer: EXPLICIT.**

`recordInputSnapshot(jobId, attempt, snapshot)`. Asymmetric with `setProgress` by design. Misattribution to the wrong attempt destroys forensic value; explicit attempt prevents it.

**3. Narrow `recordPatch.input_snapshot`: KEEP.**

Different precedent from Goal 2's `terminal_detail` narrowing (which was about consolidating to the stronger validator). `recordInputSnapshot` has no validation advantage over `recordPatch`'s input_snapshot field; keep both.

**4. `recordPatch` COALESCE fix scope: GOAL-4-PR.**

The fix is small (one SQL change: `SET input_snapshot = $3` instead of `COALESCE($3, input_snapshot)`). It directly affects the spec's correctness story. It should ship in the same PR with a clearly-labeled "fix(record): replace input_snapshot semantic, no longer COALESCE-preserve" commit, ahead of the new method. The implementer can isolate it as a pre-Task or Task 1.

**Decision tree the implementer needs:** does the existing behavior (COALESCE-preserve on null) need preservation as a backwards-compatibility for consumers? If yes, split. If no (and per CLAUDE.md's 0.x API instability, the answer is no), fix it in this PR with explicit changelog mention.

---

## Final must-land list

1. **Fix the `recordPatch` COALESCE bug.** `src/record.ts` change `SET input_snapshot = COALESCE($3, input_snapshot)` → `SET input_snapshot = $3`. Update tests that asserted the COALESCE-preserve behavior (any test that passes `{input_snapshot: null}` and expects the existing value to survive — search for these). CHANGELOG under `### Changed`. This must land FIRST (own commit) so the new method is built on correct foundations.

2. **REJECT `null` in `recordInputSnapshot`.** Validation throws on `snapshot === null` with `pg-bossier: input_snapshot validation: snapshot must not be null`. Same shape as `setProgress`. Documented.

3. **Add UUID-guard to `getInputSnapshot`.** Match `setProgress`'s pattern at `src/progress.ts:78`. Returns `null` immediately for malformed UUIDs without hitting the DB.

4. **Server-resolved attempt rejected: keep explicit attempt in writer.** Codify in spec § Decision 1 + comparison-with-setProgress note. Forensic correctness requirement.

5. **`getInputSnapshot` return shape:** when `attempt` is provided, return `T | null`. When `attempt` is omitted, return `{snapshot: T, attempt: number} | null` (mirror `ProgressResult`). Export `InputSnapshotResult<T>` from `src/index.ts`.

6. **Document non-finite-number behavior** (NaN/Infinity → JSON null) in the writer's JSDoc. Mirror `src/progress.ts:25-28`.

7. **Capture trigger preservation test for `input_snapshot`** — mirror Goal 2's test (CI assertion that the trigger's `ON CONFLICT DO UPDATE` SET list excludes `input_snapshot`). Locks the structural guarantee.

8. **Test for dual-writer (`recordPatch` + `recordInputSnapshot`) last-writer-wins** — Sonnet's R1 should-land.

9. **README pattern guidance** (YES): explicit "use `recordInputSnapshot` for normal worker-start capture; use `recordPatch` for intentional multi-column batched writes." Three sentences max.

10. **README "call at job-START, not job-FINISH" warning** for the use-case timing. Otherwise consumers will capture outputs as "inputs" and Goal 4's audit value disappears.

11. **GIN index migration note** in README: plain `CREATE INDEX IF NOT EXISTS` is fine for fresh installs; large existing installs should run `CREATE INDEX CONCURRENTLY` manually beforehand to avoid the install-time lock.

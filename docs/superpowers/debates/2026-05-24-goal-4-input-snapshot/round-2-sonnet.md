## Round 2 verdict

SHIP-WITH-NAMED-CHANGES — same as R1, with the must-land list tightened.

---

## Concessions

1. **Codex/Gemini/Opus on `recordInputSnapshot(null)`** — concede. My R1 argument was: rejecting null leaves no clean path to clear a snapshot through the preferred API. But Opus exposes the actual bug precisely: after `recordInputSnapshot(id, 0, null)`, the column contains `'null'::jsonb`, which satisfies `IS NOT NULL` in SQL terms — so the "most-recent non-null" reader still returns that row and the caller gets `null as T`. The claim "equivalent to never recorded" in the spec is false. The reader silently surfaces the cleared row as if it were a valid snapshot. My "accept null, document it" framing doesn't survive that. The JSON-null-vs-SQL-null distinction is real and the reader behavior is wrong, not just surprising. REJECT is the correct call.

---

## Rebuttals

1. **Gemini on server-resolve `attempt`** — reject. Gemini argues ergonomics: "only `job.id` is readily available in most worker contexts." That is not true for this API's target caller. Every pg-boss worker handler receives the job object, which carries both `id` and `retryCount` (the attempt number). The extra cost to pass it is one field access. Server-resolving `max(attempt)` introduces a real misattribution risk: if `recordInputSnapshot` is called from a concurrent context that runs slightly after pg-boss has already fired the retry `DELETE`+`INSERT`, the resolved `max(attempt)` would be the NEW attempt, not the one the worker observed. `setProgress` accepts that race because progress is "current state"; input-snapshot is "what this exact attempt saw." Misattributing a snapshot to the wrong attempt is a silent forensic error — no exception, wrong data. The explicit attempt is the correct shape.

2. **Gemini on narrowing `recordPatch`** — partial rebuttal (see Final Positions below). The "dedicated writer owns the column" precedent from Goal 2 is real, but the `terminal_detail` case is not analogous. `terminal_detail` was narrowed out of `recordPatch` because there is genuinely no legitimate use case for writing it via `recordPatch` once the dedicated method exists. `input_snapshot` has a documented backfill use case (`recordPatch` for when you're writing multiple columns in one round-trip, or backfilling from external bookkeeping). Narrowing breaks that without any stated consumer benefit beyond API tidiness. Keep is the correct call.

---

## Final positions

**1. `recordInputSnapshot(null)`: REJECT**

The JSON-null-hides-earlier-non-null bug is real and unfixable without adding complexity that defeats the purpose of accepting null. Specifically: after `recordInputSnapshot(id, 0, {records:[...]})` followed by `recordInputSnapshot(id, 0, null)`, the column is `'null'::jsonb`, which passes `IS NOT NULL`. The reader returns that row and the caller sees `null` — indistinguishable from "never recorded." Fixing this requires the reader's WHERE clause to be `AND input_snapshot IS NOT NULL AND jsonb_typeof(input_snapshot) != 'null'` everywhere — in both reader branches. That adds complexity to the SQL, adds a surface the test must cover, and adds a reader behavior that must be documented. The simpler fix is to reject null at the writer so the SQL stays clean.

My R1 "no clean path to clear" argument was wrong in direction. The "clear a snapshot" use case has no established need in the spec — the spec says "single-capture-at-job-start." If a consumer has a concrete need to clear, that is a new requirement, not something the writer should quietly enable at the cost of a reader bug. REJECT null, document it, and defer a dedicated `clear` method to follow-up if real demand surfaces.

**2. Server-resolve `attempt` in writer: EXPLICIT**

`recordInputSnapshot(jobId, attempt, snapshot)` keeps the explicit `attempt` parameter, required, no server-resolve fallback. Reasoning: input-snapshot semantics are "this exact attempt observed this exact input" — server-resolving `max(attempt)` can misattribute the snapshot to the retry that fired while the worker was still calling this method. `setProgress` accepted that race because progress is current-attempt state. Input-snapshot is not. Forensic integrity matters more than one field-access of ergonomic convenience. Workers receive the job object with `retryCount` already; the cost of passing it is minimal. Explicit is correct.

**3. Narrow `recordPatch.input_snapshot`: KEEP**

`recordPatch` keeps the `input_snapshot` field. The narrowing precedent from Goal 2 (`terminal_detail`) does not apply here: `terminal_detail` was removed because its dedicated writer (`recordTerminalDetail`) fully covers every write use case. `input_snapshot` has a documented backfill use case where `recordPatch` is the right tool (writing multiple columns in one UPDATE, or backfilling from external bookkeeping). Removing it from `RecordPatch` would break valid consumer code with no recovery path. Gemini's "violates the dedicated-writer pattern" argument proves too much — the pattern is about making the preferred path clear, not about creating a monopoly. Document `recordInputSnapshot` as the recommended path; leave `recordPatch` as the escape hatch.

**4. `recordPatch` COALESCE fix scope: SEPARATE-PREP COMMIT**

The COALESCE bug is pre-existing in `src/record.ts`. It is not introduced by Goal 4. It should land as a separate prep commit on `develop` before the Goal 4 PR opens. Reason: mixing a pre-existing bug fix into the Goal 4 PR obscures what Goal 4 changed and makes the PR harder to review and revert independently. A prep commit with message "fix: recordPatch COALESCE swallows null for input_snapshot — change to conditional SET" is self-contained, reviewable alone, and can be verified by a single test before Goal 4's code lands on top of it. The Goal 4 PR then inherits the correct behavior from the prep commit rather than re-explaining the bug in its own diff.

---

## Final must-land list

1. **Reject `null` in `recordInputSnapshot`.** Change validation: `null` throws with message `pg-bossier: input_snapshot validation: snapshot must not be null`. Update spec Section A, test 7 (change from "accepts null" to "rejects null with the prefixed message").

2. **Prep commit: fix `recordPatch` COALESCE bug** (separate commit, before Goal 4 PR). Change `COALESCE($3, input_snapshot)` to a conditional SET that skips the column when `patch.input_snapshot === undefined`. This is a pre-existing correctness bug that Goal 4 depends on for the "both writers cooperate" claim.

3. **UUID guard on `getInputSnapshot`.** Add `UUID_RE.test(jobId) || return null` in the reader, matching the pattern in `src/progress.ts`. Without it, an obviously-wrong jobId hits the DB instead of returning null immediately.

4. **Reader SQL is correct as-is** — the `IS NOT NULL` clause is valid because we now REJECT JSON null at the writer. No `jsonb_typeof` defense needed. Spec should confirm this explicitly (the IS NOT NULL clause is safe because we never write 'null'::jsonb).

5. **Dual-writer collision test.** Add a test (call `recordPatch({input_snapshot: X})` and `recordInputSnapshot(jobId, attempt, Y)` in each order; verify last-caller-wins). Already in R1 must-land, confirmed by Opus's Should-land #4.

6. **Trigger exclusion test for `input_snapshot`.** Opus correctly flags: the capture trigger's `ON CONFLICT DO UPDATE` SET list must exclude `input_snapshot` (same as it already excludes `terminal_detail`). Add an explicit test confirming the trigger does not overwrite a recorded snapshot when pg-boss fires the retry DELETE+INSERT. If the trigger already excludes it (likely, given the Goal 2 precedent), the test documents the guarantee. If it doesn't, this is a blocker.

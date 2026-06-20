## Round 2 verdict
SHIP-WITH-NAMED-CHANGES

## Concessions
1. Sonnet on the `recordPatch` COALESCE bug — concede because this is a real shipped semantic mismatch, not a hypothetical Goal 4 concern. As long as `recordPatch` says it can write `input_snapshot`, `COALESCE($3, input_snapshot)` makes the replace-on-write claim false.
2. Opus on retry-preservation proof — concede because Goal 4 should not rely on implication here. The test suite should explicitly prove that retry capture/trigger activity does not overwrite prior `input_snapshot` values.
3. Gemini on dedicated-writer clarity — concede because the docs should make `recordInputSnapshot` the normal path and `recordPatch` the exceptional low-level path. The overlap is acceptable only if the guidance is explicit.

## Rebuttals
1. Sonnet on accepting `recordInputSnapshot(null)` — rebut because `null` is doing two jobs at once: data value and control signal. That forces either a buggy omitted-attempt reader or special JSON-null filtering logic that turns stored content into hidden tombstone semantics.
2. Gemini on server-resolving writer `attempt` — rebut because `setProgress` is not the right analogy. Progress is “current mutable state”; input snapshot is “what attempt N actually observed.” Misattributing a snapshot to the latest attempt is worse than requiring an explicit attempt already present on the worker job.
3. Gemini on narrowing `recordPatch.input_snapshot` — rebut because the library already has a low-level patch surface for backfill and mixed writes. Removing the field is unnecessary if semantics are corrected and the preferred-path guidance is clear.
4. Opus on “use direct SQL if you need clear” — rebut because that is exactly the kind of app-owned escape hatch this library is supposed to avoid normalizing. If clearing becomes a required first-class operation, it should get a first-class API, not README-sanctioned manual SQL.

## Final positions

1. `recordInputSnapshot(null)`: REJECT — reasoning.
   Rejecting `null` is the cleaner contract. It avoids the JSON-null/SQL-NULL ambiguity, avoids the omitted-attempt reader bug, and keeps the writer as a pure “set snapshot for this attempt” API. A separate clear path is not required for Goal 4 v1. If the project decides clearing must exist, it should be an explicit operation with SQL-NULL semantics, not overloaded onto `null` as payload.

2. Server-resolve `attempt` in writer: EXPLICIT — reasoning.
   The important invariant is “this exact attempt observed this exact input.” Server-resolving `max(attempt)` weakens that invariant under retry timing and makes provenance less trustworthy. Worker code already has the attempt on hand; preserving attribution is worth the extra parameter.

3. Narrow `recordPatch.input_snapshot`: KEEP — reasoning.
   Keep it as the low-level escape hatch for backfill and intentional multi-column updates. Narrowing is only justified when the sibling method must be the sole managed writer; Goal 4 does not need that rigidity. What does need fixing is semantics: `recordPatch` must distinguish omitted from explicit `null`, must use the same JSON validation path, and must be documented as last-writer-wins against `recordInputSnapshot`.

4. `recordPatch` COALESCE fix scope: GOAL-4-PR — reasoning.
   This belongs in the Goal 4 PR, ideally as the first commit in that PR. Goal 4’s spec explicitly says both writers continue to cooperate; that statement is false against current code. Shipping the new API without fixing the existing cooperating writer leaves the feature internally inconsistent on day one.

## Final must-land list
1. Reject `recordInputSnapshot(jobId, attempt, null)` and update spec/tests/docs accordingly.
2. Keep writer `attempt` explicit; do not add server-side `max(attempt)` resolution.
3. Keep `recordPatch.input_snapshot`, but fix its semantics so omitted means “don’t touch column” and explicit `null` means SQL `NULL`, not no-op.
4. Route `recordPatch.input_snapshot` through the same JSON validation/serialization path as `recordInputSnapshot`, so dual writers do not have different acceptance/error behavior.
5. Add the `getInputSnapshot` malformed-UUID guard so “unknown job returns null” is true for obviously invalid IDs as well as absent rows.
6. Add tests for dual-writer last-writer-wins in both call orders.
7. Add tests proving retry capture preserves prior `input_snapshot` rows and that trigger/upsert behavior does not overwrite them.
8. Add tests for the absent-vs-explicit-`null` `recordPatch` distinction.
9. Tighten README/spec wording: `recordInputSnapshot` is the normal worker-start API; `recordPatch` is the low-level/backfill/mixed-write path.
10. Tone down migration language around the new GIN index; idempotent is true, “safe on large busy installs” is too strong.
## Verdict
SHIP-WITH-NAMED-CHANGES

## Must-land changes (blockers)
1. Fix the `null` semantics before shipping. As written, `recordInputSnapshot(jobId, attempt, null)` stores JSON `null`, not SQL `NULL`, so it is not actually “clear the snapshot.” It also breaks the omitted-attempt reader contract: `WHERE input_snapshot IS NOT NULL ORDER BY attempt DESC LIMIT 1` will select a JSON-`null` row and stop fallback to an earlier real snapshot. This is a spec/behavior mismatch across [src/record.ts] and the proposed `src/input-snapshot.ts`.
2. Make `getInputSnapshot` mirror `getProgress`’s malformed-UUID behavior from [src/progress.ts]. Right now the spec says “wrong jobId returns `null`,” but without the UUID short-circuit a non-UUID `jobId` is likely to become a query error instead of `null`.
3. Tighten the reader contract around “null.” The spec currently uses one word for three different states: no row, SQL `NULL`, and JSON `null`. Those are not equivalent operationally. v1 needs one explicit rule, not hand-waving.

## Should-land in v1 (not blockers, but cheap)
1. Keep the writer’s explicit `attempt` and say why in Section A. This is the right asymmetry with `setProgress`: progress is “current attempt” state; input snapshot is “this exact attempt observed this exact input.” Server-resolving `max(attempt)` invites misattribution during retry timing edges.
2. Add a compatibility note for `recordPatch` in [src/record.ts]: it remains supported for `input_snapshot`, but it is legacy/general-purpose and last-writer-wins against `recordInputSnapshot`.
3. Tone down the migration safety language in Section C. `CREATE INDEX IF NOT EXISTS` is idempotent, but it is not the same as “safe on large busy installs.” The current text understates upgrade-time lock risk.
4. Add one README sentence that `recordPatch` is the right tool when a caller is intentionally updating multiple app-owned columns in one SQL statement.

## Defer to follow-up
1. Returning `{ snapshot, attempt }` from the reader, or adding a second `getInputSnapshotWithAttempt`, if consumers later need provenance without a separate history read.
2. A warn-above-threshold heuristic for very large snapshots. I would not block v1 on it.
3. Any broader generic story tied to issue `#13`. The method-local `<T>` is enough for now.

## Positions on the five open questions
1. Merge vs replace: REPLACE — input snapshot is an attempt-scoped capture, not an incrementally assembled document. Merge semantics would hide bugs and make provenance weaker.
2. Explicit-attempt reader: KEEP — this is not scope creep. Without it, there is no direct way to ask “what did attempt 0 record?” except via broader history APIs. That is a real use case and a cheap surface.
3. Migration: CREATE-INDEX — keep the install path simple, but document clearly that upgrade-time index creation can block writes on large tables and that operators with large installs should create it manually/concurrently outside normal startup. Do not describe plain `CREATE INDEX` as effectively online.
4. README pattern guidance: YES — the overlap is manageable if the rule is simple: use `recordInputSnapshot` for the normal worker-start capture; use `recordPatch` when you are intentionally batching multiple column updates.
5. `recordInputSnapshot(null)`: REJECT — it collapses too many meanings, diverges from current `recordPatch` behavior in [src/record.ts], and creates the reader bug above. If you want “no snapshot,” use absence/SQL `NULL`; if you later need explicit tombstoning, design that separately.

## Anything the spec missed entirely
1. The current `recordPatch` implementation in [src/record.ts] uses `COALESCE($3, input_snapshot)` with `patch.input_snapshot ?? null`. That means `null` and `undefined` both become “no-op,” not “clear,” and not JSON `null`. The new API must either align with that or deliberately diverge and document the divergence.
2. `getProgress` in [src/progress.ts] has a UUID guard; the new reader should too for behavioral consistency and to make “unknown job returns null” true in practice.
3. The spec does not discuss non-finite numbers inside snapshots. As with `JSON.stringify`, `NaN`/`Infinity` inside objects will silently become JSON `null`. Goal 6 explicitly documents this for progress; Goal 4 should either document the same or reject it.
4. The test plan is missing malformed-UUID reader coverage and the JSON-`null` fallback edge. Those are the two highest-value adversarial tests for this API.
5. If the index is added in `src/sql.ts` around the existing `recordIndexesSql` block (noted near lines 108-113), install/upgrade docs should state that adding a fourth GIN index is a workload decision, not just a symmetry cleanup. Symmetry is fine, but the operational tradeoff is real.
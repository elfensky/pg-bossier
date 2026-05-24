## Round 2 verdict
SHIP-WITH-NAMED-CHANGES

## Concessions
1. **Codex/Opus on explicit `attempt`** — Concede. While I initially prioritized ergonomics (matching `setProgress`), their point about provenance is more compelling for Goal 4. Input snapshots are audit trail artifacts, not status indicators. Requiring explicit `attempt` ensures the worker is recording against the exact retry state it observed, preventing misattribution in race conditions.
2. **Codex/Opus on `recordPatch` narrowing** — Concede. Keeping `input_snapshot` in `recordPatch` is valuable for mixed-write scenarios (e.g., updating multiple app-owned columns in one round-trip). The "managed vs low-level" distinction is a better model than "exclusive ownership."

## Rebuttals
1. **Sonnet on `recordInputSnapshot(null)`** — Rebut. Sonnet argues that accepting `null` is the only "clean path" to clear a snapshot. However, as all four reviewers noted, storing JSON `null` breaks the SQL `IS NOT NULL` reader logic (the literal `'null'::jsonb` is not SQL NULL). Accepting `null` creates a "zombie" row that the reader would still pick up as the "most recent non-null" entry. 
   - **The fix:** Reject `null` in the managed writer. If a consumer needs to clear a snapshot (an administrative task), they should use the fixed `recordPatch` (see Final Positions #4) or raw SQL. The managed writer should be strictly for setting the capture.

## Final positions

1. **`recordInputSnapshot(null)`: REJECT** — It collapses "no data" and "cleared data" into a state that breaks the fallback reader. The writer should throw on `null`.
2. **Server-resolve `attempt` in writer: EXPLICIT** — Provenance and audit integrity outweigh the slight ergonomic friction.
3. **Narrow `recordPatch.input_snapshot`: KEEP** — Maintain flexibility for backfills and batched writes, but document `recordInputSnapshot` as the preferred single-column path.
4. **`recordPatch` COALESCE fix scope: GOAL-4-PR** — This is a blocker for the spec's "replace-on-write" promise. Fixing it within the Goal 4 PR ensures the storage substrate actually behaves as the new API expects.

## Final must-land list
1. **Fix the `recordPatch` COALESCE bug:** Update `src/record.ts` to use `input_snapshot = $3::jsonb` (removing `COALESCE`) so that `null` actually clears the field.
2. **Writer constraints:** `recordInputSnapshot` must require an explicit `number` for `attempt` and must throw if `snapshot` is `null` or `undefined`.
3. **Reader robustness:** `getInputSnapshot` must include a UUID format guard and the omitted-attempt SQL must include `AND jsonb_typeof(input_snapshot) != 'null'` to safely skip any legacy or manually-inserted JSON nulls.
4. **Collision testing:** Add a test case verifying last-writer-wins behavior between `recordInputSnapshot` and `recordPatch`.
5. **Trigger verification:** Add a test (matching the Goal 2 pattern) confirming that the capture trigger's `ON CONFLICT DO UPDATE` does NOT overwrite an existing `input_snapshot`.
6. **Documentation:** Update the README to explicitly recommend `recordInputSnapshot` for worker-start captures and `recordPatch` for administrative clearing or multi-column updates.

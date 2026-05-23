## Round 2 verdict
SHIP-WITH-NAMED-CHANGES

## Concessions
1. **Opus/Sonnet/Codex on TS signature:** Concede. The positional signature `(state, detail)` as drawn in the spec allows for state/detail mismatches at compile time because the two parameters are independent unions. The API must use a single object argument `{ jobId, attempt, ...TerminalDetail }` or overloads to ensure the discriminated union actually narrows.
2. **Codex/Opus on `retry` state:** Concede. An attempt that fails but will be retried by pg-boss is still a "terminal" event for that specific attempt row in the chronicle. The API must accept `state: 'retry'` and apply the same `failed` shape validation.
3. **Opus on Legacy Data:** Concede. Since `recordPatch` previously allowed writing to `terminal_detail`, a pure "trust the writer" approach on the read side could lead to runtime errors for existing data. A minimal read-time check or a documented "clean install" requirement for the v0.x -> v1.0 transition is necessary.
4. **Sonnet/Opus on `JSON.stringify`:** Concede. Relying on the driver to throw is inconsistent with the library's existing error-handling patterns in `setProgress`. Explicit guards for `undefined` and circular references are required.

## Rebuttals
1. **Sonnet/Opus on DROP state:** Rebut. Moving to a "read-then-write" inside the client adds a round-trip and introduces a race window between the read and the update. Binding the `state` parameter into the SQL `WHERE` clause (e.g., `UPDATE ... WHERE ... AND state = $state`) achieves the same correctness guarantee (preventing mismatched detail from being written to a row in the "wrong" state) while maintaining the performance and simplicity of a single round-trip write.
2. **Codex on "Internal inconsistency":** Rebut. The chronicle model is per-attempt. A row with `state = 'retry'` is the final record for that attempt. Allowing `terminal_detail` on `retry` rows (with the same shape as `failed`) resolves the inconsistency without needing a third discriminator.
3. **Opus on "descent-app migration":** Rebut. While identifying the migration path is helpful, the spec's validity shouldn't depend on a specific consumer's legacy data migration, provided the new API supports the target state.

## State-parameter — final position
KEEP — with the mandatory addition of the SQL `WHERE state = $1` guard. This provides the strongest "writer-to-reader" contract without the latency penalty of a read-then-write. It forces the caller to be explicit about the transition they are documenting, which is essential for audit integrity.

## Soundness of "trust the writer"
SUFFICIENT — The combination of the JS validator, the SQL state guard, and the capture trigger's structural non-overwrite (as noted by Sonnet) makes the read-side cast safe for all data written *after* this change. The legacy data risk is a one-time migration concern that can be handled via documentation or a backfill.

## Final must-land list
1. **SQL State Guard:** Add `AND state = $arg_state` to the `UPDATE` query.
2. **Support `retry` state:** Add `retry` to the `TerminalDetail` union, sharing the `TerminalDetailFailed` shape.
3. **Union-Safe Signature:** Change `recordTerminalDetail` to take a single object argument or use function overloads.
4. **JSON Serialization Guards:** Replicate the `JSON.stringify` try-catch and `undefined` guards from `setProgress`.
5. **Type Export Clarity:** Explicitly export `TerminalDetail`, `TerminalDetailFailed`, `TerminalDetailCompleted`, and `TerminalDetailCancelled` from the main entry point.
6. **Capture Trigger Verification:** Add a test case ensuring that a subsequent trigger fire on an existing row (e.g., updating `output`) does not overwrite `terminal_detail`.

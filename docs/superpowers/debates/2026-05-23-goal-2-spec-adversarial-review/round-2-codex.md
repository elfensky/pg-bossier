## Round 2 verdict
BLOCK-UNTIL

## Concessions
1. Sonnet on the positional signature — concede because the spec’s shown `recordTerminalDetail(jobId, attempt, state, detail)` signature is two independent unions, not a discriminated union. The claim that it “ensures `state` and `detail` agree statically” is false as written.
2. Gemini on write-side state agreement — concede because an unguarded `UPDATE ... WHERE job_id = $1 AND attempt = $2` lets a failed-shaped payload land on a row whose persisted `state` is something else, and the reader then narrows incorrectly.
3. Opus on legacy data, with Sonnet’s framing — concede because existing `recordPatch.terminal_detail?: unknown` means pre-Goal-2 rows can violate the new narrowed read type. That is a type-lie risk on upgrade. In this repo’s `0.x` world it does not force read-time validation, but it does force an explicit upgrade policy; “No migration required” is not honest.
4. Opus on JSON serialization — concede because the spec says pg’s binder enforces JSON-serializability while also saying `$3` is `JSON.stringify`’d. Once pg-bossier stringifies, the binder is no longer the enforcement point.

## Rebuttals
1. Gemini on accepting `state='retry'` — rebut because `retry` is the persisted pg-boss row state for “this failed attempt will be retried,” not the worker’s semantic report. The worker should still report `failed`; the bridge belongs in SQL and the reader type, not in the public write-state union.
2. Sonnet on DROP-with-read-then-write — rebut because DROP is not actually simpler once retry semantics are real. A read-then-write path still has to decide that row `state='retry'` uses failed-detail validation, and it still needs a guarded `UPDATE` to avoid a TOCTOU mismatch. KEEP plus SQL enforcement is cheaper and clearer.
3. Opus on needing read-time validation/backfill as the only soundness path — rebut because for a `0.0.0` package the lighter honest answer is an explicit upgrade note: if you previously wrote `terminal_detail` through `recordPatch`, truncate/drop-reinstall or backfill before relying on narrowed types.

## State-parameter — final position
KEEP — because retriable failures are the decisive counterexample. At the attempt level, the worker’s semantic outcome is “failed,” while the persisted chronicle row may end up with `state='retry'` (`src/read.ts`, `test/read.test.ts`). That makes a caller-supplied semantic state useful. But KEEP only works if the spec adds the bridge it currently lacks:

- reported `failed` may write only to rows whose persisted state is `failed` or `retry`
- reported `completed` may write only to `completed`
- reported `cancelled` may write only to `cancelled`

Corollary: the reader type for `retry` rows cannot stay `terminalDetail: null`; it must be `TerminalDetailFailed | null`.

## Soundness of "trust the writer"
NEEDS-STRONGER-MACHINERY — not a read-time parser, but stronger machinery than the current draft:

- sole-writer enforcement after Goal 2 (`recordPatch` no longer writes `terminal_detail`)
- SQL state guard/mapping between reported state and persisted row state
- explicit `0.x` upgrade policy for old arbitrary `terminal_detail` rows
- an explicit statement, plus a regression test, that the capture trigger does not overwrite `terminal_detail` on later updates

With those in place, trust-the-writer is sufficient for v1. Without them, it overclaims.

## Final must-land list
1. Resolve the retry contradiction: `retry` rows must be allowed to carry failed-shaped terminal detail, and the reader union must reflect that.
2. Keep the state parameter, but enforce it in SQL with the allowed-state mapping above; late mismatches should no-op.
3. Fix the public TypeScript contract: use overloads, a keyed generic, or a single object parameter. Do not claim the current flat positional signature is discriminated.
4. Replace the JSON-serializability text with the real behavior: explicit `JSON.stringify`/`try-catch` plus `undefined` guard, matching `setProgress`, and document standard JSON stringify semantics.
5. Replace “No migration required” with an explicit `0.x` upgrade note for installs that previously used `recordPatch` to write `terminal_detail`.
6. Show the full narrowed `recordPatch` SQL and param list after removing `terminal_detail`, not just “drop the COALESCE line.”
7. Add tests for retry-row read narrowing, state/detail mismatch no-op, invalid compile-time `state`/`detail` pairings, and the legacy-upgrade policy path the spec chooses.
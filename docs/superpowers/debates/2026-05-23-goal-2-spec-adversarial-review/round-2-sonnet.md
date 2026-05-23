## Round 2 verdict

BLOCK-UNTIL — upgraded from SHIP-WITH-NAMED-CHANGES.

Seeing Codex and Opus's round-1 reviews surfaced two interconnected issues I underweighted: the `retry` state gap is a genuine blocker (not just a documentation note), and the `recordPatch` legacy-data problem is real enough to require an explicit policy statement before shipping. My two original must-land items stand, but I'm now adding the `retry` state gap as a third blocker and upgrading the overall verdict.

---

## Concessions to other reviewers

**1. Codex on the `retry` state model inconsistency — concede fully.**

I noted the `retry` state in my round-1 Section C reader type (`state: 'created' | 'active' | 'retry'` narrows to `terminalDetail: null`) but I did not elevate it to a blocker. Codex is right that it is one. Here is the specific contradiction: Section C shows `retry` rows returning `terminalDetail: null`, yet Test 7 explicitly describes a scenario where attempt 0 is failed-and-will-retry, and `recordTerminalDetail` writes failure detail to that row. The row's `state` at Test 7's moment of reading is `retry` (pg-boss has moved it), not `failed`. So the reader narrows `terminalDetail` to `null` even though `recordTerminalDetail` has written valid `TerminalDetailFailed` data there. The type promise breaks. This needs a decision: either (a) accept that `retry`-state rows can carry `TerminalDetailFailed` and update the union accordingly, or (b) explicitly document that failure detail for mid-retry attempts is only retrievable via the `failed`-state snapshot preserved per-attempt (relying on the chronicle's row-per-attempt model). I was wrong to treat this as a should-land; it determines what the API actually does.

**2. Opus on the `recordPatch` legacy-data problem — concede that a policy is required.**

I raised the single-writer soundness issue in round 1 but I focused on the trigger non-overwrite as the structural guarantee. Opus correctly identified the more immediate problem: existing `recordPatch` calls in the wild can already have written arbitrary `terminal_detail` before this PR lands. The spec says "No migration required" but that is only true if we explicitly name which of Opus's three paths (backfill / drop-and-reinstall / read-time coerce) we take. For a `0.x` library, Opus's option (b) — document that consumers using `recordPatch` for `terminal_detail` must reinstall — is both honest and compatible with CLAUDE.md's statement that `0.x` API instability is accepted. But it must be stated. "No migration required" with no caveat is wrong.

**3. Gemini on `JSON.stringify` explicit guard — concede the method must replicate `setProgress`'s guard.**

My round-1 point about `JSON.stringify` returning `undefined` was in "Anything the spec missed." Gemini elevated it to a blocker (must-land #3). After looking at `src/progress.ts` lines 36–47, the guard there is three lines and handles functions/symbols returning `undefined`. The spec says pg's binder handles this, but that is false — pg sees a JavaScript string (already stringified), not the original object. The spec is wrong. This is a cheap mechanical fix but it produces a misleading raw driver error if left unfixed, directly contradicting the spec's promise of `'pg-bossier: terminal_detail validation: ...'`-prefixed messages.

**4. Opus on the descent-app migration path being invisible — concede as a should-land.**

I did not surface this at all. Opus is right that the spec's narrative purpose is to serve descent-app, but the spec says nothing about how descent-app transitions from its existing `output`-parsing queries to `terminal_detail`. The spec does not need to solve this — descent-app owns the migration — but it should name the gap so the README and descent-app's issue tracker (descent-app#343) are explicitly linked.

---

## Rebuttals to other reviewers

**1. Gemini on `retry` as a required write-API state (blocker #2) — partial rebuttal.**

Gemini's blocker says the API must accept `state: 'retry'` and apply the same `failed`-shape validation. I agree that `retry` is a gap, but the solution Gemini proposes introduces confusion about what `retry` means as a terminal state. `retry` is not a terminal state — it is an in-flight state between attempts. The right fix is not to add `retry` to the `recordTerminalDetail` state union, but to clarify the semantics: when a worker calls `recordTerminalDetail` for a failed attempt that will retry, it passes `state: 'failed'` because that is what happened at the attempt level. The row at `(jobId, attempt)` is a chronicle row for that attempt; its state transitions through `retry` transiently but the attempt's outcome was `failed`. The API should accept `state: 'failed'` for these calls — it already does. What needs to change is the reader-side: the `state: 'retry'` row variant in `JobRecord` should also allow `TerminalDetailFailed | null` rather than hard-coding `null`. Accepting `state: 'retry'` as a write-side parameter conflates pg-boss's in-flight retry state with the attempt's terminal classification and would confuse callers. Fix the reader union; do not expand the write union.

**2. Codex on blocker #3 (state guard in SQL WHERE clause) — partial rebuttal.**

Codex says the SQL must add `AND state = $arg_state` to prevent writing `failed`-classified detail to a `completed` row. Gemini's blocker #1 says the same. I agree this is a real gap (my round-1 Should-land #3 named it as the mismatch scenario). But I maintain my round-1 position that the better fix is to DROP the `state` parameter rather than bind it into the SQL WHERE clause. Here is why the SQL-guard approach is weaker than drop: binding `state` in SQL makes a mismatch a silent no-op, which the caller cannot distinguish from a wrong `(jobId, attempt)`. You now have two silent no-op classes (wrong key, wrong state) with no way to tell them apart. That makes debugging harder. The read-then-write approach (my round-1 position) eliminates both classes at once — you either write or you no-op because the row isn't there. The one extra round-trip happens only at terminal-state events, which are never the hot path. SQL-guard is strictly weaker: it fixes the mismatch but introduces ambiguity. Drop is strictly stronger.

**3. Codex on blocker #4 (legacy `recordPatch` + "no migration") — rebuttal on scope, concede on documentation.**

Codex says the existing `recordPatch` creates a "data corruption risk." I would frame it more precisely: it creates a type-lie risk in the reader if the spec ships without an explicit policy. The actual corruption scenario requires a consumer who (1) was using `recordPatch` for `terminal_detail` before Goal 2 ships AND (2) reads those rows via the new narrowed `JobRecord` type. CLAUDE.md says `0.x` API instability is accepted. The spec does not need to ship a backfill migration. But it DOES need to state explicitly: "consumers who wrote `terminal_detail` via `recordPatch` before Goal 2 should call `TRUNCATE pgbossier.record` (or DROP+reinstall) before upgrading to Goal 2, because old rows are not guaranteed to carry a valid `class` field on `failed` rows." That is the correct scope: not a code fix, but an explicit policy statement in the spec and the README. Codex's framing of "data corruption risk" is slightly overheated since this is a pre-release `0.x` library — but the documentation gap is real.

**4. Opus on JSON.stringify and "pg's parameter binder" being wrong — rebuttal on severity, concede on the fix.**

Opus frames this as the spec misreading the binder's role. I would say it is more specifically: the spec is internally inconsistent. It says both "pg's binder enforces JSON-serializability" and "$3 is the JSON.stringify'd detail." Once you stringify before the query, the binder sees a string and cannot enforce anything about the original object. Opus is right. However, this is a mechanical fix (replicate `setProgress`'s guard), not a design issue. I disagree with Opus's framing that this rises to the same severity as blocker #1 (the signature) or blocker #2 (the state-model gap). It is a clear must-land but takes fewer than 10 lines to fix.

---

## State-parameter position — final

**DROP — position strengthened, not reversed.**

Both Gemini and Codex picked KEEP on the grounds that SQL-enforced state agreement prevents the mismatch scenario. Having re-examined both arguments:

The KEEP+SQL-guard option (Gemini's blocker #1 / Codex's blocker #3) binds `AND state = $3` in the WHERE clause. This means a mismatch becomes a silent no-op indistinguishable from a wrong `(jobId, attempt)`. You now have a method that can silently do nothing for two distinct reasons. The caller has no way to distinguish them without re-reading the row. That is strictly worse ergonomics than a read-then-write.

The DROP+read-then-write option reads the current row state once, validates detail against it, then writes. If the row is not found or is not in a terminal state, it no-ops with the same semantics as today's wrong-key behavior. The type agreement between stored state and stored detail is guaranteed structurally, not documented-by-convention. The single extra round-trip happens at terminal-state events only — once per job attempt, never in a tight loop.

Codex argued KEEP because "the worker's semantic terminal result for the attempt is 'failed' while the persisted row may be 'retry'." This is precisely the `retry`-state gap I described in the rebuttal above. The read-then-write approach handles this correctly: if the row's state is `retry` (in-flight), the write resolves to that row's current state and detail is written alongside it. No caller-supplied state parameter is needed; the DB row is the authority. The worker does not need to know whether this is the final attempt.

The read-then-write adds implementation complexity (one query before the UPDATE), but `setProgress` already does this (lines 49–57, resolving attempt server-side). The pattern is established. Implementing it here is a straight copy of the approach, not a new design.

DROP is the right call. The mismatch class is eliminated, the `retry`-state edge case resolves naturally, and the implementation has a clear precedent in the codebase.

---

## Soundness of "trust the writer"

**NEEDS-STRONGER-MACHINERY** — revised from my implicit round-1 position that it was sound with the structural trigger guarantee.

The "trust the writer" argument has three load-bearing pieces:

1. `recordTerminalDetail` is the sole writer (single-writer convention). This is fine structurally, assuming `recordPatch` has its `terminal_detail` field removed.

2. The capture trigger does not overwrite `terminal_detail` (confirmed by `src/sql.ts` lines 143–150: `terminal_detail` is absent from the ON CONFLICT DO UPDATE SET list). This is the actual structural mechanism that makes single-writer safe across trigger fires.

3. The reader casts JSONB output to the narrowed type without runtime checks.

Piece 3 is where "trust the writer" becomes fragile. It is sound for newly-installed pg-bossier instances. It is not sound for existing installs where `recordPatch` has written arbitrary `terminal_detail` before Goal 2 ships. The spec needs to explicitly name this limitation and the policy for handling it.

The machinery I would add: an explicit `0.x` upgrade note in the spec and README that consumers who called `recordPatch` with `terminal_detail` fields must DROP and reinstall before relying on the narrowed types. That is the "stronger machinery" — not SQL CHECK constraints or read-time validators, just an explicit upgrade policy. It costs nothing at runtime and is honest about what the trust model requires.

---

## Final must-land list (after seeing other reviews)

1. **Fix the TypeScript signature to enforce discriminated-union coupling.** The flat positional signature does not connect `state` to `detail` at the type level. Use overloads or a single object argument typed as `TerminalDetail`. This is a type correctness issue — a wrong `state`/`detail` pair compiles today.

2. **Resolve the `retry`-state reader gap.** The `JobRecord` union must allow `TerminalDetailFailed | null` on `state: 'retry'` rows, not just `null`. A worker that fails an attempt pg-boss will retry writes to a `(jobId, attempt)` row that transitions through `retry` state; the terminal detail remains in the row. The reader must not discard it via the `null`-only narrowing.

3. **Drop the `state` parameter; implement read-then-write.** Validate `detail` against the row's actual state from `pgbossier.record` rather than the caller's assertion. Eliminates the mismatch class and the `retry`-state write confusion in one change.

4. **Replicate `setProgress`'s `JSON.stringify` guard.** The spec says the pg binder enforces serializability, but the binder only sees an already-stringified string. Guard against `undefined` return (functions, symbols) and synchronous throws (BigInt, circular references). The guard is three lines in `src/progress.ts`; share a utility or copy it.

5. **Explicit policy for pre-Goal-2 `recordPatch` consumers.** The spec's "No migration required" is false without qualification. State clearly that consumers who used `recordPatch` with `terminal_detail` fields before Goal 2 must DROP+reinstall pg-bossier before relying on the narrowed reader types. Put this in the spec's § Risks and in the README section.

6. **Show the narrowed `recordPatch` SQL in full.** The spec gestures at removing the `terminal_detail` COALESCE line but does not show the resulting query and param list. `$3` shifting to `input_snapshot` and `$4` disappearing is a real implementation bug if left implicit.

7. **Name which types are re-exported from `src/index.ts`.** The public API surface matters for semver from first release. List `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`, and `TerminalDetail` explicitly as exports (or explicitly exclude any of them).

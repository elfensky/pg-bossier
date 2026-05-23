# Round 1 — Opus review: Goal 2 terminal-state detail spec

## Verdict

BLOCK-UNTIL

The core idea is right (new method, single-writer, JSONB shape, narrow `recordPatch`). The Section A signature plus Section C reader together do not deliver the typed-narrowing promise the spec headline makes, and a v1 ship without fixing that would mean shipping a typed API that quietly lies. Two of the four blockers below are mechanical and fast to fix; the others need a small but real design call.

---

## Must-land changes (blockers)

**1. The `(state, detail)` parameter pair does not enforce its discriminated-union claim at TypeScript level.**

Section A draws the union as:

```ts
type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };
```

…then shows the method signature as four flat positional parameters. The flat signature does not couple `state` to `detail` at the type system level. The compiler accepts `recordTerminalDetail(id, 0, 'failed', {})` because the third parameter is `'completed' | 'cancelled' | 'failed'` and the fourth parameter is `TerminalDetailCompleted | TerminalDetailCancelled | TerminalDetailFailed` — those are two independent unions, not a tagged union over a single value. The spec then says "the discriminated-union type ensures `state` and `detail` agree statically at well-typed call sites" (Section A) — that is wrong as drawn.

Fix: switch the public signature to either (a) overloads, one per `state` value, or (b) a single object argument typed as the discriminated union. Option (b) is cleaner and matches the union definition that's already in the spec — `recordTerminalDetail(id, attempt, { state, detail })`. Option (a) gets unwieldy if `state` ever gains a value.

**2. The writer ignores `state` in SQL; the reader narrows by row `state`. The two are not bridged.**

`recordTerminalDetail` validates the caller's `state` argument against `detail` shape and then writes `terminal_detail` keyed by `(job_id, attempt)` only — no `state` predicate. Section C's reader trusts `row.state` to narrow `terminalDetail` because of the single-writer convention. But the single-writer convention only narrows the *set of writers*; it does not narrow what they wrote *relative to the current row state*. A worker that calls `recordTerminalDetail(id, 0, 'failed', { class: 'transient' })` 50ms after a concurrent path completes the row legitimately produces `{ state: 'completed', terminal_detail: { class: 'transient' } }` — which the reader will then cast as `TerminalDetailCompleted` (= `Record<string, unknown>`), losing the class field's meaning silently. The "narrows by state" promise breaks in exactly this scenario.

Fix options, in order of preference:

- **Drop `state` from the API; read-then-write on the SQL side.** The function resolves the row's actual state from `pgbossier.record`, validates `detail` against THAT, and either writes or no-ops if the row's state isn't terminal. One extra round-trip on terminal-state events only (not a hot path). Mirrors `setProgress`'s server-side attempt resolution. Cleanest semantic.
- Keep `state`, but bind it into the SQL: `UPDATE ... WHERE job_id = $1 AND attempt = $2 AND state = $3`. Mismatch becomes a silent no-op (or, optionally, a thrown error if we want loud failure). Cheaper than read-then-write but adds another silent-no-op class.

Pick one. Either is fine. The current design (validate-then-write-without-binding) is the worst of both.

**3. The "trust the writer" claim ignores existing `recordPatch` writes.**

Until this PR lands, `recordPatch` accepts arbitrary `terminal_detail` via `RecordPatch.terminal_detail?: unknown` (`src/record.ts:5-8`). Any existing install that has been calling `recordPatch` for terminal_detail has arbitrary-shaped JSONB rows in `pgbossier.record`. Goal 2's reader-side cast (Section C) trusts those rows as if they conform. They don't.

Three honest paths:
- a. Add a one-time backfill in the spec: `UPDATE pgbossier.record SET terminal_detail = NULL WHERE jsonb_typeof(terminal_detail) != 'object' OR (state = 'failed' AND NOT (terminal_detail ? 'class'))`. State the migration explicitly.
- b. Document that v0.x → v0.y consumers should DROP and reinstall pg-bossier if they used `recordPatch` for terminal_detail (acceptable since `0.x` API is unstable per CLAUDE.md).
- c. Read-time validation (the spec deliberately rejects this — but if 3a and 3b are both unacceptable, this is the third option). Adds runtime cost; gains correctness against legacy data.

"No migration required" (spec § Implementation sketch) is only true if (b) is the answer and we say so. Right now it's neither stated nor true.

**4. JSON.stringify edge cases are not handled, and the spec says they don't need to be.**

Section A: "JSON-serializability is enforced by pg's parameter binder; pg-bossier does not duplicate that check." But then "$3 is the `JSON.stringify`'d detail" — which means pg-bossier IS doing the serialization, and pg's binder only sees a string. The binder cannot enforce JSON-serializability on something already a string. So the responsibility has actually shifted entirely to `recordTerminalDetail` and the spec needs to handle:

- `JSON.stringify(detail)` returns `undefined` for top-level functions/symbols. `setProgress` (`src/progress.ts:44-47`) explicitly guards this. `recordTerminalDetail` should match.
- `BigInt` throws synchronously inside `JSON.stringify`. Worker error paths sometimes carry `BigInt`-typed fields (e.g., 64-bit IDs).
- `Date` silently serializes to ISO string — no error, but readers get a string back. Documented behavior in the spec's open question 3, but the consequence (worker writes `Date`, reads back string) isn't named in the Risks table.

Either replicate `setProgress`'s guard path or share a serialization utility between the two. The spec needs to commit to one.

---

## Should-land in v1 (not blockers, but cheap)

**1. Document the structural reason single-writer is safe.**

The capture trigger from Goal 1 (`src/sql.ts:142-150`) explicitly does NOT touch `terminal_detail` in its `ON CONFLICT DO UPDATE` SET list. THAT is what makes `recordTerminalDetail` writes stable across subsequent trigger fires. The spec credits "the single-writer convention" with the soundness — but the trigger's non-overwrite is the actual mechanism. State this explicitly in Section C, both as a documentation note and as a CI test that fails if a future trigger change adds `terminal_detail` to the SET list.

**2. Add `'retry'` to the state set, or explicitly document it as out-of-scope.**

pg-boss has a `retry` state between `created` and re-`active` (when retry_delay applies). The spec restricts `recordTerminalDetail`'s `state` parameter to `'completed' | 'cancelled' | 'failed'`. That's defensible if we say "terminal_detail is only for terminal states, and retry isn't terminal." But the spec doesn't say that. A reader scanning the spec might reasonably ask "can I record detail for a job that failed but will retry?" Answer in v1 is "no, you wait for the final attempt." That needs to be named.

**3. Section B's narrowed `recordPatch` SQL must be shown in full.**

The spec says "drops the `terminal_detail` COALESCE line." Param indices shift; `$3` becomes `input_snapshot`; `$4` disappears. An implementer working from the spec alone could silently mis-index this. Show the full resulting query and parameter list — 6 extra lines that prevent a real bug class.

**4. Test plan must cover the state/detail mismatch path.**

If we adopt fix option 2's "drop state" or "bind state in SQL", the mismatch test verifies the chosen behavior. If we keep the current design (validate-only), the spec needs a test that asserts the documented "incoherent rows are possible" semantic. Either way, the test must exist.

**5. Public type exports.**

The spec's implementation sketch names `src/index.ts` as re-exporting the new types but doesn't say which. The four candidates — `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`, `TerminalDetail` — should be explicitly named as exports. For semver this matters: any of them becoming non-exported later would be a breaking change.

**6. `cancelled` semantics — who calls it?**

The spec includes `cancelled` in the state set but workers don't typically cancel themselves. Cancellation usually comes from outside (operator, sibling job, supersession). Who calls `recordTerminalDetail(id, attempt, 'cancelled', detail)`? Document the expected caller (probably the cancellation initiator, not the worker), or document that pg-bossier doesn't expect this to be called for v1 cancellations.

---

## Defer to follow-up

1. `expired` / `superseded` derivation — already deferred; correct.
2. SQL CHECK constraint — already deferred; correct.
3. Append-only schema — inherited from Goal 1; not this issue's fix.
4. `Job<TInput, TOutput>` generic — cross-cutting issue #13; correctly deferred.

---

## Positions on the five open questions

**1. state parameter: DROP**

Read-then-write inside `recordTerminalDetail`. The function resolves the row's state from `pgbossier.record` and validates the supplied `detail` against that. If the row's state isn't terminal (or doesn't exist), it silently no-ops. Cost: one extra round-trip on terminal-state events only. Benefit: eliminates the entire mismatch class. Mirrors `setProgress`'s server-side attempt resolution. The "force the worker to confirm what they think happened" argument is sound in principle but the current design does nothing with the disagreement — it writes regardless. Either bind the agreement check into the SQL (alternative for blocker #2) or drop it. I prefer drop because it's structurally simpler.

**2. Error class: PLAIN**

Goal 9 precedent + `instanceof`-across-bundles fragility + cheap message-prefix matching all line up. The exported error class buys little; the cost is API surface area we have to keep stable. The validation throws happen at programmer-error sites (wrong literal in code), not at runtime data-quality sites, so consumers don't need to programmatically distinguish error types — they need to fix their code.

**3. Date handling: STRICT-JSON**

A `Date` going through `JSON.stringify` becomes an ISO string with no type-system signal that the read side will be a `string`. The "we accept Date" path hides a type mismatch one layer deeper rather than removing it. Workers should format dates explicitly into strings. Consistent with `setProgress`'s plain `JSON.stringify` semantics — pick one model library-wide.

**4. Migration guide: README**

One method, one column, four-line change. `MIGRATION.md` is for breaking changes with multi-step migration paths. README has the right surface area for v1. Revisit when Goals 3 / 4 / 6 each need their own multi-page migration; until then, splitting fragments the docs.

**5. Idempotency: LAST-WRITER-WINS**

Hash-column idempotency adds a column, a hash computation per call, and conditional UPDATE logic for a case the existing semantics already handle safely (last writer wins, same value if same payload). `UPDATE WHERE IS DISTINCT FROM` is cheaper but only helps if callers actually double-call with identical payloads — which webhooks-style consumers solve at their own layer. Defer; ship last-writer-wins documented clearly.

---

## Industry-comparison challenges

The Sentry / OTel / AWS SDK / Bull comparison in Section "Decisions locked" is directionally right but loosely argued. The strongest precedent is OpenTelemetry spans: `span.setStatus(...)` is exactly the "separate call attaches metadata to the primary operation" pattern Goal 2 is shipping. The other three are weaker analogies:

- Sentry's `captureException` IS the primary call in Sentry's mental model, not a sibling of a primary failure call. It's not the same pattern as "record metadata about an event the primary system already knows about."
- AWS SDK's retry classification is client-side policy over transient transport errors, not worker-authored forensic metadata about business outcomes. The "default to non_retryable" precedent is real but the larger analogy is forced.
- Bull's `job.update` is the closest non-OTel analogue — but Bull's metadata writes share a transaction with the queue write (Bull owns both); pg-bossier's two writes are in different transactions entirely (pg-boss + pg-bossier). The transaction-isolation difference matters and the spec doesn't name it.

Lead with OTel. Keep the others as supporting evidence with the caveats. The current phrasing implies a stronger consensus than the precedents actually show.

---

## Anything the spec missed entirely

**1. The descent-app migration path is invisible.**

descent-app has its own failure_class table populated by parsing pg-boss `output` (`descent-app#343`). The "what ships" section says the win is "turn those queries into one indexed JSONB lookup." But the migration FROM the existing descent-app table TO `pgbossier.record.terminal_detail` is not addressed. Does descent-app:
- Backfill its existing classifications into `terminal_detail` for historical jobs? (One-time SQL, but who writes it?)
- Run both systems in parallel during transition and dual-write?
- Drop history and only classify going forward?

This isn't pg-bossier's job to implement, but the spec should at least name where the answer lives (descent-app's issue tracker, or a short note in pg-bossier's README, or both).

**2. Discoverability: how does a consumer learn `recordTerminalDetail` exists?**

The proxy already exposes `setProgress`, `getProgress`, `recordPatch`, `findById`, etc. — the public surface grows quietly per goal. The spec's README addition should not just describe `recordTerminalDetail` but explicitly list what's on the `bossier` client today and where the boundary is between pg-boss methods (proxied) and pg-bossier methods (added). Otherwise consumers learn the surface only by reading source.

**3. Test 7 (late call after retry) is the most important test but the spec describes it briefly.**

"Worker fails attempt 0, pg-boss inserts attempt 1, worker then calls `recordTerminalDetail` for attempt 0 — attempt 0's row receives the detail; attempt 1's row is untouched." Good. But what makes this test load-bearing is that the capture trigger preserved the attempt-0 row across pg-boss's DELETE+INSERT. The test should explicitly verify the chronicle preservation property (count rows by job_id before and after; assert attempt 0 row's `state` ended up as `failed`). Otherwise the test passes for the wrong reason if Goal 1's preservation regresses.

**4. The capture trigger is also a writer of `state` and other columns.**

After `recordTerminalDetail` writes `terminal_detail`, the capture trigger can fire AGAIN on the same `(job_id, attempt)` row — e.g., if pg-boss UPDATEs the row's `output` column for some reason. The trigger's ON CONFLICT DO UPDATE explicitly preserves `terminal_detail` (it's absent from the SET list), so this is safe. But the spec doesn't verify the property. A CI test that simulates "recordTerminalDetail then subsequent trigger fire" would lock this in. Without it, a future trigger change could silently break Goal 2.

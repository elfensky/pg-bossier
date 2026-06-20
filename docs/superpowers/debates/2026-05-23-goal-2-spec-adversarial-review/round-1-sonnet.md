# Round 1 — Sonnet review: Goal 2 terminal-state detail spec

## Verdict

SHIP-WITH-NAMED-CHANGES

---

## Must-land changes (blockers)

**1. The `recordTerminalDetail` signature does not enforce discriminated-union narrowing at call sites.**

The spec's Section A signature lists the four positional params as:

```ts
client.recordTerminalDetail(
  jobId: string,
  attempt: number,
  state: 'completed' | 'cancelled' | 'failed',
  detail: TerminalDetailCompleted | TerminalDetailCancelled | TerminalDetailFailed,
): Promise<void>;
```

This is a flat overload, not the discriminated union drawn on lines 121–123. TypeScript does not connect `state: 'failed'` to `detail: TerminalDetailFailed` from a flat positional signature. A caller can write `recordTerminalDetail(id, 0, 'completed', { class: 'transient' })` and TypeScript accepts it because `TerminalDetailFailed` is a subtype of `TerminalDetailCompleted` (which is `Record<string, unknown>`). The "static agreement between state and detail" the spec claims is only true at the union-wrapped call site, but the actual function signature does not use the tagged-union type. The spec needs to either use function overloads or a single-argument object taking the `TerminalDetail` union. If it stays positional, the static guarantee is illusory and consumers lose it silently on upgrade if the method is exposed differently. Pick the approach and state it clearly before implementation.

**2. The `recordPatch` SQL change is described but the existing SQL in `src/record.ts` lines 25–34 has `COALESCE($3, terminal_detail)` for the `terminal_detail` column — the spec says to drop that line but does not specify what the narrowed UPDATE statement becomes.**

The spec (Section B) says "The SQL UPDATE inside `recordPatch` drops the `terminal_detail` COALESCE line." The current query also passes `patch.terminal_detail ?? null` as `$3`. After removal, `$3` shifts to `input_snapshot` and `$4` disappears, making the remaining param index `$3` for `input_snapshot`. The spec must show the final SQL and param list explicitly, not just gesture at removing a line. This is a mechanical change but getting the param indices wrong silently breaks all `recordPatch` calls.

**3. Trust-the-writer at read time is unsound given the existing capture trigger's `ON CONFLICT DO UPDATE`.**

Section C asserts: "Soundness rests on the single-writer convention — every write of `terminal_detail` goes through `recordTerminalDetail`'s validator." But look at `src/sql.ts` lines 137–150 — the capture trigger's `ON CONFLICT DO UPDATE` block does not include `terminal_detail` in its SET list, which is correct. However, the trigger fires on every `INSERT OR UPDATE OF state` on `pgboss.job`. If a pg-boss version ever changes `pgboss.job` to include a column named `terminal_detail` (unlikely but not Forbidden-tier impossible), the trigger would silently not capture it — that gap has no test. More concretely: the trigger updates the row without touching `terminal_detail`, preserving whatever `recordTerminalDetail` wrote. But `progress` and `input_snapshot` follow the same single-writer convention and the capture trigger similarly does not overwrite them. The spec should explicitly name that the trigger's non-overwrite of `terminal_detail` is the structural guarantee, not just the JS method name. If the spec ships without stating this, the capture trigger is a silent dependency of the soundness claim.

---

## Should-land in v1 (not blockers, but cheap)

**1. Test 5 (happy-path end-to-end) is the most important test in the plan, and its description is too vague.**

"send → worker fails → `recordTerminalDetail` → `findById` returns `terminalDetail.class === 'transient`" does not specify whether "worker fails" means the pg-boss handler calls `boss.fail(id, error)` or throws. These produce different trigger sequences. For a library built on "what pg-boss does internally," this ambiguity in the integration test spec is enough to produce a test that exercises the wrong path. The test should name exactly how the failure is induced — e.g., `work` handler throws vs explicit `boss.fail` — so the implementer doesn't write an incomplete test.

**2. Missing test: `recordTerminalDetail` called when `terminal_detail` already has a value.**

Test 8 covers last-writer-wins for two sequential calls with different payloads on the same attempt. But there is no test for calling `recordTerminalDetail` after the capture trigger has already finalized a `completed` row, then calling it again with `state: 'failed'`. That scenario can happen if a worker's error handler races with correct state capture. Last-writer-wins is the specified behavior but that path is not in the test plan.

**3. The `state` parameter's redundancy with the existing row state is noted as an open question but the risk is not fully surfaced in the Risks table.**

Risk #1 covers the case where the worker calls `recordTerminalDetail` with the correct attempt after a retry. It does not cover the case where the worker passes a `state` that disagrees with what the capture trigger recorded. E.g., `recordTerminalDetail(id, 0, 'failed', { class: 'transient' })` called after pg-boss moved the job to `completed` via a concurrent completer. The row ends up with `state = 'completed'` and `terminal_detail = { class: 'transient' }` — which is incoherent but undetected. The spec should either document this as known-corrupt or add a mismatched-state check.

**4. `TerminalDetailCompleted` typed as `Record<string, unknown>` makes the completed branch indistinguishable from TerminalDetailFailed at the type level.**

When a consumer checks `job.state === 'completed' && job.terminalDetail`, TypeScript narrows to `TerminalDetailCompleted | null` = `Record<string, unknown> | null`. The consumer cannot know if the stored object has a `class` field that was accidentally written there (e.g. a copy-paste from a failed handler). That's fine — it's honest "we don't enforce shape on completed." But the spec should say this explicitly where `TerminalDetailCompleted` is defined, not leave it implied. The silence invites a future contributor to add enforcement and break existing behavior.

---

## Defer to follow-up

1. SQL CHECK constraint on `terminal_detail`. The spec already names this. JS gate plus single-writer is fine for v1.
2. `expired` / `superseded` derivation. Already deferred.
3. Worker-helper auto-classification utilities (`classify(err)`). Consumer-owned.
4. Append-only audit table. Inherited from Goal 1.
5. `Job<TInput, TOutput>` generics. Cross-cutting issue #13.

---

## Positions on the five open questions

**1. state parameter: DROP**

Reasoning: the `state` parameter is genuinely redundant — the capture trigger has already written the authoritative `state` to the row by the time the worker calls `recordTerminalDetail`. Keeping it forces the worker to supply a value that the DB row already carries, and introduces the mismatch scenario I named in "Should-land" #3 above. The argument "forces the worker to confirm what they think happened" is appealing but unsound: if the worker says `'failed'` and the row says `'completed'`, the spec does nothing with that disagreement — it writes `terminal_detail` anyway. That silent incoherence is worse than the round-trip cost of a read. The right fix is to either validate state agreement (read-then-validate-then-write) or drop the parameter and let the DB row be the source of truth. A read-then-write avoids the mismatch class entirely at the cost of one round-trip that only happens on worker terminal-state events — not a hot path.

**2. Error class: PLAIN**

Reasoning: `instanceof`-narrowing of errors across module boundaries (different package versions, bundler chunk splits, iframe scenarios) is fragile. The message prefix `'pg-bossier: terminal_detail validation: ...'` is already specific enough for `message.startsWith(...)` checks. Adding a class is a type-level nicety that buys little for a throw that happens only on programmer error (wrong `class` value). Keep it consistent with Goal 9 and skip the new export. If a future consumer specifically needs `instanceof`, that is an additive change and backward-compatible.

**3. Date handling: STRICT-JSON**

Reasoning: a `Date` in JS silently serializes to an ISO string via `JSON.stringify` with no round-trip guarantee from the consumer's perspective. Workers who store a `Date` and then read back a `string` have a subtle bug that is invisible at write time. Strict JSON makes the behavior explicit: you passed a `Date`, you get a type error (or the validator rejects it). The one-line replacer the spec mentions does not fix this — it just hides the type mismatch one layer deeper. Workers should format their own dates. The spec is correct.

**4. Migration guide: README**

Reasoning: at v1 scope, there is one write method for one column. A new `MIGRATION.md` for a four-line code change is premature. If Goals 3, 4, and 6 each need multi-page migration text, revisit then. Keep it in `README.md` with a clear heading; it is easy to extract later.

**5. Idempotency: LAST-WRITER-WINS**

Reasoning: true idempotency via payload-hash column adds a column to the schema, a hash computation per call, and a conditional UPDATE — all for a case (re-delivered webhooks or double-calling the same worker) that the spec already handles safely by "the second call updates the same row to the same value." The `UPDATE WHERE detail IS DISTINCT FROM $3` variant is cheaper but only helps if callers actually call twice with the same payload; if they call with different payloads the write still goes through. Neither variant is worth the complexity at v1. Document last-writer-wins clearly and ship.

---

## Industry-comparison challenges

The spec's Section "Decisions locked — API shape" cites Sentry's `captureException`, OpenTelemetry spans, and Bull's `job.update` as precedents for "separate call, not overload." This is accurate as a pattern description. The analogy is a little loose:

- Sentry's `captureException` is not a sibling of a primary failure call — it IS the primary call. There is no underlying "fail" that pg-bossier's `recordTerminalDetail` parallels in Sentry's model.
- Bull's `job.update` writes to Bull's own storage, not to a shadow audit table. The shape is similar but Bull has transaction isolation between the queue write and the metadata write; pg-bossier does not (the two writes — pg-boss's state update and `recordTerminalDetail` — are in different transactions entirely).
- OpenTelemetry spans are the closest true analogy: `span.setStatus` / `span.setAttributes` are separate calls after the primary operation, exactly as the spec describes. This precedent should be foregrounded over the others.

The AWS SDK analogy (from Decision #4 re: `non_retryable` as default) is accurate: AWS SDK's retry classifier defaults errors to non-retryable unless explicitly classified as retryable. That is the correct precedent and the spec gets it right.

---

## Anything the spec missed entirely

**1. The `attempt` parameter's type is `number` but `pgbossier.record.attempt` maps from `pgboss.job.retry_count`, which is `integer` in Postgres.**

`src/read.ts` line 11 types `attempt` as `number`. The SQL schema in `src/sql.ts` line 91 defines it as `integer`. There is no validation on `attempt` in the proposed `recordTerminalDetail` method. A caller passing `attempt: -1` or `attempt: 1.5` produces a query that either matches zero rows (silent no-op, acceptable) or passes a non-integer to Postgres (error from pg). The spec does not address this. The existing `setProgress` in `src/progress.ts` dodges the issue by resolving attempt server-side via `max(attempt)`. `recordTerminalDetail` takes attempt explicitly — it should at minimum note whether non-integer or negative values should throw or silently no-op.

**2. The spec says "`JSON.stringify`'d detail" is passed as `$3::jsonb` but does not address what happens when `JSON.stringify` returns `undefined`.**

`JSON.stringify` returns `undefined` (not the string `"undefined"`) for functions, symbols, and circular references. `src/progress.ts` explicitly guards for this at lines 44–47. The spec says "JSON-serializability is enforced by pg's parameter binder" but pg's binder will throw a driver-level error for `undefined`, not a friendly pg-bossier message. The new method should either replicate `progress.ts`'s guard or share the serialization utility. Leaving it to the pg driver produces a raw driver error instead of the `'pg-bossier: terminal_detail validation: ...'`-prefixed message the spec promises.

**3. The spec names `src/index.ts` in the implementation sketch but does not say which types are re-exported.**

`TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`, and `TerminalDetail` are all candidates. The omission leaves the implementer to decide — which is fine for a sketch, but the public API surface matters for semver and for consumers who import from `'pg-bossier'` directly. The spec should be explicit about what is and is not a public export.

**4. The capture trigger's `ON CONFLICT DO UPDATE` does NOT reset `terminal_detail`.**

This is correct behavior and the spec relies on it — but it is never stated. When pg-boss DELETEs+INSERTs a retry (new attempt), the trigger inserts a new row with a new `(job_id, attempt)` PK. When pg-boss does an in-place UPDATE of state (e.g., `created → active`), the trigger's `ON CONFLICT DO UPDATE` updates the existing row but does NOT overwrite `terminal_detail` because that column is absent from the SET list. This means a write to `terminal_detail` by `recordTerminalDetail` is stable across subsequent trigger fires on the same `(job_id, attempt)` row. The spec should state this as the structural guarantee it is.

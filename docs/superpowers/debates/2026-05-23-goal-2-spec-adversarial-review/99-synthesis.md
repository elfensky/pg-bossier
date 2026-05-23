# Adversarial review — synthesis

**Spec under review:** [`docs/superpowers/specs/2026-05-23-goal-2-terminal-state-detail-design.md`](../../specs/2026-05-23-goal-2-terminal-state-detail-design.md)
**Participants:** Codex CLI (GPT-5), Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet via Agent), Opus (Claude Opus, this session)
**Rounds:** 2 (attack + rebuttal)

## Headline

Convergence is high. All four reviewers identified the same five
load-bearing blockers in round 1, and round 2 either upgraded their
verdicts on those points or strengthened them. The disagreement is
narrow — one decision (state parameter shape) and one debate flavor
(silent-no-op semantics) — and the disagreement is constructive: every
reviewer except Sonnet converged on a single discriminated-union object
argument shape, and even Sonnet's DROP position is compatible with the
shape question (you can drop the parameter from a tagged-union object
too).

The design itself is sound. The Section A signature and the Section C
reader together do not actually deliver the typed-narrowing promise the
spec headline makes. Three additional gaps (legacy `recordPatch` data,
JSON.stringify edge cases, retry-state semantics) need explicit policy
statements. None of these is a redesign; all of them are focused fixes
the next spec revision can land cleanly.

## Verdicts

| Reviewer | Round 1 | Round 2 | Movement |
| --- | --- | --- | --- |
| Codex | BLOCK-UNTIL | SHIP-WITH-NAMED-CHANGES | softened (mismatch fix accepted) |
| Gemini | SHIP-WITH-NAMED-CHANGES | BLOCK-UNTIL | hardened (retry + legacy data added) |
| Sonnet | SHIP-WITH-NAMED-CHANGES | BLOCK-UNTIL | hardened (retry + legacy data added) |
| Opus | BLOCK-UNTIL | BLOCK-UNTIL | unchanged |

Three of four BLOCK-UNTIL going into round 3 / spec revision. The
change list is what matters — see below.

## Unanimous must-land changes

These four reviewers all named these in some form. Spec v2 must include them.

**1. Fix the TypeScript signature.** Replace the flat positional `(jobId, attempt, state, detail)` with a single object argument typed as a discriminated union:

```ts
type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };

client.recordTerminalDetail(jobId: string, attempt: number, payload: TerminalDetail): Promise<void>;
```

The current spec claims static narrowing but the signature doesn't cross-correlate `state` with `detail`. `TerminalDetailFailed` is a subtype of `TerminalDetailCompleted` (`Record<string, unknown>`), so `(state='completed', detail={class:'transient'})` compiles today. The single-object form fixes this.

**2. Close the state/detail mismatch hole.** Today the writer accepts `state` but the SQL ignores it (UPDATE keyed only on `(job_id, attempt)`), and the reader narrows by row.state — so any timing gap or wrong-state call produces incoherent rows the reader silently lies about. Two acceptable fixes:

- **KEEP + SQL-bind (Gemini, Codex, Opus):** add `AND state = $expected` to the WHERE clause; map the `failed` payload to allowed row states `IN ('failed', 'retry')` (see #3). Mismatch becomes a silent no-op.
- **DROP + read-then-write (Sonnet):** resolve the row's actual state inside `recordTerminalDetail`, validate `detail` against it, then write. Eliminates the mismatch class structurally; one extra round-trip on terminal-state events only. Mirrors `setProgress`'s server-side `max(attempt)` resolution.

Sonnet's DROP argument is well-defended (two silent-no-op classes are worse than one), but three reviewers picked KEEP-as-tagged-union. Spec v2 should adopt KEEP-with-SQL-bind as the primary choice and document Sonnet's DROP alternative in an open-question paragraph for future revisit.

**3. Resolve the retry-state reader/writer gap.** pg-boss moves failed attempts through a `retry` state before re-`active`. The current spec's Section C narrows `state: 'retry'` rows to `terminalDetail: null` — but Test 7 describes writing failure detail to a row that pg-boss has already moved to `retry`. The promise breaks. Three reviewers (Codex, Opus, Sonnet) recommend the same fix:

- Public write API keeps the state set as `'completed' | 'cancelled' | 'failed'` (do NOT add `'retry'` — that would conflate in-flight state with terminal classification).
- SQL maps `payload.state === 'failed'` to `row.state IN ('failed', 'retry')`.
- Reader union allows `TerminalDetailFailed | null` on `state: 'retry'` rows (currently hard-coded to `null`).

Gemini's round-1 proposal to add `'retry'` to the API enum is rejected by three reviewers and Gemini concedes the cleaner shape in round 2.

**4. Replicate `setProgress`'s `JSON.stringify` guard.** The spec is internally contradictory — Section A says pg-bossier stringifies (`$3 is the JSON.stringify'd detail`) AND that pg's parameter binder enforces serializability. The binder cannot enforce serializability on something already a string. The implementation must:

- Wrap `JSON.stringify(payload.detail)` in try/catch (catches `BigInt`, circular references).
- Guard against `undefined` return (functions, symbols).
- Throw with the `'pg-bossier: terminal_detail validation: ...'` prefixed message the spec promises.

This is a ~5-line copy of `src/progress.ts:36-47`. Sharing a utility between the two methods is optional but cheap.

**5. Address the pre-Goal-2 `recordPatch` data via explicit policy.** The "trust the writer" claim and the "No migration required" claim cannot both stand without qualification. Existing `0.x` installs may have written arbitrary JSONB to `terminal_detail` via `recordPatch`. The reader will narrow those rows as if they conform. The spec must explicitly name the policy:

- **Recommended (cited CLAUDE.md cover):** "Consumers who used `recordPatch` to write `terminal_detail` before Goal 2 must DROP and reinstall pg-bossier, or run `UPDATE pgbossier.record SET terminal_detail = NULL`. Per CLAUDE.md, `0.x` API instability is accepted."
- State this in spec § Risks AND in the README section.
- Remove or qualify "No migration required" in § Implementation sketch.

## Should-land in v1 (3+ reviewers)

**6. Show the narrowed `recordPatch` SQL in full.** (Sonnet, Codex, Opus.) The current Section B says "drop the `terminal_detail` COALESCE line" but doesn't show the resulting query. `$3` shifting to `input_snapshot` and `$4` disappearing is a silent param-index-mismatch waiting to happen. Six extra lines of spec prevent a real bug class.

**7. Capture-trigger preservation test.** (Codex, Sonnet, Opus.) Add a CI test that the capture trigger's `ON CONFLICT DO UPDATE` SET list does NOT include `terminal_detail`. This is the structural guarantee that makes single-writer safe across trigger fires. Without the test, a future trigger change can silently break Goal 2.

**8. Explicit public type exports.** (Sonnet, Codex, Opus.) Name `TerminalDetail`, `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed` explicitly as re-exports from `src/index.ts`. Public API surface for semver. The current spec gestures at "re-export from `src/index.ts`" without listing.

**9. Document the retry-state worker interaction.** (Codex, Opus, Sonnet.) Add a brief section: "Workers should call `recordTerminalDetail(state: 'failed')` on every failure including ones that will retry. The row at `(jobId, attempt)` is the chronicle for that attempt; its state transitions through `retry` transiently, but the attempt's terminal classification is `'failed'`."

## Should-land in v1 (cheap; 2 reviewers)

- **Foreground OpenTelemetry's `span.setStatus` as the primary industry precedent** (Opus, Sonnet). Demote Sentry / Bull / AWS-SDK to supporting evidence with caveats. The current section overclaims convergence; OTel is the closest true analogue, and the others have important structural differences (Sentry isn't a sibling-of-primary, Bull's writes share a transaction, AWS SDK is retry classification not metadata).
- **`TerminalDetailCompleted = Record<string, unknown>` honest documentation** (Sonnet, Opus): explicitly say "we don't enforce shape on completed; consumers stash anything." Silence invites future contributors to add enforcement and silently break callers.
- **Test 5 (happy-path end-to-end) needs the failure-induction method named** (Sonnet, Opus): `work` handler throws vs explicit `boss.fail`. Different trigger sequences.

## Defer to follow-up (consensus)

1. **SQL CHECK constraint on `terminal_detail`.** (4/4 agree.) JS gate + single-writer + state-bind in SQL is sufficient for v1.
2. **`expired` / `superseded` derivation.** (4/4 agree.) Already deferred in spec; correct.
3. **Append-only audit table.** (4/4 agree.) Inherited from Goal 1; not Goal 2's responsibility.
4. **`Job<TInput, TOutput>` generic.** (4/4 agree.) Cross-cutting issue #13.
5. **Worker-helper auto-classification utilities.** (3/4 agree.) Consumer-owned.

## Positions on the five open questions (final consensus)

| # | Question | Position | Vote |
|---|---|---|---|
| 1 | `state` parameter | **KEEP, as tagged-union object arg** with SQL-bind to row-state | 3 KEEP / 1 DROP (Sonnet) |
| 2 | Error class | **PLAIN `Error` with prefix** | 4/4 |
| 3 | Date handling | **STRICT JSON** (no Date coercion) | 4/4 |
| 4 | Migration guide | **README** | 4/4 |
| 5 | Idempotency | **LAST-WRITER-WINS** | 4/4 |

Question 1 has dissent worth recording in the spec but not relitigating. Sonnet's DROP argument (silent-no-op ambiguity reduction) is sound but outvoted. The next spec revision should adopt KEEP-as-tagged-union with SQL-bind and add a one-paragraph note acknowledging the DROP alternative was considered.

## Recommended path forward

1. **Revise the spec to v2** incorporating items 1-9 above. Most are focused additions; the schema is unchanged.
2. **No re-review needed** for items 1-5 unanimous must-lands. They are mechanical or policy fixes; the implementation captures them by following the revised spec.
3. **Re-review optional** for items 6-9 if the v2 spec materially changes them. The convergence pattern suggests one focused pass would be sufficient.
4. **Then proceed to writing-plans** as the next skill in the brainstorming flow.

The full v2 change footprint is roughly: 1 type change (TerminalDetail union object), 1 SQL change (add `AND state = $...` to UPDATE; expand `recordPatch` SQL display), 1 reader union update (allow `TerminalDetailFailed | null` on retry rows), 1 JSON.stringify guard utility (5-line copy from `setProgress`), and ~6 documentation additions. No new files vs the v1 spec, no migration code, no new pg-boss surfaces.

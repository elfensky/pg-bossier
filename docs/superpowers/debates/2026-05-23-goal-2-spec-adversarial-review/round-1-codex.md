## Verdict
BLOCK-UNTIL

## Must-land changes (blockers)
1. The attempt-level state model is internally inconsistent. Section C says `retry` rows read back with `terminalDetail: null`, but Test 7 explicitly expects attempt `0` to keep failure detail after pg-boss has advanced the job to attempt `1`. In a row-per-attempt chronicle, a failed attempt that will retry is typically a `retry` row, not a `failed` row. As written, the spec cannot both preserve retry-attempt failure detail and narrow `terminalDetail` by `state` the way it claims. Fix the model first: either `retry` must also carry the failed-shape detail, or the detail must carry its own discriminator independent of row `state`.
2. The `recordTerminalDetail` TypeScript signature does not enforce `state`/`detail` correlation. The shown signature is `state: 'completed' | 'cancelled' | 'failed'` plus `detail: Completed | Cancelled | Failed`; that allows `recordTerminalDetail(id, 0, 'failed', { cancelledBy: 'x' })` at compile time. The spec’s claim that “the discriminated-union type ensures `state` and `detail` agree statically” is false unless this is rewritten as overloads, a generic keyed by `state`, or a single object parameter carrying both fields.
3. The write path validates `detail` against the caller-provided `state`, but never checks that against the persisted row’s actual state. With the SQL shown, a caller can write failed-classified detail onto a `completed` row, and the reader will later cast that row to the completed branch. That breaks the advertised type invariant even if all writes go through the new method. The update needs a state guard or a documented/implemented mapping such as `failed -> row.state IN ('failed', 'retry')`, `completed -> 'completed'`, `cancelled -> 'cancelled'`.
4. “Trust-the-writer; no read-time parse” is not compatible with “No migration required.” Today `recordPatch` already allows arbitrary `terminal_detail?: unknown`, and raw SQL can always bypass the writer. Narrowing public read types without any tolerant parse means existing rows can become type lies after upgrade. Either add a minimal read-time validator/coercer, or explicitly preserve `unknown` for malformed/legacy rows instead of claiming the narrowed type is sound.

## Should-land in v1 (not blockers, but cheap)
1. Tighten the JSON semantics section. It currently says pg’s binder enforces JSON-serializability, but Section A also says `$3` is `JSON.stringify`’d detail. Those are different behaviors, especially for nested functions, `undefined`, `NaN`, and `Date`. Pick one behavior and test it.
2. Align the cancelled/completed typings with the “open shape” claim. Runtime validation says non-failed states accept any object, but `TerminalDetailCancelled` is not open-shaped, so extra keys are accepted at runtime and erased from the public type.
3. Add explicit tests for state mismatch and malformed historical data: writing `'failed'` detail to a `completed` row, reading a legacy row whose `terminal_detail` lacks `class`, and reading a `retry` row after a retry-triggered failure.
4. Call out the TS surface break honestly. Removing `terminal_detail` from `RecordPatch` is a breaking API change for TS consumers even if there is no schema migration.

## Defer to follow-up
1. SQL `CHECK` on `terminal_detail` can defer once the library-level invariants are actually coherent.
2. `expired` and `superseded` derivation can defer; they are useful, but not load-bearing for the core “worker can classify failure” path.
3. Append-only audit can defer; it is orthogonal to whether one attempt row can hold typed terminal detail correctly.
4. Worker-side classification helpers can defer; they are convenience, not core storage/API design.
5. True idempotency can defer if the semantics stay documented as overwrite-only.

## Positions on the five open questions
1. state parameter: KEEP — reasoning  
It is not redundant under the current attempt-level model, because retry rows are the counterexample: the worker’s semantic terminal result for the attempt is “failed”, while the persisted row may be `retry`. Keep it, but enforce it against the row with an explicit allowed-state mapping.
2. Error class: PLAIN — reasoning  
A typed error buys little here. The useful distinction is programmer error vs audit-write no-op, and a stable message prefix is enough. Keep the surface small.
3. Date handling: STRICT-JSON — reasoning  
Do not invent custom coercion rules for one field. If you accept `Date`, you now own a serialization policy. Keep normal JSON semantics and document them precisely.
4. Migration guide: README — reasoning  
This is one focused behavior change, not a broad migration program. A README section is enough unless multiple later goals accumulate worker-facing migration steps.
5. Idempotency: LAST-WRITER-WINS — reasoning  
That is adequate for v1. Full idempotency needs more machinery and does not solve the bigger correctness issues above. If desired later, `IS DISTINCT FROM` is a small optimization, not a design prerequisite.

## Industry-comparison challenges
Sentry is the strongest analogy here: `captureException` is indeed a separate call. But it is an observability event API, not a typed stateful overwrite on a per-attempt audit row, so it does not validate the row-model choices in this spec.
OpenTelemetry is a weak comparison. `recordException` is a method on an existing span context, not a sibling API for out-of-band terminal metadata keyed by `(jobId, attempt)`. It also usually pairs exception recording with span status, so the “separate call” similarity is superficial.
Bull/BullMQ is oversimplified or partly wrong. The common surface is `job.updateProgress`; failure detail is primarily the thrown error / failed reason and queue events, not a general-purpose `job.update` terminal-detail API analogous to this one.
The AWS SDK comparison is too loose. AWS SDKs internally classify retryable conditions, but they do not expose a simple mandated app-authored binary `class: transient | non_retryable` convention as their central contract. Using AWS as support for the “default to non_retryable” policy is not very persuasive.

## Anything the spec missed entirely
The spec treats this as “no migration required,” but it is an API and type migration for consumers in two places: `recordPatch` loses a field, and readers start claiming stronger types than old rows may satisfy.
It never specifies the authoritative mapping between attempt lifecycle and row `state` for retrying failures. That mapping is now central to Goal 2, not incidental.
It does not test the actual compile-time promise of the new write API. There should be fixture tests proving valid combinations compile and invalid `state`/`detail` combinations fail.
It does not say how a worker is expected to source the `attempt` argument reliably. Since correctness now depends on `(jobId, attempt)`, the public docs should be explicit about where that number comes from and whether it is zero-based.
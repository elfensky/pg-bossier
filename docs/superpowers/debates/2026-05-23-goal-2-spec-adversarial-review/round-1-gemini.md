## Verdict
SHIP-WITH-NAMED-CHANGES

## Must-land changes (blockers)
1. **Enforce Read-Side Soundness via SQL WHERE clause:** The `recordTerminalDetail` SQL must include `AND state = $arg_state` in its `WHERE` clause. Without this, a worker could write a `failed` detail shape to a row that is actually `completed` (or vice-versa) due to a late signal or race. Since the reader (`findById`) performs an unsafe cast to the narrowed `TerminalDetail*` type based solely on the row's `state`, allowing mismatched writes creates a TypeScript soundness hole where `terminalDetail` can be non-null but missing mandatory fields like `class`.
2. **Support `retry` state in the write API:** pg-boss moves failed jobs to the `retry` state if attempts remain. The spec's `TerminalDetail` union only lists `failed`, `completed`, and `cancelled`. Workers calling `recordTerminalDetail` after a failure shouldn't have to check if it was the *last* failure. The API must accept `state: 'retry'` and apply the same validation/shape as `failed`.
3. **Validate JSON-serializability explicitly:** Like `setProgress` in `src/progress.ts`, `recordTerminalDetail` must try-catch `JSON.stringify(detail)` before the SQL call. Relying on the pg binder to throw is too late and yields a less helpful error message for the consumer (programmer error vs DB error).
4. **Clarify `TerminalDetailFailed` narrowing:** The type `TerminalDetailFailed & Record<string, unknown>` is slightly redundant since `TerminalDetailFailed` already has optional `message` and `where` and uses `Record<string, unknown>` to be open-ended. It should be defined as a single interface with an index signature or just the intersection, but ensure the `class` property is truly mandatory and not swallowed by the `unknown` record.

## Should-land in v1 (not blockers, but cheap)
1. **Document the "Late Write" behavior:** Explicitly state in the JSDoc that if a job's state has already transitioned away from the provided `state` (e.g., a worker fails, but the job is manually cancelled before `recordTerminalDetail` lands), the write will be a silent no-op. This is the correct behavior to preserve data integrity.
2. **Consistency in `state` parameter naming:** The `state` parameter on `recordTerminalDetail` should probably be named something like `targetState` or `reportedState` to clarify it's the state the worker is reporting, which must match the DB.

## Defer to follow-up
1. **Trigger-side `expired` / `superseded` markers:** This is correctly deferred, but the spec should note that `terminalDetail: null` on a `failed` job is the primary signal for these cases in v1.
2. **SQL CHECK constraints:** JS-side validation is sufficient for v1 given the "single-writer" convention.

## Positions on the five open questions
1. **state parameter: KEEP** — It is essential for ensuring that the `detail` shape matches the job's actual state in the database. Without it, we lose the ability to verify the "writer-to-reader" contract that the TypeScript types promise.
2. **Error class: PLAIN** — Matches the precedent in Goal 9 and `setProgress`. Keep it simple and consistent with the existing prefix-based error identification.
3. **Date handling: STRICT-JSON** — Consistency with `setProgress`. Workers should be responsible for serializing their own payloads. If we add `Date` support later, it should be a cross-cutting change for all JSONB write methods.
4. **Migration guide: README** — New users look at the README first. Until the documentation volume becomes unmanageable, keeping it in one place prevents "doc fragmentation."
5. **Idempotency: LAST-WRITER-WINS** — This is the standard pattern for `pg-bossier` (and `pg-boss` itself). Adding hash-based idempotency adds storage and logic overhead that isn't justified by the use cases today.

## Industry-comparison challenges
- **AWS SDK Retry Strategy:** The spec claims AWS SDK defaults to `non_retryable`. Actually, AWS SDK (and most cloud SDKs) default to retrying on most transient-looking errors (5xx, throttling, networking) and only stop on specific 4xx "ClientError" types. The spec's "default to non_retryable" is a safer *data-integrity* choice for pg-bossier consumers, but it's not strictly "what AWS does."
- **OTel Span events:** OTel spans are append-only. `pg-bossier` is currently overwrite-in-attempt. The spec correctly identifies this as an "inherited limitation" but should be wary of calling it "matching industry pattern" when industry patterns like OTel often prioritize the full event log over the current-state snapshot.

## Anything the spec missed entirely
- **Circular References:** `detail` objects might contain circular references (especially if a worker just passes a raw Error object or a large context). The `JSON.stringify` check (Must-land #3) will catch this, but the README should warn against passing complex objects directly.
- **Array Support:** JSONB supports top-level arrays. The spec says "`detail` non-plain-object (array, primitive, function) → throw". This is a good constraint for the "shape" goals, but should be explicitly tested.

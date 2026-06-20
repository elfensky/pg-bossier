# Goal 2 — Terminal-state detail (design)

**Status:** v2 — post-adversarial-review.
**Tracking issue:** [#3](https://github.com/elfensky/pg-bossier/issues/3).
**Charter rubric:** Goal 2 of [issue #1](https://github.com/elfensky/pg-bossier/issues/1).
**Adversarial review:** [`docs/superpowers/debates/2026-05-23-goal-2-spec-adversarial-review/`](../debates/2026-05-23-goal-2-spec-adversarial-review/) — four reviewers, two rounds, unanimous convergence on the v2 change list.

## What ships

Three additions on top of the existing Goal 1 storage substrate (the
`pgbossier.record` chronicle table + capture trigger on `pgboss.job`):

1. **A worker-signaling write method.** `client.recordTerminalDetail(jobId, attempt, payload)` on the unified `bossier` client. `payload` is a single discriminated-union object `{ state, detail }`. JS-validates the `detail` shape against `state`. The SQL UPDATE binds `state` into the WHERE clause to prevent writing failure-shaped data to a `completed` row (or vice versa). The existing `recordPatch` is narrowed to drop its `terminal_detail` field — `recordTerminalDetail` becomes the sole writer for that column.
2. **A documented shape convention** for the `terminal_detail` JSONB column, discriminated by row `state` (`completed` / `cancelled` / `failed` / `retry`). `class` is mandatory on `failed`-classified writes.
3. **A typed reader.** No new read methods. The existing `findById` / `listJobs` / `latestPerQueue` / `getRetryHistory` return a discriminated-union `JobRecord` where `terminalDetail` narrows by `state`. `retry`-state rows can carry `TerminalDetailFailed | null` (preserving the chronicle row for an attempt that pg-boss is about to retry).

No new schema columns. No new pg-boss surfaces. No SQL CHECK constraint in v1. No `expired` / `superseded` derivation in v1.

## Why

descent-app has ~45 raw-SQL queries against `pgboss.*` ([descent-app#343](https://github.com/drunikbe/descent-app/issues/343)); a substantial subset are failure-classification queries that today string-match error messages out of `pgboss.job.output`. Settling a typed failure shape — with `class: 'transient' | 'non_retryable'` mandated — turns those queries into one indexed JSONB lookup. The v1 success criterion from issue #1 is "'why did this fail?' is answerable with one typed query." That requires a shape, not just a storage column.

## Decisions locked

These were brainstormed with the user and ratified by adversarial review. The spec incorporates the conclusions rather than re-litigating them.

### 1. API shape — new method, not pg-boss-method overload

**Way B picked over Way A.** `recordTerminalDetail` is a new sibling method on the `bossier` client, not a proxy interception of `boss.fail`. Reasoning:

- Zero coupling to `boss.fail`'s signature. Upstream parameter additions can't silently misalign our proxy logic.
- Method shadowing breaks the Principle of Least Astonishment. A `client.fail` that looks like pg-boss's `fail` but secretly writes to a second table is surprising.
- Mirrors Goal 6's `setProgress` precedent (separate call, not a wrapper).
- Industry pattern. **OpenTelemetry's `span.setStatus` is the closest precedent** (status mutates in place on a span that exists across the primary operation's lifetime, exactly the pattern Goal 2 ships). Sentry's `captureException` and Bull's `job.update` are supporting evidence with caveats — Sentry's call IS the primary, not a sibling; Bull's writes share a transaction with the queue write (pg-bossier's two writes are in different transactions). AWS SDK's "non_retryable as conservative default" precedent stands for Decision 4 only.

### 2. Single tagged-union object argument

Replacing the v1 spec's four-positional-parameter signature. The flat positional form does not couple `state` to `detail` at the TypeScript level — `TerminalDetailFailed` is a subtype of `Record<string, unknown>`, so a `(state='completed', detail={class:'transient'})` call would compile today. Adversarial review (Codex, Sonnet, Opus) flagged this as a type-correctness blocker; Gemini concurred in round 2.

Final signature:

```ts
type TerminalDetailCompleted = Record<string, unknown>;
type TerminalDetailCancelled = { cancelledBy?: string; reason?: string };
type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
} & Record<string, unknown>;

type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };

client.recordTerminalDetail(
  jobId: string,
  attempt: number,
  payload: TerminalDetail,
): Promise<void>;
```

TypeScript's discriminated-union narrowing now works correctly: `payload.state === 'failed'` narrows `payload.detail` to `TerminalDetailFailed` at the call site, and the validator enforces shape on the way in.

### 3. SQL writer binds `state` into the UPDATE; `failed` maps to `state IN ('failed', 'retry')`

The v1 spec wrote `UPDATE ... WHERE job_id = $1 AND attempt = $2` and let any payload onto any row regardless of the row's actual state. v2 binds state into the WHERE clause:

```sql
UPDATE pgbossier.record
   SET terminal_detail = $4::jsonb
 WHERE job_id = $1
   AND attempt = $2
   AND state = ANY($3::text[])
```

Mapping from `payload.state` to allowed `row.state` values:

| `payload.state` | Allowed `row.state` |
| --- | --- |
| `'completed'` | `'completed'` |
| `'cancelled'` | `'cancelled'` |
| `'failed'` | `'failed'`, `'retry'` |

The `'retry'` mapping handles pg-boss's failure→retry sequence: when a worker's handler throws, pg-boss first sets `state='failed'` (capture trigger fires), then the retry maintenance moves the row to `state='retry'` before re-inserting attempt N+1. A worker calling `recordTerminalDetail({state: 'failed', detail: ...})` somewhere in that window writes against the row whatever state it currently has — `failed` or `retry`. The detail stays attached to the attempt's chronicle row.

A mismatched call (e.g., `state: 'completed'` against a row whose actual state is `cancelled`) silently no-ops. Same convention as wrong-`(jobId, attempt)` no-op.

### 4. JS validation in the new method, plus single-writer narrowing of `recordPatch`

JS validation runs in `recordTerminalDetail`. `recordPatch` is narrowed to only write `input_snapshot` (its `RecordPatch` type drops `terminal_detail`). `recordTerminalDetail` becomes the sole writer for terminal_detail.

No SQL CHECK constraint in v1. The JS gate plus single-writer plus SQL state-bind is the v1 enforcement. SQL CHECK is named in § Out of scope as a deferred follow-up.

### 5. `expired` / `superseded` derivation — deferred entirely

v1 records what the worker signaled. For structurally-unsignalable cases (pg-boss expires a job externally; pg-boss displaces a singleton), the row reads back with `terminalDetail: null` — honest "we don't know." Derivation (trigger-side vs reader-side) is a focused follow-up sub-issue, not v1 scope.

### 6. "Unknown" class — not added; `null` + documented default

The class enum stays binary (`'transient' | 'non_retryable'`). When a worker can't classify, the documented convention is: default to `non_retryable` (conservative; matches AWS SDK's retry strategy), put the reason in `message`. `null` already carries the "nobody-signaled" semantic; a third enum value `'unknown'` would duplicate that and defeat the class mandate's purpose.

### 7. TypeScript reader surface — `retry` rows can carry failed-shape detail

The v1 spec hard-coded `state: 'retry'` rows to `terminalDetail: null`. Adversarial review identified this as breaking Test 7's promise. v2 fixes the reader union:

```ts
export type JobRecord =
  | { state: 'created' | 'active'; terminalDetail: null;                                       /* ... */ }
  | { state: 'retry';     terminalDetail: TerminalDetailFailed | null;                         /* ... */ }
  | { state: 'completed'; terminalDetail: TerminalDetailCompleted | null;                      /* ... */ }
  | { state: 'cancelled'; terminalDetail: TerminalDetailCancelled | null;                      /* ... */ }
  | { state: 'failed';    terminalDetail: TerminalDetailFailed | null;                         /* ... */ };
```

A worker's `recordTerminalDetail({state: 'failed', detail})` lands on whatever row state pg-boss happens to have set — `failed` or `retry`. Either reader narrowing returns a valid `TerminalDetailFailed`.

## Design

### Section A — The new write method

**Signature:** see Decision 2 above.

**Validation rules (run before any SQL).**

- `payload.state === 'failed'` and `payload.detail.class ∉ {'transient', 'non_retryable'}` → throw with message `pg-bossier: terminal_detail validation: failed state requires class in ('transient', 'non_retryable')`.
- `payload.state ∈ {'completed', 'cancelled'}` → no shape enforcement (open).
- `payload.detail` non-plain-object (array, primitive, function, null) → throw.

**JSON-serializability is enforced in-method, not by the pg driver.** pg-bossier stringifies the detail before sending to Postgres; the binder sees a string and cannot enforce serializability. The implementation must replicate `setProgress`'s guard pattern (`src/progress.ts:36-47`):

```ts
let json: string;
try {
  json = JSON.stringify(payload.detail);
} catch (err) {
  throw new Error(
    `pg-bossier: terminal_detail validation: detail is not JSON-serializable: ${String(err)}`
  );
}
if (json === undefined) {
  // JSON.stringify yields undefined for a function or symbol.
  throw new Error(
    `pg-bossier: terminal_detail validation: detail is not JSON-serializable`
  );
}
```

Sharing a utility between `setProgress` and `recordTerminalDetail` is optional but recommended (a single `src/json.ts` exporting `stringifyOrThrow(value, fieldName)`).

**Standard JSON behaviors are documented, not normalized.** `Date` → ISO string. `BigInt` → throws. Non-finite numbers → JSON `null`. These are standard `JSON.stringify` behaviors; pg-bossier doesn't transform them. Workers who want round-trip fidelity must format their own values into strings or numbers before calling.

**Error type.** Plain `Error` with the recognizable message prefix (`'pg-bossier: terminal_detail validation: ...'`). Consistent with Goal 9's schema-validation errors; no new exported class.

**Fail-open or throw?** Throw on validation failure. This call is consumer-initiated, not pg-boss-internal — the fail-open rule applies to pg-bossier writes that happen inside pg-boss's lifecycle (the capture trigger), not to explicit worker calls. The worker called us; the worker handles the error.

**Wrong `(jobId, attempt)` or wrong `state` → silent no-op.** Same convention as `setProgress` and `recordPatch`. The SQL `UPDATE` matches zero rows; the call resolves without throwing. Mismatched state and wrong key are not distinguished — both produce zero affected rows.

**Concurrent calls → last-writer-wins.** Two `recordTerminalDetail` calls for the same `(jobId, attempt)` run as two separate UPDATEs. The second one wins entirely; no JSONB merge. Documented behavior.

**Full SQL:**

```sql
UPDATE pgbossier.record
   SET terminal_detail = $4::jsonb
 WHERE job_id = $1
   AND attempt = $2
   AND state = ANY($3::text[])
```

Where `$3` is `ARRAY['failed', 'retry']` when `payload.state === 'failed'`, else `ARRAY[payload.state]`.

### Section B — `recordPatch` narrowing

`src/record.ts` today:

```ts
export interface RecordPatch {
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}
```

After Goal 2:

```ts
export interface RecordPatch {
  input_snapshot?: unknown;
}
```

The full narrowed SQL inside `recordPatch`:

```sql
UPDATE pgbossier.record
   SET input_snapshot = COALESCE($3, input_snapshot)
 WHERE job_id = $1
   AND attempt = $2
```

Param indices: `$1 = jobId`, `$2 = attempt`, `$3 = input_snapshot` (was `$4` before; the old `$3 = terminal_detail` is removed). Adversarial review (Sonnet, Codex, Opus) called out that gesturing at "drop the COALESCE line" without showing the result is an invitation to silent param-index bugs.

The `recordPatch` JSDoc gains a sentence pointing at `recordTerminalDetail` for terminal_detail writes (mirror of the existing Goal-6 sentence pointing at `setProgress` for progress).

### Section C — Reader / TypeScript narrowing

`src/read.ts` already discriminates `JobRecord` by `state`. Goal 2 replaces the existing `terminalDetail: unknown` field with the narrowed payload type (see Decision 7 above for the full union).

Consumer usage narrows by `state`:

```ts
const job = await client.findById(id);
if ((job.state === 'failed' || job.state === 'retry') && job.terminalDetail) {
  if (job.terminalDetail.class === 'transient') { /* retry classification */ }
}
```

**Trust-the-writer at read time, no runtime parse.** JSONB returns `unknown` from `pg`; the reader casts to the narrowed type without validating shape. Soundness rests on three load-bearing pieces:

1. `recordTerminalDetail` is the sole writer (single-writer convention; enforced by the `RecordPatch` narrowing in Section B).
2. The SQL writer binds `state` so a write can't land on a wrong-state row.
3. The capture trigger's `ON CONFLICT DO UPDATE` does NOT include `terminal_detail` in its SET list (`src/sql.ts:143-150`). This is the structural mechanism that makes single-writer durable across trigger fires. A CI test locks this in (see § Testing #11).

For pre-Goal-2 installs, see § Risks #5.

### Section D — pg-boss compatibility tier check

**Zero new pg-boss surfaces touched.** Goal 2 only writes to and reads from `pgbossier.record.terminal_detail` and `pgbossier.record.state` (the latter via the writer's WHERE clause, but `state` is already in the chronicle's own Transitional dependencies inherited from Goal 1). No new `pgboss.job` columns read by pg-bossier itself, no new pg-boss API methods called, no new pg-boss event subscriptions, no `pg-boss/src/*` reach-ins.

`COMPATIBILITY.md` adds no entries. The compatibility section in this spec is a confirmation rather than an extension. Caveat: Goal 2 inherits Goal 1's Transitional assumptions about the `pgboss.job` retry sequence (failure → retry → re-insert); those are documented in `COMPATIBILITY.md` already.

The capture trigger from Goal 1 is unchanged. The validator runs in-process before any pg-boss call.

## Out of scope (v1) — explicitly deferred

The brainstorm and adversarial review surfaced six tempting additions. Each goes to its own follow-up issue rather than expanding Goal 2.

1. **`expired` derivation.** pg-boss-expired jobs (worker can't signal) read back as `failed` + `terminalDetail: null`. Follow-up issue picks trigger-side vs reader-side derivation.
2. **`superseded` derivation.** Singleton-queue displacement. Same shape-of-derivation question. Defer.
3. **SQL CHECK constraint on `terminal_detail`.** Belt-and-braces over the JS gate + SQL state-bind; deferred until those prove insufficient in practice.
4. **Append-only audit table** (one row per state transition, not per attempt). Inherited limitation from Goal 1; not a Goal 2 fix.
5. **`Job<TInput, TOutput>` generic surface.** Cross-cutting issue #13. Goal 2 ships open-shape JSONB without generics.
6. **Worker-helper auto-classification utilities** (e.g., `classify(err)` mapping `ECONNRESET → transient`). Consumer-owned; pg-bossier ships the discriminator, not the heuristics.

## Testing

New file `test/terminal-detail.test.ts`:

1. **Validation rejects missing class on failed.** `recordTerminalDetail(id, 0, { state: 'failed', detail: {} })` throws; no row modified.
2. **Validation rejects unknown class value.** `{ state: 'failed', detail: { class: 'maybe' } }` throws.
3. **Validation accepts both legal class values.** `transient` and `non_retryable` both succeed.
4. **Validation accepts non-failed states with any shape.** `{ state: 'completed', detail: { ... } }` and `{ state: 'cancelled', detail: { cancelledBy, reason } }` both succeed.
5. **Happy path writes JSONB and reader narrows.** End-to-end: `send` → handler throws via `work` callback → `recordTerminalDetail` → `findById` returns `terminalDetail.class === 'transient'`. The test names the failure-induction method explicitly (handler throw, not explicit `boss.fail`).
6. **Wrong `(jobId, attempt)` is a silent no-op.** Non-existent pair resolves without throwing; no row touched.
7. **Late call after pg-boss DELETE+INSERT retry.** Worker fails attempt 0, pg-boss moves the row through `state='retry'`, eventually re-inserts as attempt 1. Worker calls `recordTerminalDetail({state: 'failed', detail})` for attempt 0 against the chronicle's preserved row. The detail lands on attempt 0's row regardless of whether that row's state is `failed` or `retry` at the call's moment. Test verifies (a) chronicle preservation (count of rows per job_id before/after), (b) attempt 0's row receives the detail, (c) attempt 1's row is untouched.
8. **Concurrent calls — last-writer-wins.** Two sequential calls for the same `(id, attempt)` with different payloads; the second payload is what `findById` returns.
9. **State-mismatch is a silent no-op.** Call `recordTerminalDetail({state: 'completed', detail: {...}})` on a row whose actual state is `cancelled`. The UPDATE matches zero rows; no row is modified.
10. **`JSON.stringify` edge cases.**
    - Function in detail → throws with prefixed message.
    - `BigInt` in detail → throws with prefixed message (carries the underlying error string).
    - Symbol-keyed property → JSON.stringify drops silently; not pg-bossier's job to validate further.
    - Circular reference → throws with prefixed message.

Extensions to existing tests:

11. **Capture trigger preserves `terminal_detail`.** After `recordTerminalDetail` writes detail, induce another trigger fire on the same `(job_id, attempt)` row (e.g., via a state UPDATE on `pgboss.job`). Assert `terminal_detail` is unchanged. Locks in the structural guarantee Section C depends on.
12. **`recordPatch` no longer accepts `terminal_detail`.** TypeScript rejects the field at compile time (test fixture file); runtime exercise of the remaining `input_snapshot` path is a regression guard.
13. **Reader narrowing.** Compile-time check fixture asserting `if (state === 'failed' || state === 'retry')` narrows `terminalDetail` to `TerminalDetailFailed | null`.

**Not tested in v1.**
- `expired` / `superseded` derivation — out of scope.
- SQL CHECK constraint — out of scope.
- Cross-version behavior (pg-boss versions other than the peer-dep floor) — issue #19's concern.

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Worker calls `recordTerminalDetail` after pg-boss's DELETE+INSERT retry; writes to historical row by `(id, attempt)`. | Medium | Low (semantically correct — old row keeps old detail) | Document the `attempt` parameter as the lookup key. Test 7 covers it. |
| 2 | Worker never calls `recordTerminalDetail` → row has `terminalDetail: null`. | High | Low (matches honest semantic) | Reader narrowing surfaces `null` explicitly. README documents the migration path. |
| 3 | Worker classification drift across handlers (`{ class: 'transient' }` vs `{ class: 'transient', http_status: 429 }` vs `{ class: 'transient', kind: 'rate-limit' }`). | High | Medium | Out of pg-bossier's scope. Consumer enforces project-internal convention. |
| 4 | `recordTerminalDetail` throws inside a worker's error handler → swallows original error. | Medium | Medium | Validator message names the field. README example shows try/catch + fallback to `non_retryable`. |
| 5 | **Pre-Goal-2 `recordPatch` writes.** Existing `0.x` installs may have written arbitrary JSONB to `terminal_detail` via `recordPatch`. The new typed reader narrows those rows as if they conform to the discriminated union, producing type-lies at the call site. | Medium (any 0.x consumer who used `recordPatch` for `terminal_detail`) | Medium | **Upgrade policy:** consumers must run `UPDATE pgbossier.record SET terminal_detail = NULL` (or `DROP SCHEMA pgbossier CASCADE` + reinstall) before relying on the narrowed reader. Per CLAUDE.md, `0.x` API instability is the cover. Stated in README "Upgrading to Goal 2" section. **Not** "no migration required." |
| 6 | JS-only validation is bypassable via raw SQL or direct `pool.query`. | Low (descent-app uses our API) | Medium | Documented limitation. SQL CHECK deferred. |
| 7 | Append-only audit not delivered — within-attempt intermediate transitions still overwrite. | Inherited from Goal 1 | Medium | Documented inherited limitation; not Goal 2's responsibility. |

## Open question (single dissent recorded)

**State-parameter shape.** Three of four reviewers picked KEEP-as-tagged-union with SQL state-bind (the v2 design above); Sonnet argued for DROP + read-then-write inside `recordTerminalDetail`. Sonnet's argument: a state-bind no-op is indistinguishable from a wrong-`(jobId, attempt)` no-op, so we now have two silent-no-op classes. The DROP approach reads the row's state once before writing, validates against the actual state, and writes only if terminal — eliminating both no-op classes at the cost of one extra round-trip on terminal-state events.

The v2 design adopts KEEP-as-tagged-union as the majority position. If practical operation surfaces the silent-no-op ambiguity as a real debugging problem, switch to DROP + read-then-write in a focused follow-up. Both designs use the same public API surface (`{ state, detail }`); the change would be implementation-internal.

## Implementation sketch (rough scope)

Files touched:

- `src/record.ts` — narrow `RecordPatch`; drop `terminal_detail` from the UPDATE; show full SQL.
- `src/terminal-detail.ts` — **new file**, exports `recordTerminalDetail` factory used by `client.ts`. The validation + state-mapping + SQL UPDATE. Estimated 50-60 LOC.
- `src/json.ts` — **new file (optional but recommended)**, exports `stringifyOrThrow(value, fieldName)` shared between `setProgress` and `recordTerminalDetail`. Estimated 10 LOC.
- `src/client.ts` — add `recordTerminalDetail` to the `BossierMethods` surface (the proxy's own method list, alongside `setProgress`, `recordPatch`, `findById`, ...).
- `src/read.ts` — replace `terminalDetail: unknown` with the discriminated-union payload type. Allow `TerminalDetailFailed | null` on `state: 'retry'` rows.
- `src/index.ts` — re-export the new public types from the package surface. **Public exports:** `TerminalDetail`, `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`. Adversarial review (Sonnet, Codex, Opus) asked for these to be explicit.
- `test/terminal-detail.test.ts` — **new file**, tests 1-10.
- `test/recordPatch.test.ts` — extend with test 12.
- `test/read.test.ts` — extend with test 13.
- `test/capture-trigger.test.ts` (or wherever the trigger is tested today) — extend with test 11.
- `README.md` — add "Recording terminal detail" section. Include the upgrade-policy paragraph for pre-Goal-2 `recordPatch` users.
- `CHANGELOG.md` — entry under `[Unreleased]`.
- `CLAUDE.md` — project status paragraph + goal-status table sync.

No migration code shipped. The legacy data is handled by an explicit upgrade-policy note, NOT by a code-level backfill or runtime parser.

## Success criteria

- `npm run lint && npm run build && npm test` passes locally and in CI.
- A descent-app-style call (`recordTerminalDetail(id, 0, { state: 'failed', detail: { class: 'transient', http_status: 429 } })`) writes the row and is retrieved by `findById` with the narrowed type, even after pg-boss has moved the row through `state='retry'`.
- Test 7 (late call after retry) demonstrates the storage substrate's cross-attempt preservation works for terminal_detail too — including the `state='retry'` reader path.
- Test 11 (capture trigger preservation) locks in the structural guarantee the reader trusts.
- `COMPATIBILITY.md` requires no edits — confirmed by adversarial review.
- Issue #3 closes on merge.

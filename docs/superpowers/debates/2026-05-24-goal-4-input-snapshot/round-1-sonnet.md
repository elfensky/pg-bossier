# Round 1 Review — Goal 4 Input-Snapshot Slot (Sonnet)

## Verdict

SHIP-WITH-NAMED-CHANGES

The spec is fundamentally sound. The sibling-method shape, the fail-open contract,
the replace semantic, the `recordPatch` coexistence decision — all correct. Two
named changes are blockers: a consistency gap in `recordPatch`'s SQL (distinct from
the spec's own merge-vs-replace deliberation), and a test gap for the dual-writer
collision scenario. Everything else is cheap polish or safe to defer.

---

## Must-land changes (blockers)

**1. `recordPatch` uses `COALESCE($3, input_snapshot)` — this is a silent swallow,
not a replace.**

`src/record.ts` lines 26-34. The SQL is:

```sql
UPDATE pgbossier.record SET
  input_snapshot = COALESCE($3, input_snapshot)
WHERE job_id = $1 AND attempt = $2
```

When the caller passes `patch.input_snapshot = null` (the JS `null`, which maps
to SQL NULL via `patch.input_snapshot ?? null` at line 32), this evaluates as
`COALESCE(NULL, input_snapshot)` and the column stays unchanged — the caller's
intent to clear the snapshot is silently dropped. This is already shipped code
that contradicts the spec's stated "replace-on-write" semantic (spec section "The
new writer" / Decision 5). The spec defines `recordInputSnapshot`'s SQL as plain
`SET input_snapshot = $3::jsonb`, which correctly writes null. `recordPatch` must
be consistent.

Fix: change the SQL to `input_snapshot = $3::jsonb` and pass `patch.input_snapshot
=== undefined ? undefined : (patch.input_snapshot ?? null)` — or simply have
`recordPatch` skip the column when the key is absent from the patch object. The
simplest safe fix: only set `input_snapshot` in the SET clause when
`patch.input_snapshot !== undefined`. Right now the RecordPatch type is
`input_snapshot?: unknown`, so `undefined` means "caller didn't pass it." A
clean implementation would build the UPDATE SET list dynamically, or at minimum
distinguish "not passed" from "passed as null."

This is a pre-existing bug that Goal 4 inherits. The spec should call it out and
fix it in the same PR, since Decision 5 explicitly says both writers must cooperate.

**2. Test 9 ("retry preservation") does not cover the dual-writer collision scenario.**

The test plan checks that `getRetryHistory` returns both rows with their
snapshots. It does not test: what happens when `recordPatch({input_snapshot: X})`
and `recordInputSnapshot(jobId, attempt, Y)` are both called for the same
`(jobId, attempt)`. Since they write the same column, last-writer-wins, but this
must be an explicit test with an assertion on what the reader returns. The spec
acknowledges the scenario in Risk #5 ("No race-induced data loss") but the test
plan does not cover it. Add a test: call both writers in each order; verify the
last-called value wins.

---

## Should-land in v1 (not blockers, but cheap)

**1. Add a UUID format guard to `recordInputSnapshot`, matching `setProgress`'s
pattern (`src/progress.ts` line 13-14).**

`setProgress` has no UUID guard (it relies on the UPDATE silently matching zero
rows), but `getProgress` in `src/progress.ts` has `UUID_RE.test(jobId) → return
null` on line 68. The new reader `getInputSnapshot` should have the same guard to
short-circuit before touching the DB on obviously-wrong inputs. The writer
`recordInputSnapshot` can omit it (wrong UUID → zero-row UPDATE → warning log; the
fail-open contract handles it), but the reader should be defensive.

**2. The "reader returns null for wrong jobId" (test 4) conflates two separate
null paths.**

`getInputSnapshot(jobId)` returns `null` for both "no such job" and "job exists
but no snapshot recorded." Test 4 only covers the former. Add a sub-case: job
exists in `pgbossier.record` (was captured by the trigger), but
`recordInputSnapshot` was never called. The reader must return `null`. This is
implied by the spec but not spelled out in the test plan — and the "attempt
omitted" SQL (`WHERE input_snapshot IS NOT NULL`) would return null for this case
too. The test is a simple extension of test 4.

**3. `RecordPatch` type comment at `src/record.ts` line 4-6 is stale.**

The comment says "the app-hook-owned columns the app-hook may write via
`recordPatch`." With Goal 4 shipping, there are now two writers for
`input_snapshot` and the type should reflect that `recordInputSnapshot` is the
preferred path. Update the comment.

---

## Defer to follow-up

**1. Warn-above-threshold heuristic for large snapshots.**

The spec rejects this (KISS, documented in Risk #1). Agreed. A runtime byte check
before `stringifyOrThrow` adds complexity with no clear threshold. Postgres TOAST
and operational README documentation are sufficient for v1. Revisit if descent-app
reports storage surprise.

**2. `CREATE INDEX CONCURRENTLY` recommendation for large existing installs.**

The spec acknowledges this in Risk #2 and the open questions. For a pre-release
library with no production installs yet, the plain `CREATE INDEX IF NOT EXISTS` is
the right default. Document the concurrent alternative in the README migration
note; don't change the install code. After the first npm publish, if installs are
observed at scale, revisit.

**3. Expression indexes on consumer-defined fields.**

Explicitly deferred in the spec's "Out of scope" section. Correct call.

---

## Positions on the five open questions

**1. Merge vs replace: REPLACE**

The spec is right. JSONB merge (`||`) is load-bearing for `terminal_detail` and
`dead-letter` because those columns accumulate keys from independent writers
(`recordTerminalDetail` adds classification; `recordDeadLetter` adds
`deadLetteredAs`). `input_snapshot` has a single writer for a single semantic
event: "what data did this job fetch at start time." There is no second key-adding
writer. A merge would add complexity with zero benefit, and it would also silently
preserve a stale snapshot if the worker calls `recordInputSnapshot` twice (e.g.,
retry scenario with different state). Replace-on-write is correct and matches the
field's semantics.

The only nuance: the existing `recordPatch` has `COALESCE($3, input_snapshot)`,
which is neither plain replace nor merge — it is "replace unless null, then
preserve." That needs fixing (see Must-land change #1) but the fix is to align
toward plain replace, not toward merge.

**2. Explicit-attempt reader: KEEP**

The dual-mode reader is not scope creep. The descent-app forensic use case is
specifically "what did attempt N fetch, vs what did attempt N+1 fetch?" — when
a job retries with different external state, you need per-attempt lookup. The
`attempt`-omitted fallback is the ergonomic default (most callers don't care
which attempt wrote the snapshot); the `attempt`-explicit mode is the forensic
path. Both are cheap to implement (two SQL branches, ~5 LOC each in
`src/input-snapshot.ts`). Dropping the explicit-attempt mode would force callers
to go through `getRetryHistory` and filter manually — more work, less discoverability.

One thing the spec should clarify: when `attempt` is provided and the row exists
but `input_snapshot IS NULL` for that attempt, should the reader return `null`
(current spec) or throw? `null` is correct — it matches "no snapshot recorded for
this attempt" and is consistent with the attempt-omitted null return.

**3. Migration: CREATE-INDEX (plain, not CONCURRENTLY)**

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. The current
`install()` wraps DDL in a transaction (that is the Goal 9 hardening). Running
`CONCURRENTLY` inside `install()`'s transaction would fail with a Postgres error.
So the spec is constrained to use plain `CREATE INDEX IF NOT EXISTS`. The right
answer is to document that large existing installs should run the index creation
separately before calling `install()` if they are worried about table lock
duration. The install code stays as-is.

If `install()` ever gets a "concurrent migration" mode that drops the transaction
wrapping, `CONCURRENTLY` becomes viable. That is a separate architectural decision.

**4. README pattern guidance: YES**

Document the dual-writer pattern explicitly. The table in spec Section D (Decision
tree for consumers) is the right shape. Without it, a descen-app developer will
discover `recordPatch` first (it is in the existing API surface), use it for
everything, and never reach `recordInputSnapshot`. The guidance "use
`recordInputSnapshot` unless you need to write multiple columns in one call" is the
only sentence needed in the README. One paragraph, not a chapter.

**5. `recordInputSnapshot(null)`: ACCEPT**

The spec is right to accept it. Rejecting null forces consumers to use
`recordPatch({input_snapshot: null})` for the "clear the snapshot" case, which is
exactly the footgun the spec is trying to avoid by providing a dedicated method.
If null is an error here, the API is broken: consumers have no clean way to clear
a snapshot through the preferred path. The only cost is that `getInputSnapshot`
returns `null` for both "never recorded" and "explicitly cleared," which is
acceptable and documented. This is not meaningfully different from how
`getProgress` behaves — except `setProgress` explicitly *rejects* null (because
"no progress" and "cleared progress" are not the same for the resumable-progress
use case). For input-snapshot, "I cleared it" and "I never set it" are genuinely
the same observable state from a reader's perspective. Accept null.

---

## Anything the spec missed entirely

**1. The `recordPatch` type narrows `input_snapshot` as `unknown`, but the spec
never addresses what happens when a caller passes a non-JSON-serializable value to
`recordPatch({input_snapshot: someFunction})`.**

`src/record.ts` line 28 does `patch.input_snapshot ?? null` and passes that
directly to the parameterized query. The pg driver will attempt to serialize it,
and a function or BigInt will either be stringified as something unexpected or
throw a driver-level error. Goal 4's `recordInputSnapshot` routes through
`stringifyOrThrow`, which catches this cleanly. `recordPatch` does not. Since the
spec preserves `recordPatch` as a valid writer for backfill use cases, it should
either (a) also call `stringifyOrThrow` on the `input_snapshot` field before
passing to the query, or (b) document that `recordPatch` does not validate
serializability and callers use it at their own risk. The spec should pick one.
This is more of a clarification than a new feature, but it affects the correctness
story for dual-writer scenarios.

**2. There is no mention of what `getInputSnapshot` returns when the row has
`input_snapshot = 'null'::jsonb` (the JSON null literal, as distinct from SQL
NULL).**

When `recordInputSnapshot(jobId, attempt, null)` writes JSON null (per Open
Question 5, which the spec accepts), the column value is `'null'::jsonb`, not SQL
NULL. The "attempt omitted" SQL is:

```sql
WHERE job_id = $1 AND input_snapshot IS NOT NULL
ORDER BY attempt DESC LIMIT 1
```

A row with `input_snapshot = 'null'::jsonb` satisfies `IS NOT NULL` (because the
SQL NULL check is on the column, not on the JSON content). So `getInputSnapshot`
with no attempt argument will return the JSON null literal row as "most recent
with a non-null snapshot" — and the caller receives `null as T`. This is arguably
correct (the consumer explicitly wrote null meaning "cleared"), but it is
surprising: the consumer wrote null to clear, and then a later call to
`getInputSnapshot()` without an attempt argument still "finds" that row.

If the intent of the null write is "clear," the correct reader behavior would be
to treat JSON null on the column the same as SQL NULL for the "most-recent
non-null" query. That requires the WHERE clause to be `AND input_snapshot IS NOT
NULL AND input_snapshot != 'null'::jsonb`. The spec should decide and document
this; right now the JSON-null-vs-SQL-null distinction is unaddressed.

**3. `getInputSnapshot` has no fail-open wrapper, unlike `setProgress` and
`recordDeadLetter`.**

All the write methods in this codebase are fail-open (exceptions swallowed to
console.warn). Readers are not — they throw on DB errors (`findById`, `listJobs`,
etc.). This is consistent with the existing read API pattern in `src/read.ts`.
The spec should make the fail-open-only-for-writers principle explicit for
`getInputSnapshot`, so the implementer does not accidentally add a try/catch that
swallows a DB error and returns null silently. This is a documentation gap, not a
code gap.

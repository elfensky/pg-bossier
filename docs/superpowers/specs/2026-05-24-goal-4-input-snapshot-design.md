# Goal 4 — Input-snapshot slot (design)

**Status:** v2 — post-adversarial-review.
**Tracking issue:** [#5](https://github.com/elfensky/pg-bossier/issues/5).
**Charter rubric:** Goal 4 of [issue #1](https://github.com/elfensky/pg-bossier/issues/1).
**Adversarial review:** [`docs/superpowers/debates/2026-05-24-goal-4-input-snapshot/`](../debates/2026-05-24-goal-4-input-snapshot/) — four reviewers (Codex, Gemini, Sonnet, Opus), two rounds. Unanimous SHIP-WITH-NAMED-CHANGES; v2 incorporates the 10 must-lands and 3 strong should-lands from the synthesis.

## What ships

Three additions on top of the existing Goal 1 storage substrate plus one pre-existing bug fix:

1. **`bossier.recordInputSnapshot(jobId, attempt, snapshot)`** — sibling writer method, **explicit attempt required**, **rejects `null`**, rejects non-JSON-serializable values, fail-open on DB errors. Same shape pattern as Goal 2's `recordTerminalDetail` and Goal 6's `setProgress` — except `attempt` is required (asymmetric with `setProgress` by deliberate design; see Decision 2).
2. **`bossier.getInputSnapshot<T>(jobId, attempt?)`** — typed reader. UUID-guarded short-circuit to `null` for malformed `jobId` (matches `setProgress` pattern). Returns `T | null` when `attempt` provided; returns `{snapshot: T, attempt: number} | null` (mirroring `ProgressResult`) when `attempt` omitted. Exports new type `InputSnapshotResult<T>` from `src/index.ts`.
3. **GIN index on `input_snapshot`** — consistency with the three other JSONB columns (`data`, `output`, `terminal_detail`) which all carry GIN indexes. Added to `src/sql.ts` install path. `CREATE INDEX IF NOT EXISTS`. Existing installs pick it up transparently.
4. **Prep commit fix:** `src/record.ts` `recordPatch` SQL changes from `COALESCE($3, input_snapshot)` to a conditional SET. This is a pre-existing bug (`recordPatch({input_snapshot: null})` is a silent no-op today instead of clearing). **Ships as a separate prep commit on develop BEFORE the Goal 4 PR opens**, per the adversarial review's recommendation (Sonnet R2; unrebutted).

No new schema column. The existing `recordPatch.input_snapshot` field stays — Goal 2's `terminal_detail` narrowing precedent doesn't apply here (no validation advantage). Both writers continue to work; last-writer-wins; README documents `recordInputSnapshot` as the preferred path.

## Why

Goal 4 from issue #1: optionally record what data a job worked on. Jobs that fetch external state (e.g., descent-app's Space-Track integration fetching satellite catalog records) want to record "I read these N rows at time T from external system X" so months later "what did this job actually process?" can be answered. The storage slot exists; this goal ships the convenience API.

Without a dedicated method, consumers use `recordPatch({input_snapshot})` — which works but pays the cost of the broader `recordPatch` shape (object argument, multi-field signature). A dedicated writer makes intent explicit and uses the same single-purpose pattern Goals 2/3/6 established. A typed reader removes the JSONB-as-`unknown` friction that consumers otherwise hit when reading from `findById`.

The GIN index decision is a consistency call — the other three JSONB columns are indexed; leaving `input_snapshot` unindexed is asymmetry rooted in the substrate's "we hadn't decided yet" state, not a deliberate choice.

## Decisions locked (post-debate)

### 1. Population API — sibling method, not pg-boss-method overload

**Way B picked over Way A.** `recordInputSnapshot` is a new sibling method on the `bossier` client. Same reasoning as Goals 2/3/6:

- Zero coupling to `boss.send`'s signature.
- The "worker fetches external state" use case is structurally job-start-time, not job-create-time.
- Method shadowing breaks the Principle of Least Astonishment.
- Mirrors Goal 2's `recordTerminalDetail`, Goal 3's `recordDeadLetter`, Goal 6's `setProgress` — consistent surface across the four write extensions.

### 2. Explicit `attempt` in writer (asymmetric with `setProgress` by design)

**4-of-4 in R2.** `recordInputSnapshot(jobId, attempt, snapshot)` requires `attempt`. No server-resolve.

Reasoning: input snapshots are "this exact attempt observed this exact input." Server-resolving `max(attempt)` (matching `setProgress`'s pattern) can misattribute the snapshot to a newer attempt if the worker's call lands AFTER pg-boss's retry DELETE+INSERT fires. The misattribution is a silent forensic error — wrong data, no exception.

`setProgress` accepts that race because progress is "current state" semantics — misattributing the latest progress value to the next attempt is mostly cosmetic. Input snapshots can't accept it — misattribution destroys the forensic value of the whole feature.

Workers receive `job.retryCount` on the job object; the cost of passing it is one field access. Provenance > ergonomics here.

### 3. Reject `null` in writer

**4-of-4 in R2.** `recordInputSnapshot(jobId, attempt, null)` throws with `pg-bossier: input_snapshot validation: snapshot must not be null`. Sonnet's R1 ACCEPT position conceded in R2 after Opus exposed the reader bug:

If `null` were accepted, the column would contain `'null'::jsonb` (JSON null literal), which satisfies SQL `IS NOT NULL`. The "most-recent non-null" reader would return that row and the caller would receive `null as T` — indistinguishable from "never recorded." Fixing the reader to defend (`AND jsonb_typeof(input_snapshot) != 'null'` in both branches) adds complexity in two SQL paths and a documented behavior. Rejecting at the writer keeps the SQL clean.

If a future use case wants explicit clearing, a dedicated `clearInputSnapshot(jobId, attempt)` ships as a follow-up. Out of scope for v1.

### 4. Keep `recordPatch.input_snapshot` (no narrowing)

**4-of-4 in R2.** Gemini's R1 narrow-it-like-Goal-2 position conceded in R2. The Goal 2 narrowing precedent doesn't apply: `terminal_detail` was removed from `recordPatch` because its dedicated writer (`recordTerminalDetail`) has stronger validation (`class` mandate, state-bound SQL). `recordInputSnapshot` has no validation advantage over `recordPatch.input_snapshot`. Keep both; document `recordInputSnapshot` as preferred; `recordPatch` is the low-level escape hatch for backfill and multi-column writes.

### 5. Reader return shape — dual mode mirrors `getProgress`

**4-of-4 in R2 (Gemini concession + Opus refinement).**

- When `attempt` is provided: returns `T | null`. Caller knows the attempt.
- When `attempt` is omitted: returns `{snapshot: T, attempt: number} | null` (mirror `ProgressResult` from `src/progress.ts`). The "which attempt this came from" is forensically valuable.

New exported type `InputSnapshotResult<T>` in `src/index.ts`.

### 6. Pre-existing `recordPatch` COALESCE bug — fix as separate prep commit

**3-of-4 GOAL-4-PR, 1-of-4 (Sonnet R2) SEPARATE-PREP. Synthesis recommendation: SEPARATE-PREP.**

`src/record.ts:28` currently has `SET input_snapshot = COALESCE($3, input_snapshot)`. This silently treats `recordPatch({input_snapshot: null})` as "preserve existing" rather than "clear" — false against the spec's replace-on-write claim. The fix is small (change to conditional SET that skips when `undefined`).

Sonnet's R2 reasoning: this is a pre-existing bug, not a Goal 4 feature. Mixing it into the Goal 4 PR obscures what Goal 4 changed and makes both PRs harder to review and revert independently. The fix ships as a self-contained commit on develop BEFORE the Goal 4 worktree is created.

The Goal 4 implementation plan codifies this: the COALESCE prep commit is Task 0 of Goal 4, but it lands on develop directly, not on the Goal 4 feature branch.

### 7. GIN index migration — `CREATE INDEX IF NOT EXISTS`

**4-of-4 — Plain CREATE INDEX, not CONCURRENTLY.** Goal 9's transactional install precludes CONCURRENTLY (which can't run inside a transaction block). For fresh installs and small-to-medium existing installs, `CREATE INDEX IF NOT EXISTS` is correct. Large existing installs should pre-create the index with `CONCURRENTLY` manually before calling `install()`. README documents this.

## Design

### Section A — The writer

**Signature:**

```ts
client.recordInputSnapshot(
  jobId: string,
  attempt: number,
  snapshot: unknown,
): Promise<void>;
```

**Validation rules:**
- `snapshot === undefined` → throw `pg-bossier: input_snapshot validation: snapshot must not be undefined`.
- `snapshot === null` → throw `pg-bossier: input_snapshot validation: snapshot must not be null`.
- `snapshot` not JSON-serializable (functions, symbols at top level, BigInt, circular references) → throw via the shared `stringifyOrThrow` utility from `src/json.ts`.

**Behavior:**
- Runs an UPDATE: `SET input_snapshot = $3::jsonb WHERE job_id = $1 AND attempt = $2`.
- **Silent no-op** when no matching row exists. Logged at WARNING with `reason: not_found`.
- **Fail-open** on any DB error — logged with `reason: db_error`, no throw.
- **Replace-on-write.** A second call with a different `snapshot` overwrites the first.
- **Non-finite numbers** (`NaN`, `Infinity`) inside snapshots → JSON `null` via `JSON.stringify` (standard behavior). Documented in JSDoc, mirroring `src/progress.ts:25-28`.

**SQL:**

```sql
UPDATE pgbossier.record
   SET input_snapshot = $3::jsonb
 WHERE job_id = $1 AND attempt = $2
```

Where `$3` is `stringifyOrThrow(snapshot, 'input_snapshot')`.

### Section B — The reader

**Signature:**

```ts
client.getInputSnapshot<T = unknown>(
  jobId: string,
  attempt?: number,
): Promise<T | InputSnapshotResult<T> | null>;
```

(TypeScript actually narrows: signature is two overloads — `getInputSnapshot<T>(jobId, attempt: number): Promise<T | null>` and `getInputSnapshot<T>(jobId): Promise<InputSnapshotResult<T> | null>`. Implementation uses one runtime function dispatched on `attempt !== undefined`.)

**Exported type:**

```ts
export interface InputSnapshotResult<T = unknown> {
  snapshot: T;
  attempt: number;
}
```

**Behavior:**
- **UUID guard.** Malformed `jobId` short-circuits to `null` without a query (match `src/progress.ts:78`).
- If `attempt` is provided: queries that specific row, returns its `input_snapshot` (or `null`).
- If `attempt` is omitted: queries the most-recent attempt with a non-null snapshot, returns `{snapshot, attempt}`.
- Returns `null` for unknown `jobId`, no matching attempt, or no recorded snapshot.

**SQL when `attempt` is provided:**

```sql
SELECT input_snapshot AS snapshot
  FROM pgbossier.record
 WHERE job_id = $1 AND attempt = $2
 LIMIT 1
```

**SQL when `attempt` is omitted:**

```sql
SELECT input_snapshot AS snapshot, attempt
  FROM pgbossier.record
 WHERE job_id = $1 AND input_snapshot IS NOT NULL
 ORDER BY attempt DESC
 LIMIT 1
```

The `IS NOT NULL` clause is safe because the writer rejects `null` (Decision 3). No `jsonb_typeof` defense needed in v1. **Manually-inserted JSON null via direct SQL would bypass this** — documented as out-of-scope (consumers writing direct SQL are responsible for their own data integrity).

### Section C — GIN index addition

`src/sql.ts` `recordIndexesSql` adds one line:

```ts
`CREATE INDEX IF NOT EXISTS record_input_snapshot_gin ON ${t} USING gin (input_snapshot);`,
```

`CREATE INDEX IF NOT EXISTS` makes the install idempotent and additive on existing installs. README notes that large existing installs should pre-create with `CONCURRENTLY` before calling `install()`.

The COMPATIBILITY.md does not change: this is a pg-bossier-internal schema change, not a pg-boss surface dependency.

### Section D — Composition with `recordPatch`

Both writers continue to work. Consumers pick by use case:

| Use case | Recommended writer |
|---|---|
| Worker recording what it fetched at job-start (normal case) | `recordInputSnapshot` |
| Backfill from external bookkeeping | `recordPatch({input_snapshot})` |
| Multiple column writes in one SQL UPDATE (e.g., `recordPatch({input_snapshot, ...})`) | `recordPatch` |

`recordPatch.input_snapshot` is routed through the same `stringifyOrThrow` serialization path as `recordInputSnapshot` (per Codex R2's catch — currently it isn't; the prep commit also fixes this). Both writers have identical acceptance/error behavior.

Last-writer-wins for concurrent or sequential writes from both APIs. Tested explicitly (test 8 below).

### Section E — pg-boss compatibility tier check

**Zero new pg-boss surfaces touched.** Goal 4 only writes to and reads from `pgbossier.record.input_snapshot`. No new pg-boss API methods called. No new pg-boss columns read. No new event subscriptions. The capture trigger is unchanged.

`COMPATIBILITY.md` does not need a new entry.

## Out of scope (v1) — explicitly deferred

1. **`clearInputSnapshot(jobId, attempt)`** — if real demand for explicit clearing surfaces.
2. **Auto-capture of `job.data` as a default snapshot.** Explicit non-goal in issue #1.
3. **Snapshot schema validation.** Consumer-defined shape.
4. **Compression of large snapshots.** Postgres TOAST handles it.
5. **Per-snapshot retention policy.** Consumer-owned across the whole table.
6. **Batch reader `getInputSnapshots(jobIds[])`** — `findById` already provides a slower path.
7. **`Job<TInput, TOutput>` generic** — issue #13.
8. **Warn-above-threshold size heuristic** — 4-of-4 agreed unbounded + docs is the right v1 call.

## Testing

New file `test/input-snapshot.test.ts` (or extend `test/recordPatch.test.ts`):

1. **Happy round-trip with explicit attempt.** `recordInputSnapshot(jobId, 0, {records: ['a', 'b']})` then `getInputSnapshot(jobId, 0)` returns `{records: ['a', 'b']}`.
2. **Happy round-trip without attempt.** Same write; `getInputSnapshot(jobId)` returns `{snapshot: {records: ['a', 'b']}, attempt: 0}`.
3. **Reader explicit-attempt vs most-recent.** Write to attempt 0 only. `getInputSnapshot(jobId, 0)` returns the value; `getInputSnapshot(jobId)` returns `{snapshot, attempt: 0}`. Write again to attempt 1. `getInputSnapshot(jobId)` returns attempt 1's wrapped result.
4. **Reader UUID guard.** `getInputSnapshot('not-a-uuid')` returns `null` without DB hit (assert via SQL count or query log if possible).
5. **Reader returns null for unknown jobId.** Resolves to `null` without throwing.
6. **Writer rejects undefined.** Throws with prefixed message.
7. **Writer rejects null.** Throws with prefixed message.
8. **Writer rejects non-JSON values.** Function value → throws. BigInt → throws. Circular reference → throws.
9. **Primitive snapshots.** `recordInputSnapshot(jobId, 0, 42)` → `getInputSnapshot(jobId, 0)` returns `42`. Same for strings, booleans, arrays.
10. **Non-finite numbers behavior.** `recordInputSnapshot(jobId, 0, {x: NaN})` writes (JSON.stringify produces `{"x":null}`); reader returns `{x: null}`. Documents the standard behavior.
11. **Silent no-op on wrong (jobId, attempt).** Resolves without throwing. Warning logged.
12. **Retry preservation across DELETE+INSERT.** Worker fails attempt 0 (with snapshot recorded), pg-boss DELETE+INSERTs attempt 1 with a new snapshot. Both rows in `pgbossier.record` retain their snapshots. `getRetryHistory(jobId)` returns both rows with the respective snapshots.
13. **GIN index installed.** Direct catalog check returns the index row.
14. **GIN index used.** EXPLAIN ANALYZE with `SET LOCAL enable_seqscan = off` confirms a `@>` containment query uses the GIN index.
15. **Compile-time generic narrowing.** `const r = await client.getInputSnapshot<{records: string[]}>(jobId)` narrows `r` to `InputSnapshotResult<{records: string[]}> | null`.
16. **Dual-writer collision (both orders).** Call `recordPatch({input_snapshot: X})` then `recordInputSnapshot(jobId, 0, Y)` — verify `getInputSnapshot` returns `Y`. Reverse the order — verify the second writer wins.
17. **Capture trigger preservation.** Mirror Goal 2's test. Assert the trigger's `ON CONFLICT DO UPDATE` SET list excludes `input_snapshot`. Locks the structural guarantee.
18. **`recordPatch({input_snapshot: null})` clears the column (after the prep fix).** Pre-prep this is a no-op; post-prep it's a clear. Test asserts the post-prep behavior.

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Consumer writes a 10MB snapshot accidentally; storage blows up. | Low | Medium | README documents the cost. Consumer manages policy. (4-of-4 agreed against threshold heuristics.) |
| 2 | GIN index migration on large existing tables is slow. | Medium | Low (one-time, recoverable) | README documents pre-creating with `CONCURRENTLY` manually. |
| 3 | Generic surface `<T>` couples Goal 4 to not-yet-finalized #13 design. | Low | Low | The generic is forward-compatible with any #13 outcome. |
| 4 | Consumer calls `recordInputSnapshot` after pg-boss's DELETE+INSERT retry. | Medium | Low (semantically correct — writes against the row identified by `(jobId, attempt)`) | Same semantic as Goal 2/3. Documented. |
| 5 | `recordPatch` and `recordInputSnapshot` race on same row. | Low | Low (last-writer-wins; both write same column) | Documented; test 16 locks the behavior. |
| 6 | Consumer calls `recordInputSnapshot` at job-FINISH time (capturing output as "input"). | Medium | High (Goal 4's audit value disappears) | README explicitly warns: "Call at job-START; for outputs, use `boss.complete(jobId, output)`." |

## Implementation sketch

Files touched:

- **PREP COMMIT (separate, on develop before Goal 4 PR):**
  - `src/record.ts` — change `COALESCE($3, input_snapshot)` to a conditional SET. Route through `stringifyOrThrow` for serialization consistency with `recordInputSnapshot`.
  - `test/recordPatch.test.ts` (or wherever) — add test asserting `recordPatch({input_snapshot: null})` clears.
  
- **GOAL 4 PR (feature branch):**
  - `src/input-snapshot.ts` — **new file**, exports `recordInputSnapshot` and `getInputSnapshot`. ~50 LOC.
  - `src/sql.ts` — add the new GIN index line in `recordIndexesSql`.
  - `src/client.ts` — add the two methods to `BossierMethods` + the runtime methods object.
  - `src/index.ts` — re-export `InputSnapshotResult<T>` type.
  - `test/input-snapshot.test.ts` — **new file**, tests 1-18 above.
  - `test/install.test.ts` — extend to check the new index exists.
  - `README.md` — new "Recording input snapshots" section. Document `_originalJobId`-style consumer contract pattern, the "call at job-START" warning, the `recordPatch` vs `recordInputSnapshot` decision guidance, and the `CREATE INDEX CONCURRENTLY` migration note for large installs.
  - `CHANGELOG.md` — `[Unreleased]` entry covering both the prep fix AND Goal 4 features.
  - `CLAUDE.md` — project status paragraph + goal-status table sync.

## Success criteria

- `npm run lint && npm run build && npm test` passes locally and in CI.
- `recordInputSnapshot(jobId, attempt, {records: [...]})` writes the row; `getInputSnapshot<T>(jobId)` returns the typed wrapped result.
- `recordPatch({input_snapshot: null})` now actually clears (post-prep).
- A descent-app-style call (worker captures the Space-Track records it fetched) records into `pgbossier.record.input_snapshot` and is queryable via the new GIN index.
- `COMPATIBILITY.md` requires no edits (zero new pg-boss surfaces).
- Issue #5 closes on merge.

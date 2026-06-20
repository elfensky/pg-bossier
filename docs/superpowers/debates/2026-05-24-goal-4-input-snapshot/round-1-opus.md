# Round 1 — Opus review: Goal 4 input-snapshot spec

## Verdict

SHIP-WITH-NAMED-CHANGES

The architecture is straightforward (this is the cleanest of the four write extensions because nothing about it is novel — it's a copy-paste of Goal 6's setProgress shape with explicit attempt). Three small but real issues to flag before merge; everything else is fine.

---

## Must-land changes (blockers)

**1. Section A's "writes JSON null is equivalent to never recorded" is sketchy.**

The spec says `recordInputSnapshot(jobId, attempt, null)` writes JSON null and is "equivalent to never recorded" — and the reader's "most recent non-null" semantic ignores it. So calling `recordInputSnapshot(id, 0, {records:[...]})` followed by `recordInputSnapshot(id, 0, null)` produces a row where `input_snapshot IS NOT NULL` in SQL terms but `getInputSnapshot(id)` returns the (no-longer-existing) `{records:[...]}`.

Why this is wrong: the SQL has `WHERE input_snapshot IS NOT NULL` to find "most recent non-null." That clause is checking SQL NULL, not the JSON `null` literal. After `recordInputSnapshot(id, 0, null)`, the row's `input_snapshot` column contains the JSONB value `null`, which is NOT SQL NULL — so the reader matches it and returns the JSON null. The "equivalent to never recorded" claim is false.

Fix: either (a) reject `null` at the writer (open question 5 — pick REJECT), or (b) document the distinction precisely. The spec currently has both behaviors documented inconsistently across sections.

I'd pick REJECT. It's cleaner. Consumers who want to clear a snapshot have `recordPatch({input_snapshot: null})` explicitly, which goes through the SQL `COALESCE($3, input_snapshot)` (which preserves on null, doesn't clear) — actually that's also buggy. The cleanest semantic is: `recordInputSnapshot` only sets, never clears; clearing is `recordPatch` territory.

**2. Section B's "most-recent attempt with a non-null snapshot" SQL has a subtle bug.**

```sql
SELECT input_snapshot AS snapshot
  FROM pgbossier.record
 WHERE job_id = $1 AND input_snapshot IS NOT NULL
 ORDER BY attempt DESC
 LIMIT 1
```

This is correct ONLY if "non-null" means SQL NULL. If JSON null is written by `recordInputSnapshot(null)` (per blocker 1), this returns the JSON null value, which the consumer probably wants to treat as "no snapshot." Add `AND jsonb_typeof(input_snapshot) != 'null'` to defend against the JSON-null-as-explicit-clear case.

Or — fix blocker 1, which makes this moot.

**3. Test 9 (retry preservation) needs the snapshot path explicitly exercised.**

The spec mentions: "Worker fails attempt 0 (with snapshot recorded), pg-boss DELETE+INSERTs attempt 1 with a new snapshot. Both rows in pgbossier.record retain their snapshots."

This test depends on the capture trigger NOT touching `input_snapshot` on `ON CONFLICT DO UPDATE`, exactly like Goal 2's `terminal_detail` preservation. **The trigger MUST exclude `input_snapshot` from its SET list.** Verify by reading `src/sql.ts` — Goal 2 added a CI test that explicitly checks this property for `terminal_detail`. Goal 4 should add the same test for `input_snapshot`. The structural guarantee is what makes single-writer safe across trigger fires; it shouldn't be implied.

---

## Should-land in v1 (not blockers, but cheap)

**4. `recordPatch.input_snapshot` and `recordInputSnapshot` race semantics.**

Decision 5 says both writers continue to work; last-writer-wins. But the spec doesn't have a test for it. One test like Goal 3's "concurrent writes" is enough — `await Promise.all([recordInputSnapshot(...), recordPatch({input_snapshot: ...})])` — verify whichever lands last is preserved. Locks the documented semantic.

**5. The `recordPatch({input_snapshot})` COALESCE pattern is a footgun.**

Looking at `src/record.ts`:
```ts
input_snapshot = COALESCE($3, input_snapshot)
```

This means `recordPatch({input_snapshot: null})` does NOT clear the column — it preserves the existing value (because `COALESCE(null, existing) = existing`). To explicitly clear via `recordPatch`, the consumer would need... actually they can't, with this pattern. The `null` is treated as "not patching this field."

That's existing behavior, not Goal 4's problem to fix, but it means: **`recordPatch` cannot clear `input_snapshot`** and **`recordInputSnapshot(null)` per the spec writes JSON null which is not the same as SQL NULL**. Neither writer can produce "input_snapshot IS NULL" once it's been set to non-null. This is a real gap in the model the spec doesn't surface.

If we want a "clear" path, add it explicitly: `recordInputSnapshot.clear(jobId, attempt)` or document the gap loudly. My recommendation: leave it as a known gap; document in README that snapshots are write-once-non-null per attempt; consumers who need to clear can `UPDATE pgbossier.record SET input_snapshot = NULL ...` directly (they're already managing their own retention policy per the spec's out-of-scope item #5).

**6. The GIN index's contribution to write-amplification on large snapshots.**

GIN indexes have higher write costs than B-tree (they decompose JSONB into element-level entries). For a 10MB snapshot, the GIN index entries can dominate the write. The spec notes the index storage cost (~50% extra) but doesn't note the write-amplification cost. For the descent-app use case (worker captures ~10K Space-Track records per job), this matters.

Cheap mitigation: document the trade-off in the README's GIN section. The actual workaround for consumers with large snapshots is the same `DROP INDEX` escape hatch the spec already mentions.

---

## Defer to follow-up

1. **Compression of large snapshots.** Already deferred. TOAST handles it transparently.
2. **`Job<TInput, TOutput>` generic surface.** Issue #13. The single `<T>` on `getInputSnapshot` is forward-compatible.
3. **Per-snapshot retention policy.** Out of scope.
4. **Expression indexes on common consumer-defined fields.** Consumer-owned.

---

## Positions on the five open questions

**1. Merge vs replace: REPLACE.**

The spec is right. Input snapshots are captured at a single point in time (job-start, what-the-worker-saw); they don't have additive sub-fields that need progressive enrichment. Merge would create ambiguity: "if I call twice with different shapes, which fields are valid?" The replace semantic answers: "the most recent capture is the canonical one." Matches the actual use case.

Goal 3's merge was specifically to enable a SECOND writer (`recordDeadLetter`) to add a separate key without trampling. There's no "second writer" for input_snapshot. Replace is correct.

**2. Explicit-attempt reader: KEEP.**

`getProgress(jobId)` doesn't take attempt because progress is a single-most-recent-value semantic. For input snapshots, per-attempt is meaningful — descent-app may want "what did attempt 0 fetch from Space-Track" vs "what did attempt 1 fetch (after backoff)" as separate forensic queries. The optional `attempt` parameter is the right shape.

The cost of keeping it is two SQL paths in the reader (with-attempt vs without-attempt) — both trivial.

**3. Migration: CREATE-INDEX (not CONCURRENTLY).**

For fresh installs and small-to-medium existing installs (descent-app's expected scale), plain `CREATE INDEX IF NOT EXISTS` is fine. The brief table lock is acceptable.

For consumers with truly large `pgbossier.record` tables (millions of rows), `CONCURRENTLY` is friendlier. But it has constraints: can't be inside a transaction, more error-prone, and the spec's `install()` is currently transactional (per Goal 9). Switching to CONCURRENTLY would require either dropping the transaction (regression) or executing the index outside it (added complexity).

KISS: ship plain `CREATE INDEX IF NOT EXISTS`. Document that large installs can pre-create with `CONCURRENTLY` manually before calling `install()`. The IF NOT EXISTS makes the install path skip the re-create.

**4. README pattern guidance: YES.**

The README should explicitly say: "Use `recordInputSnapshot` for single-purpose worker-side recording. Use `recordPatch` when batching multiple field writes (e.g., `{input_snapshot, terminal_detail}` in one round-trip — though terminal_detail now goes through `recordTerminalDetail`, this is mostly a future-proofing path)."

Three lines of guidance. Closes the ambiguity for consumers reading the API surface.

**5. `recordInputSnapshot(null)`: REJECT.**

Per blocker 1. Cleaner semantic. Consumers wanting to explicitly clear can use a direct SQL UPDATE (or we add a dedicated `clear` method later if real demand surfaces). Keeping the writer single-purpose (set, never clear) matches the worker-at-job-start use case.

---

## Anything the spec missed entirely

**1. The shared `stringifyOrThrow` utility's behavior on `null` and primitives.**

`stringifyOrThrow(null, 'input_snapshot')` returns `'null'` (the string "null"). `stringifyOrThrow(42, 'input_snapshot')` returns `'42'`. `stringifyOrThrow('hello', 'input_snapshot')` returns `'"hello"'`. All valid JSONB.

The spec implies `recordInputSnapshot` accepts primitives (numbers, booleans, strings). It does — and they round-trip as JSONB. But the test plan doesn't exercise this. A one-line test (`recordInputSnapshot(id, 0, 42)` → `getInputSnapshot(id) === 42`) verifies the primitive path works.

**2. The optional `attempt` parameter creates an overload issue.**

```ts
client.getInputSnapshot<T = unknown>(
  jobId: string,
  attempt?: number,
): Promise<T | null>;
```

TypeScript accepts this signature, but when consumers call `getInputSnapshot<MyType>(jobId)`, the second positional slot is undefined. If they ever accidentally pass `getInputSnapshot(jobId, MyType)` (mistaking the generic for a positional), TypeScript catches it. Good.

But: the SQL paths are different for the two modes (one queries by `(jobId, attempt)`, the other queries `ORDER BY attempt DESC`). The runtime should dispatch on `attempt === undefined`. Verify in the implementation that the optional-parameter check isn't `typeof attempt === 'number'` (which would treat `attempt = NaN` as "provided"). Use `attempt !== undefined` explicitly.

**3. The spec mentions `recordInputSnapshot` is "called by the worker at job-start time after it fetches whatever external state it wants to record."**

This is just a description, not a contract. But — is there a real risk that workers call `recordInputSnapshot` at job-FINISH time (after computing results) instead, capturing the OUTPUT they produced as the "input snapshot"? That would semantically wrong but the API can't prevent it. The README should explicitly say: "Call at job-START; for outputs, use pg-boss's native `boss.complete(jobId, output)`." Otherwise consumers will get the timing wrong and Goal 4's audit value disappears.

**4. Test 11 (GIN index used for containment query) requires forcing `enable_seqscan = off` per Goal 3's experience.**

Sonnet's Goal 3 Task 4 implementation had to do this. The spec should note that test 11 will need the same treatment. Save the implementer one debug cycle.

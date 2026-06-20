## Verdict
SHIP-WITH-NAMED-CHANGES

## Must-land changes (blockers)
1. **Server-resolve `attempt` in writer:** The `recordInputSnapshot(jobId, attempt, snapshot)` signature should match `setProgress` ergonomics by making `attempt` optional. In most worker contexts, only `job.id` is readily available. Requiring the attempt number forces consumers to perform an extra query or "guess" the current attempt, which is unnecessary friction. The SQL should default to `max(attempt)` when `attempt` is omitted.
2. **Narrow `recordPatch`:** Remove `input_snapshot` from the `RecordPatch` interface in `src/record.ts`. Goal 2 established a clean precedent by removing `terminal_detail` once a dedicated writer existed. Maintaining `input_snapshot` in `recordPatch` creates API redundancy, bypasses the specialized validation/logging logic in `recordInputSnapshot`, and violates the "dedicated writer for managed columns" pattern.
3. **Reject `null` in writer:** Change validation to reject `null` (matching `setProgress`). If the writer accepts `null` (storing it as JSONB or SQL NULL), the reader's `IS NOT NULL` logic in `getInputSnapshot` (omitted attempt mode) will skip that attempt and potentially return a stale snapshot from a previous attempt. To "clear" a snapshot, consumers should use a backfill tool or explicit `recordPatch` (if we kept it, which we shouldn't).

## Should-land in v1 (not blockers, but cheap)
1. **Consistency in logging:** Ensure the `console.warn` message in `recordInputSnapshot` matches the "is pg-bossier installed?" hint used in `setProgress` and `recordTerminalDetail` for better troubleshooting.
2. **Reader Return Shape:** Consider having `getInputSnapshot` (when attempt is omitted) return an object like `{ snapshot: T; attempt: number }` (matching `ProgressResult`). This allows forensic tools to know which attempt the "most recent" snapshot actually belongs to.
3. **Test for attempt-resolution race:** Add a test case where `recordInputSnapshot` is called with an omitted attempt while a newer attempt exists (simulating a retry race), confirming it hits the `max(attempt)` row.

## Defer to follow-up
1. **Batch reader:** A `getInputSnapshots(jobIds[])` for multi-job dashboards, though `findById` already provides raw access for this.

## Positions on the five open questions
1. Merge vs replace: **REPLACE** — Input snapshots are semantically "point-in-time state captures." Merging implies additive data (like progress), which doesn't fit the "this is what I saw at the start" use case.
2. Explicit-attempt reader: **KEEP** — The dual mode is valuable. "Most-recent" is best for general status views, but explicit-attempt is critical for forensic debugging of specific historical failures.
3. Migration: **CREATE-INDEX** — `IF NOT EXISTS` is sufficient for the default `install()` path. Users with millions of rows should be running migrations out-of-band with `CONCURRENTLY` anyway.
4. README pattern guidance: **YES** — Clear guidance that `recordInputSnapshot` is the managed/preferred path is essential for a clean developer experience.
5. `recordInputSnapshot(null)`: **REJECT** — See Must-land #3. Matches `setProgress` and avoids "ghost data" reader ambiguity.

## Anything the spec missed entirely
- **JSONB literal 'null' vs SQL NULL:** The spec should clarify that the library treats JS `null` as a rejection (Must-land #3) to ensure the `IS NOT NULL` SQL check is robust.
- **Exported Result Type:** If the reader return shape is changed (Should-land #2), a `InputSnapshotResult<T>` type should be exported in `src/index.ts`.
- **`recordInputSnapshot` SQL Race Condition:** When using `max(attempt)` for the update, there is a theoretical window for a race if a job is retried between the subquery and the update. This is an acceptable trade-off already accepted in `setProgress`.

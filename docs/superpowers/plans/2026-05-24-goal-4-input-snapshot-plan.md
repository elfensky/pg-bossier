# Goal 4 Input-Snapshot-Slot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pg-bossier Goal 4 — input-snapshot slot per the v2 spec. Adds `bossier.recordInputSnapshot(jobId, attempt, snapshot)` writer + `bossier.getInputSnapshot<T>(jobId, attempt?)` typed reader (with dual-mode return shape) + a GIN index on `input_snapshot`. Ships a separate prep commit fixing the pre-existing `recordPatch` COALESCE bug FIRST, directly on `develop`, before the Goal 4 worktree is created.

**Architecture:** A new module `src/input-snapshot.ts` exports the writer and reader. Writer takes explicit `(jobId, attempt, snapshot)`, validates input is non-null + JSON-serializable via the shared `stringifyOrThrow` utility, then runs `UPDATE pgbossier.record SET input_snapshot = $3::jsonb WHERE job_id = $1 AND attempt = $2`. Reader has dual SQL paths: explicit-attempt mode returns `T | null`; omitted-attempt mode returns `{snapshot: T, attempt: number} | null` (mirroring `ProgressResult`). UUID guard short-circuits malformed `jobId` to `null` before any query. `src/sql.ts` `recordIndexesSql` gains a fourth GIN index line for `input_snapshot`.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Node 18.3+, ESM, `pg`, vitest + `@testcontainers/postgresql`, pg-boss 12.18.2.

**Spec:** [`docs/superpowers/specs/2026-05-24-goal-4-input-snapshot-design.md`](../specs/2026-05-24-goal-4-input-snapshot-design.md) (v2)
**Adversarial review:** [`docs/superpowers/debates/2026-05-24-goal-4-input-snapshot/`](../debates/2026-05-24-goal-4-input-snapshot/) — synthesis at `99-synthesis.md`
**Charter:** [`CLAUDE.md`](../../../CLAUDE.md) — feature branches via `git worktree`; `--no-ff` merge into `develop`; CHANGELOG under `[Unreleased]`; lint + build + test must all pass before claiming done.

---

## File map (locked before tasks)

**Prep commit on develop (NOT in the Goal 4 worktree):**
- Modify: `src/record.ts` — change `SET input_snapshot = COALESCE($3, input_snapshot)` to a conditional SET that skips when `patch.input_snapshot === undefined` and clears when explicit `null`. Route through `stringifyOrThrow` for consistency with `recordInputSnapshot`.
- Modify: `test/recordPatch.test.ts` — add test asserting `recordPatch({input_snapshot: null})` clears the column; add test asserting omitted-field is a no-op.

**Goal 4 PR new files:**
- `src/input-snapshot.ts` — exports `recordInputSnapshot`, `getInputSnapshot`, and `InputSnapshotResult<T>` type. ~80 LOC.
- `test/input-snapshot.test.ts` — integration tests 1-18 from the spec.

**Goal 4 PR modified files:**
- `src/sql.ts` — add `record_input_snapshot_gin` line in `recordIndexesSql`.
- `src/client.ts` — add `recordInputSnapshot` and `getInputSnapshot` to `BossierMethods` + the runtime methods object; extend the proxy collision-check allow-list.
- `src/index.ts` — re-export `InputSnapshotResult<T>` type.
- `test/install.test.ts` — extend to verify the new GIN index exists after install.
- `test/capture.test.ts` (or similar) — extend with capture-trigger preservation test for `input_snapshot`.
- `test/client.test.ts` — smoke test verifying the new proxy methods work.
- `README.md` — new "Recording input snapshots" section with `_originalJobId`-style contract pattern, "call at job-START" warning, `recordPatch` vs `recordInputSnapshot` decision guidance, and the `CREATE INDEX CONCURRENTLY` migration note.
- `CHANGELOG.md` — `[Unreleased]` entry covering both the prep fix AND Goal 4 features.
- `CLAUDE.md` — project-status paragraph + goal-status table sync.

**Decomposition principle.** The prep commit lands on develop FIRST as a separate, independently-reviewable commit. Then the Goal 4 worktree is created off develop (which includes the prep). Goal 4 PR ships the new feature; it doesn't carry the COALESCE diff in its own delta. Within Goal 4: writer first (TDD), reader next (uses the writer's data), GIN index addition, proxy wiring, trigger preservation test, docs.

---

## Task 0 (PREP) — Fix `recordPatch` COALESCE bug, commit directly to develop

**Files:**
- Modify: `src/record.ts`
- Modify: `test/recordPatch.test.ts`

**Working directory:** main checkout `/Users/andrei/Developer/github/pg-bossier` (NOT a worktree)

**Goal:** Ship the pre-existing COALESCE bug fix as a self-contained commit on develop before the Goal 4 worktree is created. This is the SEPARATE-PREP scope per the adversarial review synthesis.

- [ ] **Step 1: Read the current `recordPatch` SQL.**

`src/record.ts:24-32` currently has:

```ts
await pool.query(
  `UPDATE ${schemas.pgbossier}.record SET
     input_snapshot = COALESCE($3, input_snapshot)
   WHERE job_id = $1 AND attempt = $2`,
  [jobId, attempt, patch.input_snapshot ?? null],
);
```

The bug: `recordPatch({input_snapshot: null})` becomes `[..., null]` → `COALESCE(null, existing) = existing` → no-op. Cannot clear.

- [ ] **Step 2: Change the SQL to a conditional path.**

Two options:

**Option A (recommended):** Two SQL paths, dispatched in JS on `patch.input_snapshot === undefined`:
- If `input_snapshot` is in the patch (including null): `SET input_snapshot = $3::jsonb` where `$3` is `stringifyOrThrow(patch.input_snapshot, 'input_snapshot')` (which throws on undefined; null gets through as JSON null).
- If `input_snapshot` is NOT in the patch (`'input_snapshot' in patch === false`): skip the column entirely (no UPDATE if it's the only field; or a different UPDATE if there were more fields — but `RecordPatch` has only this one field).

Since `RecordPatch` currently has ONLY `input_snapshot`, the simplest fix is:

```ts
export async function recordPatch(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  if (!('input_snapshot' in patch)) return; // no-op for empty patch
  const json = stringifyOrThrow(patch.input_snapshot, 'input_snapshot');
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record
        SET input_snapshot = $3::jsonb
      WHERE job_id = $1 AND attempt = $2`,
    [jobId, attempt, json],
  );
}
```

This routes through `stringifyOrThrow` (matching `recordInputSnapshot` and `setProgress`) so dual writers have identical acceptance/error behavior.

**Wait — `stringifyOrThrow(null)` returns `'null'` (the JSON null string), which becomes JSONB `null::jsonb` after `$3::jsonb` cast. That's the JSON null literal.** That's NOT what we want for "clear" semantics; we want SQL NULL.

**Refined approach:** dispatch on `patch.input_snapshot === null` explicitly:

```ts
export async function recordPatch(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  if (!('input_snapshot' in patch)) return;
  if (patch.input_snapshot === null) {
    // Explicit clear: set SQL NULL.
    await pool.query(
      `UPDATE ${schemas.pgbossier}.record
          SET input_snapshot = NULL
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, attempt],
    );
    return;
  }
  const json = stringifyOrThrow(patch.input_snapshot, 'input_snapshot');
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record
        SET input_snapshot = $3::jsonb
      WHERE job_id = $1 AND attempt = $2`,
    [jobId, attempt, json],
  );
}
```

This gives three behaviors:
- `recordPatch({})` (or any patch without `input_snapshot` key) → no-op.
- `recordPatch({input_snapshot: null})` → clears (SQL NULL).
- `recordPatch({input_snapshot: anyValue})` → writes via `stringifyOrThrow`.

This is the **target behavior** per the spec.

- [ ] **Step 3: Add tests to `test/recordPatch.test.ts`.**

```ts
test('recordPatch with explicit null clears the column', async () => {
  // ... setup: write a value first
  await recordPatch(pool, schemas, jobId, 0, { input_snapshot: { foo: 'bar' } });
  // ... verify written
  await recordPatch(pool, schemas, jobId, 0, { input_snapshot: null });
  const { rows } = await pool.query(
    `SELECT input_snapshot FROM ${schemas.pgbossier}.record WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  expect(rows[0].input_snapshot).toBeNull();  // SQL NULL, not JSON null
});

test('recordPatch with omitted field is a no-op', async () => {
  await recordPatch(pool, schemas, jobId, 0, { input_snapshot: { foo: 'bar' } });
  // ... verify written
  await recordPatch(pool, schemas, jobId, 0, {});  // omitted field
  const { rows } = await pool.query(
    `SELECT input_snapshot FROM ${schemas.pgbossier}.record WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  expect(rows[0].input_snapshot).toEqual({ foo: 'bar' });  // unchanged
});
```

Other existing tests should still pass (the writing-a-value path is unchanged from the perspective of legitimate calls).

- [ ] **Step 4: Run lint + build + test.**

```bash
npm run lint && npm run build && npm test
```

Expected: clean. Test count: +2 from the new tests.

- [ ] **Step 5: Commit on develop.**

```bash
git commit -m "fix(record): recordPatch input_snapshot null clears column, omitted is no-op"
```

Signed commit. NEVER `--no-gpg-sign` or `--no-verify`.

- [ ] **Step 6: Push develop and confirm CI green.**

```bash
git push origin develop
gh run watch <run-id> --exit-status
```

Once CI is green, proceed to Task 0a (worktree creation).

---

## Task 0a — Worktree + baseline (Goal 4 feature branch)

**Files:** `.worktrees/feature-goal-4-input-snapshot/`

- [ ] **Step 1: Create the worktree off `develop` (which now includes the prep commit).**

```bash
git worktree add .worktrees/feature-goal-4-input-snapshot \
  -b feature/goal-4-input-snapshot develop
```

- [ ] **Step 2: Install deps + verify baseline is green.**

```bash
cd .worktrees/feature-goal-4-input-snapshot
npm install
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` clean, all existing tests pass (~179 if the prep added two; verify the actual count).

---

## Task 1 — Create `src/input-snapshot.ts` with both writer and reader (TDD)

**Files:**
- New: `src/input-snapshot.ts`
- New: `test/input-snapshot.test.ts`

**Goal:** Both `recordInputSnapshot` and `getInputSnapshot` in one module. TDD-first.

- [ ] **Step 1: Write `test/input-snapshot.test.ts` with tests 1-12 from the spec.**

(Tests 13-18 land in later tasks; 13-14 in Task 2 [GIN index], 15-17 in Tasks 3-4, 18 was in the prep commit.)

The 12 tests for Task 1 cover writer + reader behavior independent of the proxy wiring or GIN index:

1. Happy round-trip with explicit attempt.
2. Happy round-trip without attempt (returns wrapped result).
3. Reader explicit-attempt vs most-recent.
4. Reader UUID guard.
5. Reader returns null for unknown jobId.
6. Writer rejects undefined.
7. Writer rejects null.
8. Writer rejects non-JSON values.
9. Primitive snapshots (number, string, boolean, array).
10. Non-finite numbers (NaN → JSON null behavior).
11. Silent no-op on wrong (jobId, attempt).
12. Retry preservation (DELETE+INSERT preserves both attempts' snapshots).

Tests use the existing `@testcontainers/postgresql` harness pattern (look at `test/dead-letter.test.ts` for a recent template — Goal 3 used the same shape).

Run: `npm test -- test/input-snapshot.test.ts`. Expected: all fail (module doesn't exist).

- [ ] **Step 2: Implement `src/input-snapshot.ts`.**

```ts
import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface InputSnapshotResult<T = unknown> {
  snapshot: T;
  attempt: number;
}

export async function recordInputSnapshot(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt: number,
  snapshot: unknown,
): Promise<void> {
  if (snapshot === undefined) {
    throw new Error(
      'pg-bossier: input_snapshot validation: snapshot must not be undefined',
    );
  }
  if (snapshot === null) {
    throw new Error(
      'pg-bossier: input_snapshot validation: snapshot must not be null',
    );
  }
  const json = stringifyOrThrow(snapshot, 'input_snapshot');
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schemas.pgbossier}.record
          SET input_snapshot = $3::jsonb
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, attempt, json],
    );
    if (rowCount === 0) {
      console.warn(
        `pgbossier: recordInputSnapshot no row for job ${jobId} attempt ${attempt} — reason: not_found`,
      );
    }
  } catch (err) {
    console.warn(`pgbossier: recordInputSnapshot failed: ${String(err)} reason: db_error`);
  }
}

// Two overloads, dispatching internally on attempt.
export async function getInputSnapshot<T = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number,
): Promise<T | null>;
export async function getInputSnapshot<T = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string,
): Promise<InputSnapshotResult<T> | null>;
export async function getInputSnapshot<T = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt?: number,
): Promise<T | InputSnapshotResult<T> | null> {
  if (!UUID_RE.test(jobId)) return null;
  if (attempt !== undefined) {
    const { rows } = await pool.query<{ snapshot: unknown }>(
      `SELECT input_snapshot AS snapshot
         FROM ${schemas.pgbossier}.record
        WHERE job_id = $1 AND attempt = $2
        LIMIT 1`,
      [jobId, attempt],
    );
    if (rows.length === 0 || rows[0]!.snapshot === null) return null;
    return rows[0]!.snapshot as T;
  }
  const { rows } = await pool.query<{ snapshot: unknown; attempt: number }>(
    `SELECT input_snapshot AS snapshot, attempt
       FROM ${schemas.pgbossier}.record
      WHERE job_id = $1 AND input_snapshot IS NOT NULL
      ORDER BY attempt DESC
      LIMIT 1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return { snapshot: row.snapshot as T, attempt: row.attempt };
}
```

Run: tests pass.

- [ ] **Step 3: Lint + build + full test suite.**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 4: Commit.**

```bash
git commit -m "feat(input-snapshot): add recordInputSnapshot + getInputSnapshot"
```

Signed. NEVER `--no-gpg-sign`.

---

## Task 2 — Add GIN index on `input_snapshot`

**Files:**
- Modify: `src/sql.ts`
- Modify: `test/install.test.ts`
- Modify: `test/input-snapshot.test.ts` (add tests 13-14)

**Goal:** Add the new GIN index to install + verify it's used.

- [ ] **Step 1: Modify `src/sql.ts`.**

In `recordIndexesSql`, add the fourth line:

```ts
`CREATE INDEX IF NOT EXISTS record_input_snapshot_gin ON ${t} USING gin (input_snapshot);`,
```

- [ ] **Step 2: Extend `test/install.test.ts`.**

The existing test that verifies index existence should be extended:

```ts
// Verify new GIN index is created
const { rows } = await pool.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'record'`,
  [schemas.pgbossier],
);
const names = rows.map(r => r.indexname);
expect(names).toContain('record_input_snapshot_gin');
```

- [ ] **Step 3: Add tests 13-14 to `test/input-snapshot.test.ts`.**

```ts
test('GIN index on input_snapshot is created', async () => {
  const { rows } = await h.pool.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'record' AND indexname = 'record_input_snapshot_gin'`,
    [SCHEMAS.pgbossier],
  );
  expect(rows.length).toBe(1);
});

test('GIN index is used for containment query', async () => {
  // Insert a few rows with snapshots
  // ...
  // EXPLAIN with enable_seqscan = off
  await h.pool.query('BEGIN');
  try {
    await h.pool.query('SET LOCAL enable_seqscan = off');
    const { rows } = await h.pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT job_id FROM ${SCHEMAS.pgbossier}.record
       WHERE input_snapshot @> $1::jsonb
       LIMIT 1`,
      [JSON.stringify({ kind: 'foo' })],
    );
    const plan = rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/record_input_snapshot_gin/i);
  } finally {
    await h.pool.query('ROLLBACK');
  }
});
```

- [ ] **Step 4: Lint + build + full test suite. Verify the test count went up by 2.**

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(sql): add GIN index on pgbossier.record.input_snapshot"
```

---

## Task 3 — Wire methods onto the client proxy

**Files:**
- Modify: `src/client.ts`
- Modify: `src/index.ts`
- Modify: `test/client.test.ts`
- Modify: `test/input-snapshot.test.ts` (add test 15 — generic narrowing fixture)

**Goal:** Make `client.recordInputSnapshot` and `client.getInputSnapshot` callable via the unified `bossier()` proxy.

- [ ] **Step 1: Add to `BossierMethods` + runtime methods object in `src/client.ts`.**

```ts
// BossierMethods (interface):
recordInputSnapshot(jobId: string, attempt: number, snapshot: unknown): Promise<void>;
getInputSnapshot<T = unknown>(jobId: string): Promise<InputSnapshotResult<T> | null>;
getInputSnapshot<T = unknown>(jobId: string, attempt: number): Promise<T | null>;

// Runtime methods:
recordInputSnapshot: (jobId, attempt, snapshot) => recordInputSnapshot(pool, s, jobId, attempt, snapshot),
getInputSnapshot: (jobId, attempt) => getInputSnapshot(pool, s, jobId, attempt as number),
```

Plus the import at top.

- [ ] **Step 2: Update `BOSSIER_METHOD_NAMES` (or equivalent) in `test/client.test.ts` collision check.**

Add `'recordInputSnapshot'` and `'getInputSnapshot'` to the allow-list.

- [ ] **Step 3: Re-export `InputSnapshotResult<T>` from `src/index.ts`.**

```ts
export type { InputSnapshotResult } from './input-snapshot.js';
```

- [ ] **Step 4: Add a smoke test to `test/client.test.ts`.**

```ts
test('client.recordInputSnapshot + getInputSnapshot via the proxy', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  // Send a job with retryLimit: 0, fetch + fail it (so a record row exists)
  // ...
  await client.recordInputSnapshot(jobId, 0, { records: ['a', 'b'] });
  const explicit = await client.getInputSnapshot<{records: string[]}>(jobId, 0);
  expect(explicit).toEqual({ records: ['a', 'b'] });
  const wrapped = await client.getInputSnapshot<{records: string[]}>(jobId);
  expect(wrapped).toEqual({ snapshot: { records: ['a', 'b'] }, attempt: 0 });
});
```

- [ ] **Step 5: Add compile-time generic narrowing fixture to `test/input-snapshot.test.ts`.**

```ts
function _narrowingFixture(client: ReturnType<typeof bossier>): void {
  void (async () => {
    const a = await client.getInputSnapshot<{x: number}>('00000000-0000-0000-0000-000000000000', 0);
    if (a) {
      const _x: number = a.x;  // narrows to { x: number }
      void _x;
    }
    const b = await client.getInputSnapshot<{x: number}>('00000000-0000-0000-0000-000000000000');
    if (b) {
      const _x: number = b.snapshot.x;  // narrows to InputSnapshotResult<{x: number}>
      const _att: number = b.attempt;
      void _x; void _att;
    }
  });
}
void _narrowingFixture;
```

- [ ] **Step 6: Lint + build + full test suite. Commit.**

```bash
git commit -m "feat(client): expose recordInputSnapshot + getInputSnapshot on the bossier proxy"
```

---

## Task 4 — Capture-trigger preservation regression test

**Files:**
- Modify: `test/capture.test.ts` (or equivalent — wherever Goal 2's trigger-preservation test lives)

**Goal:** Lock in the structural guarantee that the capture trigger's `ON CONFLICT DO UPDATE` SET list excludes `input_snapshot`. Mirrors Goal 2's similar test for `terminal_detail`.

- [ ] **Step 1: Add the runtime test.**

```ts
test('capture trigger preserves input_snapshot across subsequent fires', async () => {
  // Send a job, fail it (state=failed, attempt 0)
  // Call recordInputSnapshot to write a snapshot
  // Trigger another fire on the same row (e.g., no-op UPDATE SET state = state)
  // Assert input_snapshot is unchanged
});
```

- [ ] **Step 2: Add the static check (matches Goal 3 Task 7 pattern).**

```ts
test('capture trigger DO UPDATE SET clause does not list input_snapshot', async () => {
  const { rows } = await h.pool.query(
    `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = 'capture'`,
    [SCHEMAS.pgbossier],
  );
  const def = String(rows[0].def);
  const setBlockMatch = def.match(/DO UPDATE SET[\s\S]*?;/i);
  expect(setBlockMatch).toBeTruthy();
  expect(setBlockMatch![0]).not.toMatch(/input_snapshot/i);
});
```

- [ ] **Step 3: Lint + build + test green. Commit.**

```bash
git commit -m "test(capture): lock in input_snapshot preservation across trigger fires"
```

---

## Task 5 — Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

**Goal:** Surface-level documentation for the new methods + the migration note.

### README

Add new section "Recording input snapshots" after Goal 3's "Recording dead-letter lineage" section. Cover:

- Intro paragraph (why input snapshots exist).
- **"Call at job-START, not job-FINISH" warning** (per spec § Risk #6).
- Code example showing worker-side capture of external state (e.g., the descent-app Space-Track pattern).
- Reader code example showing both modes (explicit attempt + wrapped result).
- **`recordPatch` vs `recordInputSnapshot` decision guidance** (3 sentences).
- **Size note:** unbounded, document the storage cost trade-off.
- **CONCURRENTLY migration note** for large existing installs.
- "What does NOT change" subsection: GIN index is added on install/upgrade; existing data unaffected.

### CHANGELOG `[Unreleased]`

Under `### Added`:

```markdown
- **Goal 4 — Input-snapshot slot.** `client.recordInputSnapshot(jobId, attempt, snapshot)` writes opt-in worker-supplied snapshots to `pgbossier.record.input_snapshot`. `client.getInputSnapshot<T>(jobId, attempt?)` reads them with dual-mode return: `T | null` for explicit attempt, `{snapshot, attempt} | null` for most-recent. New GIN index `record_input_snapshot_gin` enables containment queries. New public type export: `InputSnapshotResult<T>`. Issue #5.
```

Under `### Changed`:

```markdown
- **`recordPatch` `input_snapshot` semantics fixed.** `recordPatch({input_snapshot: null})` now actually clears the column (SQL NULL); previously this was a silent no-op due to `COALESCE`. Omitted field is unchanged (no-op). Now routes through the same `stringifyOrThrow` serialization as `recordInputSnapshot` for consistency.
```

### CLAUDE.md

- Project-status paragraph: add Goal 4 after Goal 3 with matching phrasing.
- Goal-status table row:

```markdown
| ✅ Input-snapshot slot — `recordInputSnapshot(jobId, attempt, snapshot)` + `getInputSnapshot<T>(jobId, attempt?)`; GIN index on `input_snapshot`; pre-existing `recordPatch` COALESCE bug fixed in prep commit _(done — issue #5 closed; charter complete)_ | Goal 4 |
```

- [ ] **Lint + build + test green. Commit.**

```bash
git commit -m "docs: README Recording input snapshots section + CHANGELOG/CLAUDE.md sync"
```

---

## Task 6 — Final verification + merge

**Files:** branch `feature/goal-4-input-snapshot`

- [ ] **Step 1: Full local CI gate.**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 2: Push branch.**

```bash
git push -u origin feature/goal-4-input-snapshot
```

- [ ] **Step 3: Merge into develop.**

```bash
git checkout develop && git pull origin develop
git merge --no-ff feature/goal-4-input-snapshot
git push origin develop
```

- [ ] **Step 4: Wait for develop CI green.**

- [ ] **Step 5: Close issue #5.**

```bash
gh issue close 5 --comment "Delivered via merge commit <hash> on develop. ..."
```

- [ ] **Step 6: Clean up worktree.**

```bash
git worktree remove .worktrees/feature-goal-4-input-snapshot
git branch -d feature/goal-4-input-snapshot
git push origin --delete feature/goal-4-input-snapshot
```

---

## Verification

After all tasks land on develop:

- [ ] All checks green.
- [ ] Issue #5 closed.
- [ ] CLAUDE.md goal-status table — all 9 charter goals delivered.
- [ ] CHANGELOG `[Unreleased]` has both Added (Goal 4) and Changed (prep COALESCE fix) entries.
- [ ] Adversarial-review folder remains at `docs/superpowers/debates/2026-05-24-goal-4-input-snapshot/`.

After Goal 4, the v1 API surface is complete. The only remaining work for the first npm publish is descent-app validation per CLAUDE.md.

---

## Out-of-scope items (named so adversarial review of the plan can flag if any creep back in)

1. `clearInputSnapshot(jobId, attempt)` — explicit clear method; not v1.
2. Server-resolved `attempt` in writer — explicitly rejected, EXPLICIT is the design.
3. Narrowing `recordPatch.input_snapshot` — explicitly rejected, KEEP both writers.
4. Warn-above-threshold size heuristic — rejected; unbounded + docs.
5. `Job<TInput, TOutput>` generic — issue #13, deferred.
6. Compression of large snapshots — TOAST handles transparently.
7. Per-snapshot retention policy — consumer-owned.
8. Batch reader `getInputSnapshots(jobIds[])` — `findById` is the slow path.

If any of these slip in during implementation, stop and reconcile with the spec.

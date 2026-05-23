# Goal 6 — Persistent Progress API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `setProgress` / `getProgress` to the pg-bossier client — a persistent job-progress API that survives pg-boss's retry `DELETE`+`INSERT`, serving both resumable-job and display-only patterns.

**Architecture:** Two functions in a new `src/progress.ts`, reading/writing the already-shipped `pgbossier.record.progress jsonb` column (no schema change). `setProgress(pool, jobId, progress)` resolves the current attempt server-side as `max(attempt)` and writes; `getProgress(pool, jobId)` returns the most-recent non-null progress plus its source `attempt`. Both are wired onto the unified `bossier` client via its existing `BossierMethods` proxy. `recordPatch` is narrowed — `progress` is removed from it so `setProgress` is the column's sole writer.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), `pg` (Pool), pg-boss 12.18.2, vitest + `@testcontainers/postgresql` for integration tests (real Postgres + pg-boss, no mocks).

**Spec:** `docs/superpowers/specs/2026-05-21-goal-6-progress-api-design.md` (v3).

**Branch/commits:** Goal 6 is a feature — executed on a `feature/goal-6-progress-api` branch off `develop` (worktree per CLAUDE.md), merged back with `--no-ff`. Every commit message ends with the trailer:
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src/progress.ts` | **Create** | `ProgressResult` type, `setProgress`, `getProgress`. |
| `test/progress.test.ts` | **Create** | Integration tests for both functions (built up over Tasks 1–3). |
| `src/record.ts` | Modify | Remove `progress` from `RecordPatch` and the `recordPatch` UPDATE. |
| `src/client.ts` | Modify | Add `setProgress`/`getProgress` to `BossierMethods` and the `methods` object. |
| `src/index.ts` | Modify | Re-export the `ProgressResult` type. |
| `test/client.test.ts` | Modify | Swap the two `recordPatch({ progress })` calls to `input_snapshot`; extend `BOSSIER_METHOD_NAMES`; add a wiring test. |
| `CHANGELOG.md` | Modify | `Added` entries; correct the `recordPatch` line. |

The `pgbossier.record` table and its `progress` column already exist (shipped substrate) — **no migration, no `sql.ts` change**.

---

## Task 1: `setProgress` — the write path

**Files:**
- Create: `src/progress.ts`
- Create: `test/progress.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/progress.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { setProgress } from '../src/progress.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('setProgress writes progress to the current attempt row', async () => {
  const queue = 'progress-set';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, jobId!, { processed: 120, total: 500 });
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ processed: 120, total: 500 });
});

test('setProgress accepts a bare display string', async () => {
  const queue = 'progress-set-string';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, jobId!, 'Step 3 of 5');
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toBe('Step 3 of 5');
});

test('setProgress throws on null, undefined, or a non-serializable value', async () => {
  const queue = 'progress-set-bad';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await expect(setProgress(h.pool, jobId!, null)).rejects.toThrow();
  await expect(setProgress(h.pool, jobId!, undefined)).rejects.toThrow();
  await expect(setProgress(h.pool, jobId!, 10n)).rejects.toThrow();
});

test('setProgress is a no-op (no throw) for an unknown or malformed job id', async () => {
  await expect(
    setProgress(h.pool, '00000000-0000-0000-0000-000000000000', { x: 1 }),
  ).resolves.toBeUndefined();
  await expect(
    setProgress(h.pool, 'not-a-uuid', { x: 1 }),
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/progress.test.ts`
Expected: FAIL — `Failed to resolve import "../src/progress.js"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/progress.ts`:

```ts
import type { Pool } from 'pg';

/** A job's effective progress: the most-recent non-null value and its source attempt. */
export interface ProgressResult<TProgress = unknown> {
  /** The most-recent non-null progress value across the job's attempts. */
  progress: TProgress;
  /** The attempt number that value was written on. */
  attempt: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Write a job's progress to its *current* attempt's `pgbossier.record` row.
 *
 * The attempt is resolved server-side as `max(attempt)` for the job, so a
 * worker needs only `job.id`. Fail-open per issue #1's audit-write constraint:
 * a runtime error, or an UPDATE matching no row, is logged via `console.warn`
 * and swallowed — a failed progress write must never fail the consumer's job.
 * The *only* throw path is argument validation (a programmer error): `progress`
 * must not be `null` / `undefined` and must be JSON-serializable.
 */
export async function setProgress(
  pool: Pool, jobId: string, progress: unknown,
): Promise<void> {
  if (progress === undefined || progress === null) {
    throw new Error('setProgress: progress must not be null or undefined');
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(progress);
  } catch (err) {
    throw new Error(
      `setProgress: progress is not JSON-serializable: ${String(err)}`,
    );
  }
  if (json === undefined) {
    // JSON.stringify yields undefined for a function or a symbol.
    throw new Error('setProgress: progress is not JSON-serializable');
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE pgbossier.record
         SET progress = $2::jsonb
       WHERE job_id = $1
         AND attempt = (
           SELECT max(attempt) FROM pgbossier.record WHERE job_id = $1
         )`,
      [jobId, json],
    );
    if (rowCount === 0) {
      console.warn(
        `pgbossier: setProgress matched no record for job ${jobId} — ` +
        `is pg-bossier installed?`,
      );
    }
  } catch (err) {
    console.warn(`pgbossier: setProgress failed for job ${jobId}: ${String(err)}`);
  }
}

/**
 * Read a job's effective progress — the most-recent non-null `progress` value
 * across all attempts, plus the attempt it came from. `null` if the job is
 * unknown to pg-bossier or no attempt ever wrote progress. A malformed
 * (non-UUID) `jobId` short-circuits to `null` without a query.
 */
export async function getProgress<TProgress = unknown>(
  pool: Pool, jobId: string,
): Promise<ProgressResult<TProgress> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<{ progress: unknown; attempt: number }>(
    `SELECT progress, attempt FROM pgbossier.record
     WHERE job_id = $1 AND progress IS NOT NULL
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return { progress: row.progress as TProgress, attempt: row.attempt };
}
```

(`getProgress` is unused by Task 1's test but is implemented now so `src/progress.ts` is complete in one place; Task 2 adds its tests. ESLint does not flag an unused *export*.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/progress.test.ts`
Expected: PASS — 4 tests. (The no-op test prints two `console.warn` lines from pg-bossier — that is expected fail-open logging, not a failure.)

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts test/progress.test.ts
git commit -m "$(cat <<'EOF'
feat: add setProgress write path for Goal 6

setProgress(pool, jobId, progress) writes progress to the job's
current attempt (resolved server-side as max(attempt)). Marshals any
JSON-serializable value internally so bare display strings work.
Fail-open on runtime errors and zero-row matches; throws only on a
null/undefined/non-serializable argument.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `getProgress` — the read path

**Files:**
- Modify: `test/progress.test.ts` (add tests + extend the import)

- [ ] **Step 1: Write the failing tests**

In `test/progress.test.ts`, change the `progress.js` import line from:

```ts
import { setProgress } from '../src/progress.js';
```

to:

```ts
import { setProgress, getProgress } from '../src/progress.js';
```

Then append these tests to the end of the file:

```ts
test('getProgress returns the value and its source attempt', async () => {
  const queue = 'progress-get';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, jobId!, { pct: 40 });
  const result = await getProgress(h.pool, jobId!);
  expect(result).toEqual({ progress: { pct: 40 }, attempt: 0 });
});

test('getProgress returns null for a job that never wrote progress', async () => {
  const queue = 'progress-get-none';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  expect(await getProgress(h.pool, jobId!)).toBeNull();
});

test('getProgress returns null for unknown and malformed job ids', async () => {
  expect(
    await getProgress(h.pool, '00000000-0000-0000-0000-000000000000'),
  ).toBeNull();
  expect(await getProgress(h.pool, 'not-a-uuid')).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they pass**

`getProgress` was already implemented in Task 1, so these tests pass immediately — this step confirms the read path against the write path.

Run: `npx vitest run test/progress.test.ts`
Expected: PASS — 7 tests total.

- [ ] **Step 3: Commit**

```bash
git add test/progress.test.ts
git commit -m "$(cat <<'EOF'
test: cover getProgress read path for Goal 6

getProgress returns { progress, attempt } for the most-recent
non-null value, and null for unknown/malformed ids or a job that
never wrote progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Retry-resume and forensic-continuity tests

**Files:**
- Modify: `test/progress.test.ts` (add two tests + extend the import)

- [ ] **Step 1: Write the failing tests**

In `test/progress.test.ts`, add a new import line directly below the existing `progress.js` import:

```ts
import { getRetryHistory } from '../src/read.js';
```

Then append these two tests to the end of the file:

```ts
test('getProgress carries the prior attempt forward through a retry gap', async () => {
  const queue = 'progress-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  await h.boss.fetch(queue);                          // attempt 0 -> active
  await setProgress(h.pool, jobId!, { processed: 200 });
  await h.boss.fail(queue, jobId!, { err: 'boom' });  // attempt 0 -> retry
  await h.boss.fetch(queue);                          // attempt 1 -> active

  // attempt 1's row exists with progress still NULL
  const rows = await getRecords(h.pool, jobId!);
  expect(rows.map((r) => r.attempt)).toEqual([0, 1]);
  expect(rows[1]!.progress).toBeNull();

  // getProgress carries attempt 0's value forward; its attempt is the lower one
  expect(await getProgress(h.pool, jobId!)).toEqual({
    progress: { processed: 200 }, attempt: 0,
  });

  // once attempt 1 writes, getProgress flips to it
  await setProgress(h.pool, jobId!, { processed: 480 });
  expect(await getProgress(h.pool, jobId!)).toEqual({
    progress: { processed: 480 }, attempt: 1,
  });

  await h.boss.complete(queue, jobId!, { ok: true });
});

test('per-attempt progress stays visible via getRetryHistory after terminal state', async () => {
  const queue = 'progress-forensic';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  await h.boss.fetch(queue);
  await setProgress(h.pool, jobId!, { attempt: 'zero' });
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await setProgress(h.pool, jobId!, { attempt: 'one' });
  await h.boss.complete(queue, jobId!, { ok: true });

  const history = await getRetryHistory(h.pool, jobId!);
  expect(history.map((r) => r.progress)).toEqual([
    { attempt: 'zero' }, { attempt: 'one' },
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they pass**

The retry is driven by explicit `fetch`/`fail`/`fetch`/`complete` calls — fully deterministic, no polling (the harness runs pg-boss with `supervise: false`). Both functions already exist, so the tests pass on first run.

Run: `npx vitest run test/progress.test.ts`
Expected: PASS — 9 tests total.

- [ ] **Step 3: Commit**

```bash
git add test/progress.test.ts
git commit -m "$(cat <<'EOF'
test: cover Goal 6 retry-resume and forensic continuity

getProgress carries a prior attempt's value forward through the
retry gap (with the lower attempt number), then flips to the new
attempt once it writes. Per-attempt progress stays readable via
getRetryHistory after the job reaches a terminal state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Narrow `recordPatch` — `setProgress` becomes the sole `progress` writer

This is a refactor: `progress` is removed from `RecordPatch` so there is one write path to the column. Verified by the build (`tsc` proves no caller still passes `progress`) and the updated `client.test.ts`.

**Files:**
- Modify: `src/record.ts`
- Modify: `test/client.test.ts:23,26` and `test/client.test.ts:72,78`

- [ ] **Step 1: Update the two `recordPatch` tests in `test/client.test.ts`**

In `test/client.test.ts`, in the test `recordPatch writes app-hook columns without clobbering trigger columns`, replace:

```ts
  await client.recordPatch(jobId!, 0, { progress: { done: 5 } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ done: 5 });
```

with:

```ts
  await client.recordPatch(jobId!, 0, { input_snapshot: { done: 5 } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.input_snapshot).toEqual({ done: 5 });
```

And in the test `app-hook columns survive a later capture-trigger re-fire`, replace:

```ts
  await client.recordPatch(jobId!, 0, { progress: { done: 7 } });

  await h.boss.fetch(queue); // created -> active, re-fires the trigger

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');
  expect(rows[0]!.progress).toEqual({ done: 7 });
```

with:

```ts
  await client.recordPatch(jobId!, 0, { input_snapshot: { done: 7 } });

  await h.boss.fetch(queue); // created -> active, re-fires the trigger

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');
  expect(rows[0]!.input_snapshot).toEqual({ done: 7 });
```

- [ ] **Step 2: Run `client.test.ts` to confirm it still passes**

`input_snapshot` is already a valid `RecordPatch` field, so the tests pass before the narrowing — this confirms the swap is correct in isolation.

Run: `npx vitest run test/client.test.ts`
Expected: PASS.

- [ ] **Step 3: Narrow `RecordPatch` and `recordPatch`**

Replace the entire contents of `src/record.ts` with:

```ts
import type { Pool } from 'pg';

/** The pg-bossier-owned columns the app-hook may write via `recordPatch`. */
export interface RecordPatch {
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}

/**
 * Update the app-hook-owned columns of a record row, keyed by
 * `(jobId, attempt)`. A plain UPDATE, not an upsert — the capture trigger
 * always creates the row first, so the insert path (and its NOT NULL
 * queue/state columns) is never needed.
 *
 * A wrong `jobId`/`attempt` matches no row: the UPDATE is a silent no-op,
 * not an error. Patch values must be valid `jsonb`. The `progress` column
 * is written by Goal 6's `setProgress` (see `src/progress.ts`), which is its
 * sole write path — `recordPatch` deliberately does not touch it.
 */
export async function recordPatch(
  pool: Pool, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE pgbossier.record SET
       terminal_detail = COALESCE($3, terminal_detail),
       input_snapshot  = COALESCE($4, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [
      jobId, attempt,
      patch.terminal_detail ?? null,
      patch.input_snapshot ?? null,
    ],
  );
}
```

- [ ] **Step 4: Verify build and tests pass**

Run: `npm run build`
Expected: `tsc` exits clean — this proves no remaining code passes `progress` to `recordPatch` (if any did, `RecordPatch` losing the field would be a type error).

Run: `npx vitest run test/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/record.ts test/client.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove progress from recordPatch — setProgress owns it

The progress column had two public writers — recordPatch and the new
setProgress — with contradictory null and marshalling behavior.
Narrow RecordPatch to terminal_detail / input_snapshot only;
setProgress (src/progress.ts) is now the column's sole write path.
The two recordPatch tests in client.test.ts move to input_snapshot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `setProgress` / `getProgress` onto the unified client

**Files:**
- Modify: `src/client.ts`
- Modify: `src/index.ts`
- Modify: `test/client.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/client.test.ts`, replace the `BOSSIER_METHOD_NAMES` block:

```ts
/** The eight methods pg-bossier adds on top of pg-boss's API. */
const BOSSIER_METHOD_NAMES = [
  'recordPatch', 'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
] as const;
```

with:

```ts
/** The ten methods pg-bossier adds on top of pg-boss's API. */
const BOSSIER_METHOD_NAMES = [
  'recordPatch', 'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
  'setProgress', 'getProgress',
] as const;
```

Then append this test to the end of `test/client.test.ts`:

```ts
test('the client exposes setProgress and getProgress bound to its pool', async () => {
  const queue = 'client-progress';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.setProgress(jobId!, { via: 'client' });
  expect(await client.getProgress(jobId!)).toEqual({
    progress: { via: 'client' }, attempt: 0,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build`
Expected: FAIL — `tsc` reports `Property 'setProgress' does not exist on type 'Bossier'` (and `getProgress`). The test cannot compile because the methods are not on `BossierMethods` yet.

- [ ] **Step 3: Add the methods to `src/client.ts`**

In `src/client.ts`, add this import directly below the `./record.js` import:

```ts
import { setProgress, getProgress, type ProgressResult } from './progress.js';
```

In the `BossierMethods` interface, add these two members immediately after the `listLongRunning` member (before the closing `}`):

```ts
  /** Write a job's progress to its current attempt. */
  setProgress: (jobId: string, progress: unknown) => Promise<void>;
  /** A job's effective progress — most-recent non-null, with its source attempt. */
  getProgress: <TProgress = unknown>(
    jobId: string,
  ) => Promise<ProgressResult<TProgress> | null>;
```

In the `methods` object inside `bossier()`, add these two entries immediately after the `listLongRunning` entry (before the closing `};`):

```ts
    setProgress: (jobId, progress) => setProgress(pool, jobId, progress),
    getProgress: <TProgress = unknown>(jobId: string) =>
      getProgress<TProgress>(pool, jobId),
```

(No other `client.ts` change is needed: `methodNames` is derived from `Object.keys(methods)`, so the proxy forwards the two new methods automatically.)

- [ ] **Step 4: Export the type from `src/index.ts`**

In `src/index.ts`, add this line after the `export type { RecordPatch } ...` line:

```ts
export type { ProgressResult } from './progress.js';
```

- [ ] **Step 5: Run build and tests to verify they pass**

Run: `npm run build`
Expected: `tsc` exits clean.

Run: `npx vitest run test/client.test.ts`
Expected: PASS — including the new wiring test and the collision guard (now covering `setProgress` / `getProgress`; pg-boss has neither).

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "$(cat <<'EOF'
feat: wire setProgress / getProgress onto the unified client

Add both methods to BossierMethods and the client's methods object;
the proxy forwards them automatically. Export the ProgressResult type
from the package root. Extend the client.test.ts method-name guard.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: CHANGELOG entry and full verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update `CHANGELOG.md`**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, find the line beginning ``- `bossier({ boss, pool })` client — one unified surface`` and replace its trailing parenthesis. Change:

```
including `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns (`progress`, `terminal_detail`, `input_snapshot`).
```

to:

```
including `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns `terminal_detail` and `input_snapshot`.
```

Then add these two bullets at the end of the `### Added` list (after the `record_active_idx` bullet):

```
- Goal 6 persistent job-progress API on the `bossier` client — `setProgress` and `getProgress`, reading and writing the `pgbossier.record.progress` column, which survives pg-boss's DELETE+INSERT retry path:
  - `setProgress(jobId, progress)` — writes progress to the job's current attempt (resolved server-side as `max(attempt)`, so the worker needs only `job.id`). Accepts any JSON-serializable value; fail-open on runtime errors; throws only on a null/undefined/non-serializable argument.
  - `getProgress(jobId)` — returns `{ progress, attempt }` for the most-recent non-null progress across attempts (the `attempt` distinguishes a current-attempt checkpoint from a carried-forward prior-attempt value), or `null` if unknown or never written.
- Exported type `ProgressResult<TProgress>`; `getProgress` is generic over `<TProgress>`.
- `recordPatch` no longer writes the `progress` column — `setProgress` is its sole write path.
```

- [ ] **Step 2: Run the full verification gate**

Run: `npm run lint && npm run build && npm test`
Expected: lint clean, `tsc` clean, all tests pass (the full suite — 9 new files' worth of `progress.test.ts` tests plus the existing suite; the `console.warn` lines from the `setProgress` no-op test are expected fail-open logging).

If anything fails, report the actual output — do not proceed.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: changelog entry for the Goal 6 progress API

Add setProgress / getProgress and ProgressResult under [Unreleased];
correct the recordPatch line — it no longer covers progress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage** — every section of `2026-05-21-goal-6-progress-api-design.md` v3 maps to a task:

| Spec section | Task |
|---|---|
| §1 Write API (`setProgress`, server-side `max(attempt)`) | Task 1 |
| §2 Read API (`getProgress`, `ProgressResult`, most-recent non-null) | Tasks 1+2 |
| §3 Retry-resume semantics (carry-forward, `attempt` provenance) | Task 3 |
| §4 Marshalling & validation (JSON.stringify, throw on null/undefined/non-serializable) | Task 1 |
| §5 Error handling (fail-open, `console.warn`, throw only on bad args) | Task 1 |
| §6 Retention (keep-forever — no clearing) | No code needed — verified by Task 3's forensic test |
| §7 Code layout (`src/progress.ts`; `recordPatch` narrowed; `index.ts` export) | Tasks 1, 4, 5 |
| §8 Compatibility tier (no new pg-boss surface) | No code — no `COMPATIBILITY.md` change, as the spec states |
| §9 API-shape (sibling method in `BossierMethods`) | Task 5 |
| §10 Edge-case matrix | Tasks 1–3 (unknown/malformed id, zombie n/a to unit test, retry gap) |
| §11 Testing | Tasks 1–3, 5 |

**2. Placeholder scan** — no `TBD`/`TODO`; every code step shows complete code; every run step shows the exact command and expected result.

**3. Type consistency** — `ProgressResult<TProgress>` is defined once in `src/progress.ts` (Task 1) and referenced identically in `src/client.ts` and `src/index.ts` (Task 5). `setProgress(pool, jobId, progress)` / `getProgress(pool, jobId)` signatures match between `src/progress.ts`, the `methods` object, and the `BossierMethods` interface. `RecordPatch` after Task 4 (`terminal_detail` + `input_snapshot`) matches the `recordPatch` UPDATE's two patch params.

**Note on the zombie-worker edge case (§1/§10):** it is not unit-testable deterministically (it needs a real expiry-plus-live-worker race) and is documented in the spec as an accepted limitation — no task targets it, by design.

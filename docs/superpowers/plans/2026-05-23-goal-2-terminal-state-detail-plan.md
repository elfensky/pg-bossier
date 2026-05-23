# Goal 2 Terminal-State Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pg-bossier Goal 2 — terminal-state detail per the v2 spec. Adds a `recordTerminalDetail` method on the unified `bossier` client that writes a worker-classified failure shape into the existing `pgbossier.record.terminal_detail` JSONB column; narrows the existing `recordPatch` to no longer touch `terminal_detail`; updates the typed reader to return a discriminated-union `JobRecord` keyed on row state (including `retry`-state rows carrying `TerminalDetailFailed | null`).

**Architecture:** A new module `src/terminal-detail.ts` exports the validator + SQL writer. The writer takes a single discriminated-union object `{ state, detail }`, validates `detail` against `state` in JS, then runs `UPDATE pgbossier.record SET terminal_detail = $4::jsonb WHERE job_id = $1 AND attempt = $2 AND state = ANY($3::text[])` where `$3` carries the allowed row-state mapping (`failed` → `['failed', 'retry']`, `completed` → `['completed']`, `cancelled` → `['cancelled']`). A new shared utility `src/json.ts` exports `stringifyOrThrow(value, fieldName)` used by both `recordTerminalDetail` and (refactored) `setProgress`. The existing `RecordPatch` interface in `src/record.ts` loses its `terminal_detail` field; `recordPatch`'s SQL drops the matching COALESCE line. The reader in `src/read.ts` replaces `terminalDetail: unknown` with a state-discriminated union; `state: 'retry'` rows now allow `TerminalDetailFailed | null` (correcting the v1 spec's null-only). `src/client.ts` adds `recordTerminalDetail` to the proxy's own method list (alongside `setProgress`, `recordPatch`). `src/index.ts` re-exports the four new public types.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Node 18.3+, ESM, `pg` (node-postgres), vitest + `@testcontainers/postgresql` for tests, pg-boss 12.18.2 as wrapped queue.

**Spec:** [`docs/superpowers/specs/2026-05-23-goal-2-terminal-state-detail-design.md`](../specs/2026-05-23-goal-2-terminal-state-detail-design.md) (v2)
**Adversarial review:** [`docs/superpowers/debates/2026-05-23-goal-2-spec-adversarial-review/`](../debates/2026-05-23-goal-2-spec-adversarial-review/) — four reviewers, two rounds, synthesis at `99-synthesis.md`
**Charter:** [`CLAUDE.md`](../../../CLAUDE.md) — feature branches via `git worktree`; `--no-ff` merge into `develop`; CHANGELOG under `[Unreleased]`; lint + build + test must all pass before claiming done.

---

## File map (locked before tasks)

**New files**
- `src/terminal-detail.ts` — validator + SQL writer for `recordTerminalDetail`. ~80 LOC.
- `src/json.ts` — shared `stringifyOrThrow(value, fieldName)` utility. ~15 LOC.
- `test/terminal-detail.test.ts` — integration tests for the new method (Section A tests 1-10).

**Modified files**
- `src/record.ts` — `RecordPatch` loses `terminal_detail`; SQL drops the `terminal_detail` COALESCE line; param indices shift; JSDoc gains a sentence pointing at `recordTerminalDetail`.
- `src/read.ts` — replace `terminalDetail: unknown` with the discriminated `TerminalDetail*` payload types; allow `TerminalDetailFailed | null` on `state: 'retry'` rows; export `TerminalDetail`, `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`.
- `src/progress.ts` — refactor `setProgress` to use `stringifyOrThrow` from `src/json.ts` (regression-safe; same external behavior).
- `src/client.ts` — add `recordTerminalDetail` to the `BossierMethods` surface; the proxy's collision-test fixture extended.
- `src/index.ts` — re-export the four new public types.
- `test/capture.test.ts` (or wherever the capture trigger is tested today) — extend with the trigger-preservation regression test.
- `test/recordPatch.test.ts` — extend with the narrowed-API regression test.
- `test/read.test.ts` — extend with the reader-narrowing compile-time fixture.
- `test/progress.test.ts` — verify refactor preserved all existing behavior (no test changes expected; smoke run only).
- `README.md` — add "Recording terminal detail" section with the upgrade-policy paragraph for pre-Goal-2 `recordPatch` users.
- `CHANGELOG.md` — `[Unreleased]` entry.
- `CLAUDE.md` — project-status paragraph + goal-status table sync.

**Decomposition principle.** Shared utility comes first (Task 1) so both `setProgress` and `recordTerminalDetail` use the same code path. Then `recordPatch` narrows (Task 2) before the new method is added (Task 3) — single-writer convention before sole-writer ships. The reader update (Task 4) follows once the writer + storage shape is settled. Client wiring (Task 5) is the last code change; tests + docs (Tasks 6-7) close the loop. Each task ships green CI on its own.

---

## Task 0 — Worktree, branch, baseline

**Files:** `.worktrees/feature-goal-2-terminal-state-detail/` (gitignored)

- [ ] **Step 1: Create the worktree off `develop`**

Run from the main checkout:
```bash
git worktree add .worktrees/feature-goal-2-terminal-state-detail \
  -b feature/goal-2-terminal-state-detail develop
```

Expected: new directory at `.worktrees/feature-goal-2-terminal-state-detail/`, branch checked out.

- [ ] **Step 2: Install deps + verify baseline is green**

```bash
cd .worktrees/feature-goal-2-terminal-state-detail
npm install
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` clean, all existing tests pass.

---

## Task 1 — Add the shared `src/json.ts` utility (TDD)

**Files:**
- New: `src/json.ts`
- Test: extend `test/progress.test.ts` for cross-cutting edge cases (or create `test/json.test.ts` if cleaner — vitest fast, no container).

**Goal:** Centralize the `JSON.stringify` guard pattern that `setProgress` already uses. `recordTerminalDetail` will reuse it without copy-paste.

- [ ] **Step 1: Define the utility's signature and contract**

```ts
// src/json.ts
/**
 * JSON-stringify a value with explicit guards. Throws with a pg-bossier-
 * prefixed message identifying `fieldName` for any non-serializable input.
 *
 * Standard JSON.stringify behaviors are preserved (not coerced):
 *  - Date → ISO string (caller must format if they want fidelity).
 *  - Non-finite numbers (NaN, Infinity) → JSON null.
 *  - Symbol-keyed properties → silently dropped.
 *
 * Throw paths:
 *  - JSON.stringify synchronous throw (BigInt, circular reference) →
 *    `pg-bossier: <fieldName> validation: value is not JSON-serializable: <err>`.
 *  - JSON.stringify returns undefined (function, symbol top-level) →
 *    `pg-bossier: <fieldName> validation: value is not JSON-serializable`.
 *
 * Returns the JSON string on success.
 */
export function stringifyOrThrow(value: unknown, fieldName: string): string;
```

- [ ] **Step 2: Write a TDD test fixture before implementing**

Create `test/json.test.ts` (fast, no container — pure JS):

```ts
import { describe, it, expect } from 'vitest';
import { stringifyOrThrow } from '../src/json.js';

describe('stringifyOrThrow', () => {
  it('returns a JSON string for a plain object', () => {
    expect(stringifyOrThrow({ a: 1 }, 'detail')).toBe('{"a":1}');
  });

  it('returns "null" for null', () => {
    expect(stringifyOrThrow(null, 'detail')).toBe('null');
  });

  it('throws on a top-level function (JSON.stringify returns undefined)', () => {
    expect(() => stringifyOrThrow(() => 1, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on a top-level symbol', () => {
    expect(() => stringifyOrThrow(Symbol('x'), 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on BigInt', () => {
    expect(() => stringifyOrThrow({ id: 1n }, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('throws on a circular reference', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => stringifyOrThrow(a, 'detail'))
      .toThrow(/pg-bossier: detail validation: .*not JSON-serializable/);
  });

  it('encodes Date as ISO string (standard behavior)', () => {
    const d = new Date('2026-05-23T00:00:00Z');
    expect(stringifyOrThrow({ at: d }, 'detail'))
      .toBe('{"at":"2026-05-23T00:00:00.000Z"}');
  });

  it('encodes NaN as null (standard behavior)', () => {
    expect(stringifyOrThrow({ x: NaN }, 'detail')).toBe('{"x":null}');
  });

  it('includes the underlying error message on stringify throw', () => {
    try {
      stringifyOrThrow({ id: 1n }, 'detail');
    } catch (err) {
      expect((err as Error).message).toMatch(/BigInt/i);
    }
  });
});
```

Run: `npm test -- test/json.test.ts`. Expected: all 9 fail (the module doesn't exist yet).

- [ ] **Step 3: Implement `src/json.ts`**

```ts
// src/json.ts
export function stringifyOrThrow(value: unknown, fieldName: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    throw new Error(
      `pg-bossier: ${fieldName} validation: value is not JSON-serializable: ${String(err)}`,
    );
  }
  if (json === undefined) {
    throw new Error(
      `pg-bossier: ${fieldName} validation: value is not JSON-serializable`,
    );
  }
  return json;
}
```

Run: `npm test -- test/json.test.ts`. Expected: all 9 pass.

- [ ] **Step 4: Lint + build green**

```bash
npm run lint && npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/json.ts test/json.test.ts
git commit -m "feat(json): add shared stringifyOrThrow utility (Goal 2 prep)"
```

---

## Task 2 — Refactor `setProgress` to use the shared utility (regression-safe)

**Files:**
- Modify: `src/progress.ts`
- No test changes expected — existing `test/progress.test.ts` is the regression net.

**Goal:** Migrate `setProgress` from its inline `JSON.stringify` guard to `stringifyOrThrow`. External behavior unchanged; error messages refined to the new prefix-aware format.

- [ ] **Step 1: Read current `src/progress.ts`**

Confirm lines 36-47 are the inline guard. Note the existing error messages (`setProgress: progress must not be null or undefined`, `setProgress: progress is not JSON-serializable: ...`).

- [ ] **Step 2: Replace the inline stringify with `stringifyOrThrow`**

```ts
// src/progress.ts (top imports)
import { stringifyOrThrow } from './json.js';
```

In the body of `setProgress`, replace:
```ts
let json: string | undefined;
try {
  json = JSON.stringify(progress);
} catch (err) {
  throw new Error(
    `setProgress: progress is not JSON-serializable: ${String(err)}`,
  );
}
if (json === undefined) {
  throw new Error('setProgress: progress is not JSON-serializable');
}
```

with:

```ts
const json = stringifyOrThrow(progress, 'progress');
```

Keep the `progress === undefined || progress === null` check unchanged — `stringifyOrThrow` doesn't enforce non-null (that's `setProgress`'s contract, not `stringifyOrThrow`'s).

- [ ] **Step 3: Update existing tests that asserted on `setProgress:` prefix**

Search `test/progress.test.ts` for `setProgress:` in error message assertions. Update to match the new prefix `pg-bossier: progress validation:`. The null check error keeps `setProgress:` prefix unless tests want consistency.

Decision point for the implementer: align the null-check error message to the same `pg-bossier:` prefix for full consistency? Recommend yes — flip `throw new Error('setProgress: progress must not be null or undefined')` to `throw new Error('pg-bossier: progress validation: progress must not be null or undefined')`. Update matching test assertions.

- [ ] **Step 4: Run progress tests; verify green**

```bash
npm test -- test/progress.test.ts
```

Expected: all existing tests pass.

- [ ] **Step 5: Run the full test suite**

```bash
npm run lint && npm run build && npm test
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/progress.ts test/progress.test.ts
git commit -m "refactor(progress): use shared stringifyOrThrow utility"
```

---

## Task 3 — Narrow `recordPatch` to drop `terminal_detail`

**Files:**
- Modify: `src/record.ts`
- Modify: `test/recordPatch.test.ts`

**Goal:** Make `recordTerminalDetail` the sole writer for `terminal_detail` by removing the field from `recordPatch`'s API surface. The new method doesn't exist yet — that's Task 4 — but this task ensures the single-writer convention is structurally enforced before the new writer ships.

- [ ] **Step 1: Update `src/record.ts` — narrow `RecordPatch` and the SQL**

Current shape:
```ts
export interface RecordPatch {
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}
```

New shape:
```ts
export interface RecordPatch {
  input_snapshot?: unknown;
}
```

Current SQL (in `recordPatch`):
```sql
UPDATE pgbossier.record SET
  terminal_detail = COALESCE($3, terminal_detail),
  input_snapshot  = COALESCE($4, input_snapshot)
WHERE job_id = $1 AND attempt = $2
```

New SQL:
```sql
UPDATE pgbossier.record SET
  input_snapshot = COALESCE($3, input_snapshot)
WHERE job_id = $1 AND attempt = $2
```

Param array: was `[jobId, attempt, patch.terminal_detail ?? null, patch.input_snapshot ?? null]`. New: `[jobId, attempt, patch.input_snapshot ?? null]`.

- [ ] **Step 2: Update JSDoc on `recordPatch`**

Add a sentence parallel to the existing Goal-6 sentence about `progress`:

> The `terminal_detail` column is written by Goal 2's `recordTerminalDetail` (see `src/terminal-detail.ts`), which is its sole write path — `recordPatch` deliberately does not touch it.

- [ ] **Step 3: Add a regression test that the narrowed `RecordPatch` rejects `terminal_detail`**

Create a TS-fixture-style test (compile-time check). Add at the top of `test/recordPatch.test.ts`:

```ts
// @ts-expect-error — RecordPatch no longer accepts terminal_detail.
const _shouldNotCompile: import('../src/record.js').RecordPatch = {
  terminal_detail: { ignored: true },
};
void _shouldNotCompile;
```

This compiles ONLY if `terminal_detail` is no longer in the type — `@ts-expect-error` enforces the negation. If a future refactor accidentally re-adds the field, this fixture fails to compile.

- [ ] **Step 4: Add a runtime test that `input_snapshot` still writes**

```ts
it('recordPatch still writes input_snapshot', async () => {
  // ... existing harness scaffolding ...
  await recordPatch(pool, schemas, jobId, 0, { input_snapshot: { foo: 'bar' } });
  const row = await pool.query(
    `SELECT input_snapshot FROM ${schemas.pgbossier}.record
     WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  expect(row.rows[0].input_snapshot).toEqual({ foo: 'bar' });
});
```

(Adapt to the harness shape already in `test/recordPatch.test.ts`.)

- [ ] **Step 5: Update any callers of `recordPatch` that passed `terminal_detail`**

Grep for `terminal_detail:` and `terminal_detail ?` across `src/` and `test/`. The only legitimate writer should be `recordTerminalDetail` (after Task 4). All current `recordPatch` callers must drop the field.

Expected: no production code passes `terminal_detail` to `recordPatch` (it's a low-level API). Tests that do should be reframed in Task 4 to use `recordTerminalDetail` instead.

- [ ] **Step 6: Lint + build + test green**

```bash
npm run lint && npm run build && npm test
```

Expected: clean. The `@ts-expect-error` fixture is the new compile-time guard.

- [ ] **Step 7: Commit**

```bash
git add src/record.ts test/recordPatch.test.ts
git commit -m "feat(record): narrow recordPatch to drop terminal_detail"
```

---

## Task 4 — Create `src/terminal-detail.ts` and `recordTerminalDetail` (TDD)

**Files:**
- New: `src/terminal-detail.ts`
- New: `test/terminal-detail.test.ts`

**Goal:** The validator + SQL writer. Test-first.

- [ ] **Step 1: Define the public type surface in a draft**

```ts
// src/terminal-detail.ts (skeleton — types only)
import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

export type TerminalDetailCompleted = Record<string, unknown>;
export type TerminalDetailCancelled = { cancelledBy?: string; reason?: string };
export type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
} & Record<string, unknown>;

export type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };

export async function recordTerminalDetail(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt: number,
  payload: TerminalDetail,
): Promise<void> { /* impl in step 3 */ }
```

Note: the public client-facing signature (`client.recordTerminalDetail(jobId, attempt, payload)`) is wired by `src/client.ts` in Task 5; the free function takes `pool, schemas` as additional params, matching `setProgress`/`recordPatch`.

- [ ] **Step 2: Write `test/terminal-detail.test.ts` with the spec's tests 1-10**

Use the existing testcontainer harness (`test/harness.ts` or equivalent). Tests:

1. **Validation rejects missing class on failed.** `recordTerminalDetail(pool, schemas, id, 0, { state: 'failed', detail: {} as TerminalDetailFailed })` (force-cast to bypass TS) → throws with message matching `/pg-bossier: terminal_detail validation: failed state requires class/`. Verify no row modified.
2. **Validation rejects unknown class.** `{ state: 'failed', detail: { class: 'maybe' as 'transient' } }` → throws same prefix.
3. **Validation accepts both legal class values.** `'transient'` and `'non_retryable'` succeed.
4. **Validation accepts non-failed states with any shape.** `{ state: 'completed', detail: { duration: 42 } }` and `{ state: 'cancelled', detail: { cancelledBy: 'user', reason: 'x' } }` both succeed.
5. **Happy path: handler-throw failure end-to-end.** Send + work (handler throws) + recordTerminalDetail({state: 'failed', detail: { class: 'transient', message: 'rate-limited' }}) + findById → returns `terminalDetail.class === 'transient'`. **Explicitly use the `work` handler throw path** (not `boss.fail`).
6. **Wrong `(jobId, attempt)` is a silent no-op.** Non-existent UUID → resolves without throwing; no row touched.
7. **Late call after pg-boss DELETE+INSERT retry.** Send job with `retryLimit: 1`. Handler throws. pg-boss moves the row through `state='retry'` and re-inserts as attempt 1. Worker calls `recordTerminalDetail(id, 0, {state: 'failed', detail: { class: 'transient' }})`. Assertions: (a) `findById(id)` returns the latest attempt's row, which is attempt 1 — call with `getRetryHistory(id)` instead to see all attempts. (b) Attempt 0's row has the detail. (c) Attempt 1's row is untouched.
8. **Concurrent calls — last-writer-wins.** Two sequential calls with different payloads on the same `(id, attempt)`; the second is what `findById` returns.
9. **State-mismatch is a silent no-op.** Send + complete a job (state=completed). Call `recordTerminalDetail(id, 0, { state: 'failed', detail: { class: 'transient' } })` — the SQL's `state = ANY(['failed','retry'])` doesn't match `'completed'`, so the UPDATE affects zero rows. Assert no change to `terminal_detail`.
10. **JSON.stringify edge cases.**
    - Function in detail: `{ state: 'failed', detail: { class: 'transient', cb: () => 1 } as TerminalDetailFailed }` — `JSON.stringify` returns `{"class":"transient"}` (function key dropped silently). Doesn't throw; this is standard behavior. **Adjust the test to use a top-level function** if we want the throw path — but that would require an invalid TS cast. **Alternative**: test BigInt path: `{ state: 'failed', detail: { class: 'transient', id: 1n } as unknown as TerminalDetailFailed }` → throws with message matching `/BigInt/`.
    - Circular reference: build a circular object and assert throw with the prefix.

Run: `npm test -- test/terminal-detail.test.ts`. Expected: all fail (the function is a stub).

- [ ] **Step 3: Implement `recordTerminalDetail`**

```ts
// src/terminal-detail.ts (full)
import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

export type TerminalDetailCompleted = Record<string, unknown>;
export type TerminalDetailCancelled = { cancelledBy?: string; reason?: string };
export type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
} & Record<string, unknown>;

export type TerminalDetail =
  | { state: 'completed'; detail: TerminalDetailCompleted }
  | { state: 'cancelled'; detail: TerminalDetailCancelled }
  | { state: 'failed';    detail: TerminalDetailFailed };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function allowedStates(state: TerminalDetail['state']): string[] {
  return state === 'failed' ? ['failed', 'retry'] : [state];
}

export async function recordTerminalDetail(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt: number,
  payload: TerminalDetail,
): Promise<void> {
  if (!isPlainObject(payload) || !isPlainObject(payload.detail)) {
    throw new Error(
      `pg-bossier: terminal_detail validation: payload and detail must be plain objects`,
    );
  }
  if (payload.state === 'failed') {
    const cls = (payload.detail as TerminalDetailFailed).class;
    if (cls !== 'transient' && cls !== 'non_retryable') {
      throw new Error(
        `pg-bossier: terminal_detail validation: failed state requires class in ('transient', 'non_retryable')`,
      );
    }
  }
  const json = stringifyOrThrow(payload.detail, 'terminal_detail');
  const states = allowedStates(payload.state);
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record
       SET terminal_detail = $4::jsonb
     WHERE job_id = $1
       AND attempt = $2
       AND state = ANY($3::text[])`,
    [jobId, attempt, states, json],
  );
}
```

Run: `npm test -- test/terminal-detail.test.ts`. Expected: all pass.

- [ ] **Step 4: Lint + build green**

```bash
npm run lint && npm run build
```

Expected: clean. Pay attention to `@typescript-eslint/no-misused-promises` (the `pool.query` await must resolve cleanly) and `consistent-type-imports`.

- [ ] **Step 5: Commit**

```bash
git add src/terminal-detail.ts test/terminal-detail.test.ts
git commit -m "feat(terminal-detail): add recordTerminalDetail with state-bound SQL writer"
```

---

## Task 5 — Update the reader (`src/read.ts`) with the discriminated-union types

**Files:**
- Modify: `src/read.ts`
- Modify: `test/read.test.ts` (compile-time fixture)

**Goal:** Replace `terminalDetail: unknown` with the discriminated payload type. Allow `TerminalDetailFailed | null` on `state: 'retry'` rows (the v2 spec's correction).

- [ ] **Step 1: Import the types from `src/terminal-detail.ts`**

```ts
// src/read.ts top imports
import type {
  TerminalDetail,
  TerminalDetailCompleted,
  TerminalDetailCancelled,
  TerminalDetailFailed,
} from './terminal-detail.js';
```

- [ ] **Step 2: Update the `JobRecord` discriminated union**

Find the current `JobRecord` definition. Replace `terminalDetail: unknown` per-branch with the typed payload:

```ts
export type JobRecord =
  | { state: 'created' | 'active'; terminalDetail: null;                                       /* other fields */ }
  | { state: 'retry';     terminalDetail: TerminalDetailFailed | null;                         /* other fields */ }
  | { state: 'completed'; terminalDetail: TerminalDetailCompleted | null;                      /* other fields */ }
  | { state: 'cancelled'; terminalDetail: TerminalDetailCancelled | null;                      /* other fields */ }
  | { state: 'failed';    terminalDetail: TerminalDetailFailed | null;                         /* other fields */ };
```

Keep other JobRecord fields (job_id, queue, attempt, captured_at, seq, progress, input_snapshot, etc.) exactly as they are. Only the `state` × `terminalDetail` pair changes.

- [ ] **Step 3: Update `mapRecord` (or equivalent) to cast `row.terminal_detail` accordingly**

The cast is trust-the-writer: `row.terminal_detail as TerminalDetailFailed | null` (or the matching branch's type). No runtime validation. Soundness rests on the single-writer convention + the SQL state-bind + the capture trigger's preservation (verified by Task 6's test).

- [ ] **Step 4: Add the compile-time narrowing fixture to `test/read.test.ts`**

```ts
import type { JobRecord } from '../src/read.js';

function _narrowingFixture(job: JobRecord): void {
  if (job.state === 'failed' || job.state === 'retry') {
    if (job.terminalDetail) {
      // This line must compile — terminalDetail is TerminalDetailFailed.
      const _cls: 'transient' | 'non_retryable' = job.terminalDetail.class;
      void _cls;
    }
  }
  if (job.state === 'completed' && job.terminalDetail) {
    // This line must compile — terminalDetail is TerminalDetailCompleted (Record<string, unknown>).
    const _anyField: unknown = job.terminalDetail['anyField'];
    void _anyField;
  }
  if (job.state === 'cancelled' && job.terminalDetail) {
    // This line must compile — terminalDetail is TerminalDetailCancelled.
    const _by: string | undefined = job.terminalDetail.cancelledBy;
    void _by;
  }
}
void _narrowingFixture;
```

(The function exists only for the compiler to check; never invoked.)

- [ ] **Step 5: Add a runtime test for the retry-state reader**

```ts
it('findById returns terminalDetail for a retry-state row', async () => {
  // Send a job with retryLimit: 2; handler throws; recordTerminalDetail
  // is called; pg-boss moves the row to retry state before re-inserting.
  // findById on the original attempt's job_id (returning the latest attempt)
  // doesn't help here — use getRetryHistory or a direct query.
  // ... harness setup ...
  const history = await getRetryHistory(pool, schemas, jobId);
  const attempt0 = history.find(r => r.attempt === 0);
  expect(attempt0).toBeDefined();
  expect(attempt0!.state).toBeOneOf(['failed', 'retry']);
  expect(attempt0!.terminalDetail).toMatchObject({ class: 'transient' });
});
```

- [ ] **Step 6: Lint + build + test green**

```bash
npm run lint && npm run build && npm test
```

Expected: clean. The fixture in Step 4 is the new compile-time guard.

- [ ] **Step 7: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat(read): narrow JobRecord.terminalDetail by state (incl. retry)"
```

---

## Task 6 — Wire `recordTerminalDetail` into the client proxy + exports

**Files:**
- Modify: `src/client.ts`
- Modify: `src/index.ts`
- Modify: `test/client.test.ts` (collision-test fixture)

**Goal:** Make `recordTerminalDetail` callable as `client.recordTerminalDetail(jobId, attempt, payload)` via the unified `bossier()` proxy. Add the four new types to the public `pg-bossier` import surface.

- [ ] **Step 1: Add `recordTerminalDetail` to the proxy's method list in `src/client.ts`**

The current `BossierMethods` (or equivalent) exposes `setProgress`, `getProgress`, `recordPatch`, `findById`, etc. Add:

```ts
async recordTerminalDetail(
  jobId: string,
  attempt: number,
  payload: TerminalDetail,
): Promise<void> {
  return _recordTerminalDetail(pool, schemas, jobId, attempt, payload);
}
```

(Adapt the closure / factory shape to match the existing pattern. The free function from `src/terminal-detail.ts` becomes the implementation.)

- [ ] **Step 2: Update the collision-test fixture**

`src/client.ts` (or its test) has a CI check that pg-bossier's own method names never collide with `PgBoss.prototype`. Add `'recordTerminalDetail'` to the explicit allow-list / verify it's not on `PgBoss.prototype`.

- [ ] **Step 3: Re-export the four public types from `src/index.ts`**

```ts
export type {
  TerminalDetail,
  TerminalDetailCompleted,
  TerminalDetailCancelled,
  TerminalDetailFailed,
} from './terminal-detail.js';
```

- [ ] **Step 4: Verify the proxy method works through the unified client**

Add a smoke test to `test/client.test.ts`:

```ts
it('client.recordTerminalDetail writes terminal_detail via the proxy', async () => {
  const client = bossier({ boss, pool });
  // ... setup ...
  await client.recordTerminalDetail(jobId, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'test' },
  });
  const job = await client.findById(jobId);
  expect(job?.terminalDetail).toMatchObject({ class: 'transient' });
});
```

- [ ] **Step 5: Lint + build + test green**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "feat(client): expose recordTerminalDetail on the bossier proxy"
```

---

## Task 7 — Capture-trigger preservation regression test

**Files:**
- Modify: `test/capture.test.ts` (or wherever the capture trigger is tested today)

**Goal:** Lock in the structural guarantee Section C of the spec relies on — the capture trigger's `ON CONFLICT DO UPDATE` SET list does NOT include `terminal_detail`. A future trigger change that adds it would silently break Goal 2's "trust the writer" claim.

- [ ] **Step 1: Add a runtime test**

```ts
it('capture trigger preserves terminal_detail across subsequent fires', async () => {
  // 1. Send a job, let pg-boss create the row (capture trigger fires once).
  // 2. Call recordTerminalDetail to write detail.
  // 3. Trigger pg-boss to UPDATE the row again (e.g., touch the state via
  //    a manual UPDATE on pgboss.job, or call boss.touch / a state-changing
  //    op). Capture trigger fires again on UPDATE OF state.
  // 4. Assert pgbossier.record.terminal_detail is unchanged.
  // ...
  const before = await pool.query(
    `SELECT terminal_detail FROM ${schemas.pgbossier}.record WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  // ... induce another trigger fire ...
  const after = await pool.query(
    `SELECT terminal_detail FROM ${schemas.pgbossier}.record WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  expect(after.rows[0].terminal_detail).toEqual(before.rows[0].terminal_detail);
});
```

- [ ] **Step 2: Add a static check (optional but cheap)**

A simple SQL parse of the trigger definition asserting `terminal_detail` is not in the `DO UPDATE SET` clause. Less reliable than the runtime test but catches the failure mode at install time:

```ts
it('capture trigger SQL does not list terminal_detail in DO UPDATE SET', async () => {
  const { rows } = await pool.query(
    `SELECT pg_get_functiondef(oid) AS def
     FROM pg_proc WHERE proname = $1`,
    ['pgbossier_capture_fn'], // or whatever the function name is
  );
  expect(rows[0].def).not.toMatch(/SET[^;]*terminal_detail/i);
});
```

(Adjust function/trigger name to match `src/sql.ts`.)

- [ ] **Step 3: Lint + build + test green**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 4: Commit**

```bash
git add test/capture.test.ts
git commit -m "test(capture): lock in terminal_detail preservation across trigger fires"
```

---

## Task 8 — Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`

**Goal:** Ship the user-facing documentation. README is the discoverability surface; CHANGELOG records the change under `[Unreleased]`; CLAUDE.md syncs the project-status paragraph and the goal-status table.

- [ ] **Step 1: README — add "Recording terminal detail" section**

Structure:

```markdown
## Recording terminal detail

After a worker finishes a job, pg-bossier lets you classify the outcome with structured detail. The `recordTerminalDetail` method writes a typed shape into the audit row's `terminal_detail` JSONB column.

\`\`\`ts
import { bossier } from 'pg-bossier';
const client = bossier({ boss, pool });

// Inside a worker handler:
try {
  // ... do work ...
  await boss.complete(jobId, output);
  await client.recordTerminalDetail(jobId, attempt, {
    state: 'completed',
    detail: { duration_ms: 42 },
  });
} catch (err) {
  await boss.fail(jobId, err);
  await client.recordTerminalDetail(jobId, attempt, {
    state: 'failed',
    detail: {
      class: isRateLimit(err) ? 'transient' : 'non_retryable',
      message: String(err),
    },
  });
}
\`\`\`

### Shape

\`terminal_detail\` is discriminated by row \`state\`:

- \`state: 'failed'\` → \`{ class: 'transient' | 'non_retryable', message?, where?, ...anything else }\`. The \`class\` field is required. If you don't know, default to \`'non_retryable'\` (conservative: gives up rather than spinning) and put the reason in \`message\`.
- \`state: 'cancelled'\` → \`{ cancelledBy?, reason? }\` (open).
- \`state: 'completed'\` → any plain object (no shape enforcement).

### Retry interaction

If pg-boss is going to retry the job, the row at \`(jobId, attempt)\` transitions through \`state='retry'\`. \`recordTerminalDetail\` writes \`state: 'failed'\` regardless — the SQL writer maps \`'failed'\` to the allowed row states \`['failed', 'retry']\`. The detail stays attached to the original attempt's chronicle row.

### Upgrading to Goal 2 from earlier `0.x`

If you used \`recordPatch\` to write \`terminal_detail\` before Goal 2 shipped, run:

\`\`\`sql
UPDATE pgbossier.record SET terminal_detail = NULL;
\`\`\`

or \`DROP SCHEMA pgbossier CASCADE\` and reinstall. The new typed reader assumes \`terminal_detail\` rows conform to the discriminated union; legacy shapes would be silently misread. Per pg-bossier's \`0.x\` API instability policy, this manual step is acceptable.

\`recordPatch\` no longer accepts a \`terminal_detail\` field — TypeScript rejects it at compile time.
```

- [ ] **Step 2: CHANGELOG `[Unreleased]` entry**

Under `### Added` (or create the section if not present):

```markdown
- **Goal 2 — Terminal-state detail.** `client.recordTerminalDetail(jobId, attempt, payload)` writes a worker-classified failure shape (`class: 'transient' | 'non_retryable'` mandated on `failed`) to `pgbossier.record.terminal_detail`. Discriminated-union typed reader returns `TerminalDetailFailed | TerminalDetailCompleted | TerminalDetailCancelled | null` keyed on row state. `recordPatch` no longer accepts `terminal_detail` (single-writer convention). New public type exports: `TerminalDetail`, `TerminalDetailCompleted`, `TerminalDetailCancelled`, `TerminalDetailFailed`. Issue #3.
```

Under `### Changed`:

```markdown
- **`setProgress` error messages** — prefixed with `pg-bossier:` for consistency with the new `recordTerminalDetail` validator. External behavior unchanged; only the error message text shifted.
```

- [ ] **Step 3: CLAUDE.md sync**

Update the project-status paragraph to reflect Goal 2 delivered. Update the goal-status table row for Goal 2:

```markdown
| ✅ Terminal-state detail — `recordTerminalDetail({state, detail})` with state-bound SQL writer + retry-state reader narrowing _(done — issue #3 closed)_ | Goal 2 |
```

- [ ] **Step 4: Lint + build + test (docs touch shouldn't affect anything)**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs: README Recording terminal detail section + CHANGELOG/CLAUDE.md sync"
```

---

## Task 9 — Final verification + merge

**Files:** branch `feature/goal-2-terminal-state-detail`

**Goal:** Confirm green CI, prepare for `--no-ff` merge to `develop`.

- [ ] **Step 1: Full local CI run**

```bash
npm run lint && npm run build && npm test
```

Expected: every check passes. If anything fails, fix and re-commit before merging.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feature/goal-2-terminal-state-detail
```

- [ ] **Step 3: Verify remote CI**

Watch GitHub Actions for the branch. Expected: lint + build + test all green on `ubuntu-latest`, Node 22.

- [ ] **Step 4: Merge into `develop` with `--no-ff`**

From a `develop` checkout:

```bash
git checkout develop
git pull origin develop
git merge --no-ff feature/goal-2-terminal-state-detail
git push origin develop
```

- [ ] **Step 5: Close issue #3 with a comment linking the merge commit**

`gh issue close 3 --comment 'Delivered via <merge commit hash>. See CLAUDE.md goal-status table.'`

- [ ] **Step 6: Clean up the worktree**

From the main checkout:

```bash
git worktree remove .worktrees/feature-goal-2-terminal-state-detail
git branch -d feature/goal-2-terminal-state-detail
```

---

## Verification

After all tasks land on `develop`:

- [ ] `npm run lint && npm run build && npm test` all green on `develop`.
- [ ] Issue #3 closed.
- [ ] CLAUDE.md project-status paragraph reflects Goal 2 delivered.
- [ ] CHANGELOG.md `[Unreleased]` has the Goal 2 entry.
- [ ] `recordTerminalDetail` is callable from a Node REPL via the public package surface (smoke-check via the existing CI consumer-artifact test from Goal 9).
- [ ] Adversarial-review folder remains at `docs/superpowers/debates/2026-05-23-goal-2-spec-adversarial-review/` for the record.

---

## Out-of-scope items (named here so adversarial review of the plan can flag if any creep back in)

These were named out-of-scope in the v2 spec and should NOT appear in the implementation:

1. `expired` / `superseded` derivation — no trigger change, no reader-side derivation.
2. SQL CHECK constraint on `terminal_detail` — no migration adding constraints.
3. Append-only audit table — no schema change.
4. `Job<TInput, TOutput>` generic — no new generics on `JobRecord` or `recordTerminalDetail`.
5. Worker-helper classification utilities — no `classify(err)` shipped.
6. Backfill of pre-Goal-2 `recordPatch` data — README documents the manual upgrade; no automated migration.

If any of these slip into a task during implementation, stop and reconcile with the spec before proceeding.

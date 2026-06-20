# Goal 3 Retry-History / DLQ-Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pg-bossier Goal 3 — DLQ-source lineage per the v2 spec. Adds `bossier.recordDeadLetter`, `findDeadLetterSource`, and `findDeadLetterTarget` to the unified client; updates Goal 2's `recordTerminalDetail` SQL to use JSONB merge (`||`) so the two writers cooperate at the key level; adds `deadLetteredAs?: string` to `TerminalDetailFailed`. No schema change. No new pg-boss surface.

**Architecture:** A new module `src/dead-letter.ts` exports the writer + readers. The writer finds the source's most-recent `failed` row by `(jobId, ORDER BY attempt DESC LIMIT 1)`, runs a conflict-aware UPDATE that writes only when no existing `deadLetteredAs` is present (or the existing value matches), and JSONB-merges `{deadLetteredAs: $2}` into `terminal_detail`. The reverse reader (`findDeadLetterSource`) queries via the existing GIN index with defensive `ORDER BY captured_at DESC`. The forward reader (`findDeadLetterTarget`) reads `terminal_detail->>'deadLetteredAs'` from the source row directly. Goal 2's writer in `src/terminal-detail.ts` is patched to use `COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb` — this is the OPTION-A fix from the adversarial review and is required for the composition story to be correct.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Node 18.3+, ESM, `pg`, vitest + `@testcontainers/postgresql`, pg-boss 12.18.2.

**Spec:** [`docs/superpowers/specs/2026-05-24-goal-3-retry-history-lineage-design.md`](../specs/2026-05-24-goal-3-retry-history-lineage-design.md) (v2)
**Adversarial review:** [`docs/superpowers/debates/2026-05-24-goal-3-retry-history-lineage/`](../debates/2026-05-24-goal-3-retry-history-lineage/) — synthesis at `99-synthesis.md`. Prior debate archived at `2026-05-24-goal-3-retry-history-lineage-v0-prior/`.
**Charter:** [`CLAUDE.md`](../../../CLAUDE.md) — feature branches via `git worktree`; `--no-ff` merge into `develop`; CHANGELOG under `[Unreleased]`; lint + build + test must all pass before claiming done.

---

## File map (locked before tasks)

**New files**
- `src/dead-letter.ts` — exports `recordDeadLetter`, plus the SQL constants the readers use. ~80 LOC.
- `test/dead-letter.test.ts` — integration tests for write + reverse-read + forward-read + composition + idempotency + chained DLQ (9 scenarios from the spec).

**Modified files**
- `src/terminal-detail.ts` — change line 100 UPDATE SQL to use `COALESCE(...) || $4::jsonb` merge (OPTION-A fix); add `deadLetteredAs?: string` to `TerminalDetailFailed`.
- `src/read.ts` — add `findDeadLetterSource` and `findDeadLetterTarget` free functions; both return new typed shapes.
- `src/client.ts` — add `recordDeadLetter`, `findDeadLetterSource`, `findDeadLetterTarget` to `BossierMethods`; extend the proxy collision-check allow-list.
- `src/index.ts` — re-export the new method types if any are public-facing (none are at the moment — just method signatures).
- `test/terminal-detail.test.ts` — update test 8 (concurrent calls "last-writer-wins" semantic) to assert KEY-LEVEL merge instead of full-object overwrite. This is the only existing test affected by the OPTION-A change.
- `test/read.test.ts` — extend with reader tests if helpful; main coverage lives in `test/dead-letter.test.ts`.
- `test/client.test.ts` — smoke test that the new proxy methods work via `client.*`.
- `README.md` — new "Recording dead-letter lineage" section with the `_originalJobId` consumer contract surfaced explicitly.
- `CHANGELOG.md` — `[Unreleased]` entry.
- `CLAUDE.md` — project-status paragraph + goal-status table sync.
- `COMPATIBILITY.md` — one-line note confirming no new pg-boss surface.

**Decomposition principle.** The OPTION-A fix to Goal 2's writer is the load-bearing prerequisite — Task 1 does ONLY that, validates Goal 2's tests still pass under the new semantic, and is reviewable as a focused change. Then the new module + readers + proxy wiring follow in TDD order. Integration tests close the loop; docs ship last.

---

## Task 0 — Worktree, branch, baseline

**Files:** `.worktrees/feature-goal-3-retry-history-lineage/` (gitignored)

- [ ] **Step 1: Create the worktree off `develop`**

```bash
git worktree add .worktrees/feature-goal-3-retry-history-lineage \
  -b feature/goal-3-retry-history-lineage develop
```

- [ ] **Step 2: Install deps + verify baseline is green**

```bash
cd .worktrees/feature-goal-3-retry-history-lineage
npm install
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` clean, all 163 existing tests pass.

---

## Task 1 — Fix Goal 2's writer to use JSONB merge (OPTION-A)

**Files:**
- Modify: `src/terminal-detail.ts`
- Modify: `test/terminal-detail.test.ts`

**Goal:** Change the existing `recordTerminalDetail` SQL from `SET terminal_detail = $4::jsonb` (blind overwrite) to `SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb` (key-level merge). This is the OPTION-A fix from the adversarial review; everything in Task 3+ depends on it being right.

This task does NOT add `deadLetteredAs` to the type yet (that's Task 2). It does NOT add the new writer/readers (Tasks 3-4). It is a surgical fix-and-test-update that ships green on its own.

- [ ] **Step 1: Read existing test 8 in `test/terminal-detail.test.ts` to understand the current "last-writer-wins" assertion.**

Search for "last-writer-wins" or "concurrent calls" or "sequential calls". The current test asserts the second call's full payload replaces the first. After Task 1, that assertion must change.

- [ ] **Step 2: Update existing test 8 (concurrent / sequential calls) to assert KEY-LEVEL merge.**

Concrete behavior after the change:

```ts
// First call writes {class: 'transient', message: 'attempt 1'}
await recordTerminalDetail(pool, schemas, jobId, 0, {
  state: 'failed', detail: { class: 'transient', message: 'attempt 1' }
});

// Second call writes {message: 'attempt 2'} (no class field)
await recordTerminalDetail(pool, schemas, jobId, 0, {
  state: 'failed', detail: { class: 'transient', message: 'attempt 2' }
});
// (Note: must include 'class' because the validator requires it on failed payloads.)

// After OPTION-A: row's terminal_detail = {class: 'transient', message: 'attempt 2'}
// The class key survives (overlapping; second call's value wins);
// message key was overwritten (overlapping; second call's value wins).
```

Add a NEW test specifically for the key-level merge behavior:

```ts
test('recordTerminalDetail merges keys; non-overlapping keys from prior calls survive', async () => {
  // Use 'cancelled' state to avoid the class-required validator
  await recordTerminalDetail(pool, schemas, jobId, 0, {
    state: 'cancelled', detail: { cancelledBy: 'user-A', reason: 'oops' }
  });
  await recordTerminalDetail(pool, schemas, jobId, 0, {
    state: 'cancelled', detail: { reason: 'corrected reason' }
  });
  const job = await findById(pool, schemas, jobId);
  expect(job?.terminalDetail).toEqual({
    cancelledBy: 'user-A',       // key from first call survives
    reason: 'corrected reason',  // key was overwritten
  });
});
```

This locks in the OPTION-A semantic.

- [ ] **Step 3: Modify `src/terminal-detail.ts` line 100 SQL.**

Change:

```ts
SET terminal_detail = $4::jsonb
```

to:

```ts
SET terminal_detail = COALESCE(terminal_detail, '{}'::jsonb) || $4::jsonb
```

That's the only line that changes. The `state = ANY($3::text[])` clause, the validators, the param shape — all unchanged.

- [ ] **Step 4: Run terminal-detail tests; verify the updated test 8 + new merge test pass.**

```bash
npm test -- test/terminal-detail.test.ts
```

If any other test fails, it likely asserted the now-changed semantic and needs the same key-level treatment. Update minimally.

- [ ] **Step 5: Run the full suite.**

```bash
npm run lint && npm run build && npm test
```

Expected: 163 baseline + maybe one new test = 164. Clean lint + build.

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(terminal-detail): use JSONB merge to preserve concurrent writer fields"
```

The message is intentionally OPTION-A-flavored (this is a behavior fix, not a Goal-3 feature).

---

## Task 2 — Add `deadLetteredAs?: string` to `TerminalDetailFailed`

**Files:**
- Modify: `src/terminal-detail.ts`
- Modify: `test/read.test.ts` (if there's a narrowing fixture; add the new field to assertions if needed)

**Goal:** Add the named optional field to the discriminated-union type. After this, TypeScript callers see `deadLetteredAs` as a documented string field rather than coming through `Record<string, unknown>`.

- [ ] **Step 1: Edit `src/terminal-detail.ts` lines 27–31.**

Current:

```ts
export type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
} & Record<string, unknown>;
```

After:

```ts
export type TerminalDetailFailed = {
  class: 'transient' | 'non_retryable';
  message?: string;
  where?: string;
  deadLetteredAs?: string;
} & Record<string, unknown>;
```

- [ ] **Step 2: If `test/read.test.ts` has a narrowing fixture that asserts specific fields on `TerminalDetailFailed`, extend it with a check that `deadLetteredAs` narrows to `string | undefined`.**

Cheap compile-time guard.

- [ ] **Step 3: Verify lint + build + test all clean.**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(terminal-detail): add optional deadLetteredAs field to TerminalDetailFailed"
```

---

## Task 3 — Create `src/dead-letter.ts` with `recordDeadLetter` (TDD)

**Files:**
- New: `src/dead-letter.ts`
- New: `test/dead-letter.test.ts`

**Goal:** The new writer. The function takes `{ sourceJobId, dlqJobId }` and either writes the `deadLetteredAs` link onto the source's last `failed` row, or no-ops fail-open. It also handles the conflicting-second-call case (existing link with different `dlqJobId` → log warning + no-op).

- [ ] **Step 1: Read `src/terminal-detail.ts` and `src/progress.ts` to confirm the module patterns used (imports, SchemaNames argument shape, fail-open logging style).**

The new module follows the same shape. Free function with `(pool, schemas, ...args)` signature; the client wraps it in Task 5.

- [ ] **Step 2: Write `test/dead-letter.test.ts` with the spec's scenarios 1–7 first.**

Tests in `test/dead-letter.test.ts`:

1. **Happy round-trip.** Send → fail → recordDeadLetter → reader returns source.
2. **Source row not found.** `recordDeadLetter` with non-existent `sourceJobId` resolves silently; warning logged with `reason: 'not_found'`. (Use a console spy or test logger.)
3. **Conflicting second call.** `recordDeadLetter(A, X)` then `recordDeadLetter(A, Y)` → row's `deadLetteredAs = X` (first wins); warning logged.
4. **Idempotent same-id call.** `recordDeadLetter(A, X)` twice → row's `deadLetteredAs = X`; no warning.
5. **Composition with `recordTerminalDetail` (terminal-detail-first order).** Call recordTerminalDetail with `{class: 'transient', message: '...'}`, then `recordDeadLetter`. Reader returns merged JSONB with both keys present.
6. **Composition with `recordTerminalDetail` (deadLetter-first order).** Call `recordDeadLetter` first, then `recordTerminalDetail`. Reader returns merged JSONB. `deadLetteredAs` survives. (This is the test that specifically locks the OPTION-A fix.)
7. **Concurrent writes don't race destructively.** Two concurrent UPDATEs (one from each writer). Final row has BOTH fields. JSONB `||` is atomic per UPDATE.

Run: `npm test -- test/dead-letter.test.ts`. All 7 fail (the module doesn't exist).

- [ ] **Step 3: Implement `src/dead-letter.ts`.**

```ts
import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';

export interface RecordDeadLetterArgs {
  sourceJobId: string;
  dlqJobId: string;
}

export async function recordDeadLetter(
  pool: Pool,
  schemas: SchemaNames,
  args: RecordDeadLetterArgs,
): Promise<void> {
  const { sourceJobId, dlqJobId } = args;

  // Validate inputs (basic shape — full UUID validation is overkill for fail-open).
  if (typeof sourceJobId !== 'string' || sourceJobId.length === 0) {
    throw new Error(
      'pg-bossier: recordDeadLetter validation: sourceJobId must be a non-empty string',
    );
  }
  if (typeof dlqJobId !== 'string' || dlqJobId.length === 0) {
    throw new Error(
      'pg-bossier: recordDeadLetter validation: dlqJobId must be a non-empty string',
    );
  }

  try {
    const { rowCount } = await pool.query(
      `
      WITH target AS (
        SELECT job_id, attempt, terminal_detail
        FROM ${schemas.pgbossier}.record
        WHERE job_id = $1 AND state = 'failed'
        ORDER BY attempt DESC
        LIMIT 1
      ), should_write AS (
        SELECT job_id, attempt FROM target
        WHERE terminal_detail IS NULL
           OR NOT (terminal_detail ? 'deadLetteredAs')
           OR terminal_detail->>'deadLetteredAs' = $2
      )
      UPDATE ${schemas.pgbossier}.record r
      SET terminal_detail = COALESCE(r.terminal_detail, '{}'::jsonb)
                          || jsonb_build_object('deadLetteredAs', $2::text)
      FROM should_write w
      WHERE r.job_id = w.job_id AND r.attempt = w.attempt
      `,
      [sourceJobId, dlqJobId],
    );

    if (rowCount === 0) {
      // Either: (a) no failed row for sourceJobId, or (b) existing deadLetteredAs differs.
      // Distinguish by a follow-up SELECT — cheap.
      const { rows } = await pool.query<{ existing: string | null }>(
        `SELECT terminal_detail->>'deadLetteredAs' AS existing
           FROM ${schemas.pgbossier}.record
          WHERE job_id = $1 AND state = 'failed'
          ORDER BY attempt DESC
          LIMIT 1`,
        [sourceJobId],
      );
      if (rows.length === 0) {
        console.warn(
          `pgbossier: recordDeadLetter no failed row for source ${sourceJobId} reason: not_found`,
        );
      } else if (rows[0].existing !== null && rows[0].existing !== dlqJobId) {
        console.warn(
          `pgbossier: recordDeadLetter conflicting existing link for source ${sourceJobId}: existing=${rows[0].existing}, new=${dlqJobId} — first link wins reason: conflict`,
        );
      }
      // Otherwise: rare race, no-op without warning is acceptable.
    }
  } catch (err) {
    console.warn(`pgbossier: recordDeadLetter failed for source ${sourceJobId}: ${String(err)} reason: db_error`);
  }
}
```

Run: `npm test -- test/dead-letter.test.ts`. All 7 pass.

- [ ] **Step 4: Lint + build green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(dead-letter): add recordDeadLetter with conflict-aware JSONB merge"
```

---

## Task 4 — Add `findDeadLetterSource` + `findDeadLetterTarget` to `src/read.ts`

**Files:**
- Modify: `src/read.ts`
- Modify: `test/dead-letter.test.ts` (extend)

**Goal:** Two new readers. Reverse direction (DLQ id → source) is must-land; forward direction (source id → DLQ) is should-land. Both ship in this task.

- [ ] **Step 1: Add scenarios 8–9 to `test/dead-letter.test.ts` (TDD-first).**

8. `findDeadLetterSource(dlqJobId)` returns `{jobId, attempt, queue}` for a written link; returns `null` for an unlinked DLQ id.
9. `findDeadLetterTarget(sourceJobId)` returns `{dlqJobId, attempt}` for a written link; returns `null` for an unlinked source.

Plus the chained-DLQ test (spec test 7):

10. Set up A→B→C chains. `findDeadLetterSource(C)` returns B's row; `findDeadLetterSource(B)` returns A's row; `findDeadLetterTarget(A)` returns `{dlqJobId: B, ...}`; `findDeadLetterTarget(B)` returns `{dlqJobId: C, ...}`.

Run: `npm test -- test/dead-letter.test.ts -t "findDeadLetter"`. Tests 8, 9, 10 fail.

- [ ] **Step 2: Add `findDeadLetterSource` and `findDeadLetterTarget` to `src/read.ts`.**

```ts
export async function findDeadLetterSource(
  pool: Pool,
  schemas: SchemaNames,
  dlqJobId: string,
): Promise<{ jobId: string; attempt: number; queue: string } | null> {
  const { rows } = await pool.query<{ jobId: string; attempt: number; queue: string }>(
    `SELECT job_id AS "jobId", attempt, queue
       FROM ${schemas.pgbossier}.record
      WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text)
      ORDER BY captured_at DESC
      LIMIT 1`,
    [dlqJobId],
  );
  return rows[0] ?? null;
}

export async function findDeadLetterTarget(
  pool: Pool,
  schemas: SchemaNames,
  sourceJobId: string,
): Promise<{ dlqJobId: string; attempt: number } | null> {
  const { rows } = await pool.query<{ dlqJobId: string; attempt: number }>(
    `SELECT terminal_detail->>'deadLetteredAs' AS "dlqJobId", attempt
       FROM ${schemas.pgbossier}.record
      WHERE job_id = $1
        AND state = 'failed'
        AND terminal_detail ? 'deadLetteredAs'
      ORDER BY attempt DESC
      LIMIT 1`,
    [sourceJobId],
  );
  return rows[0] ?? null;
}
```

Run tests; all pass.

- [ ] **Step 3: EXPLAIN ANALYZE check (spec test 9).**

Add a small test that asserts `findDeadLetterSource`'s plan uses the GIN index:

```ts
test('findDeadLetterSource uses the terminal_detail GIN index', async () => {
  const { rows } = await h.pool.query<{ plan: string }>(
    `EXPLAIN (FORMAT TEXT)
     SELECT job_id FROM ${SCHEMAS.pgbossier}.record
     WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text)
     LIMIT 1`,
    ['00000000-0000-0000-0000-000000000000'],
  );
  const plan = rows.map(r => r.plan).join('\n');
  expect(plan).toMatch(/record_terminal_detail_gin/i);
});
```

(Adjust index name if `src/sql.ts` uses a different one.)

- [ ] **Step 4: Lint + build + test green.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(read): add findDeadLetterSource + findDeadLetterTarget readers"
```

---

## Task 5 — Wire the three methods onto the `bossier` client proxy

**Files:**
- Modify: `src/client.ts`
- Modify: `test/client.test.ts`

**Goal:** Make `client.recordDeadLetter(...)`, `client.findDeadLetterSource(...)`, `client.findDeadLetterTarget(...)` callable via the unified `bossier()` proxy.

- [ ] **Step 1: Read `src/client.ts` to find the `BossierMethods` interface and the runtime `methods` object pattern.**

Goal 2 added `recordTerminalDetail` the same way (see commit `bd1397e`).

- [ ] **Step 2: Add the three methods to `BossierMethods` + the runtime methods object.**

```ts
// In BossierMethods (interface):
recordDeadLetter(args: { sourceJobId: string; dlqJobId: string }): Promise<void>;
findDeadLetterSource(dlqJobId: string): Promise<{ jobId: string; attempt: number; queue: string } | null>;
findDeadLetterTarget(sourceJobId: string): Promise<{ dlqJobId: string; attempt: number } | null>;

// In the runtime methods object (within bossier()):
recordDeadLetter: (args) => recordDeadLetter(pool, s, args),
findDeadLetterSource: (id) => findDeadLetterSource(pool, s, id),
findDeadLetterTarget: (id) => findDeadLetterTarget(pool, s, id),
```

Plus the imports at the top of `src/client.ts`.

- [ ] **Step 3: Update the collision-test allow-list in `test/client.test.ts`.**

The existing test asserts pg-bossier's method names don't collide with `PgBoss.prototype`. Add the three new names.

- [ ] **Step 4: Add a smoke test verifying the proxy method works end-to-end.**

```ts
test('client.recordDeadLetter + findDeadLetterSource via the proxy', async () => {
  const client = bossier({ boss, pool });
  // Send + fail a job
  // Send a DLQ job
  // Call client.recordDeadLetter and client.findDeadLetterSource
  // Assert the returned source matches
});
```

- [ ] **Step 5: Lint + build + test green.**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(client): expose recordDeadLetter + findDeadLetter* on the bossier proxy"
```

---

## Task 6 — Documentation

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `CLAUDE.md`
- Modify: `COMPATIBILITY.md`

**Goal:** Surface-level documentation for the new methods, the `_originalJobId` consumer contract, and the Goal 2 writer semantic change. CHANGELOG + project docs sync.

### 1. README — "Recording dead-letter lineage" section

Add after Goal 2's "Recording terminal detail" section. Cover:

- The flow (intro paragraph).
- **The `_originalJobId` consumer contract** (named, surface-level — not buried). Example showing `boss.send` and `boss.work` patterns.
- Code example with `recordDeadLetter` + `findDeadLetterSource` + `findDeadLetterTarget`.
- Idempotency contract (idempotent same-id; conflicting second call is a no-op + warning).
- The composition note: `recordTerminalDetail` and `recordDeadLetter` cooperate (key-level merge in `terminal_detail`).
- The "What does NOT change" notes: `progress` is not copied source→DLQ; `boss.retry(dlqJobId)` doesn't disturb the existing link.

### 2. CHANGELOG.md `[Unreleased]` entry

Under `### Added`:

```markdown
- **Goal 3 — Retry history / DLQ lineage.** `client.recordDeadLetter({sourceJobId, dlqJobId})` records a source→DLQ link in `terminal_detail.deadLetteredAs` JSONB on the source's last `failed` row. `client.findDeadLetterSource(dlqJobId)` returns `{jobId, attempt, queue}` of the source. `client.findDeadLetterTarget(sourceJobId)` returns `{dlqJobId, attempt}`. Consumer is responsible for preserving the source id on the DLQ job's `data` payload (typically `data._originalJobId`). Issue #4.
```

Under `### Changed`:

```markdown
- **`recordTerminalDetail` (Goal 2) now uses JSONB merge.** The internal `UPDATE` writes `COALESCE(terminal_detail, '{}'::jsonb) || $payload` instead of the prior `SET terminal_detail = $payload` overwrite. This is the prerequisite for `recordDeadLetter` to cooperate; the new semantic is key-level (a second call's keys overwrite same-keyed values; non-overlapping keys from prior calls survive). External behavior change: a call to `recordTerminalDetail` that previously would have wiped out a prior call's keys now preserves them.
```

### 3. CLAUDE.md sync

Update project-status paragraph; tick Goal 3 in the goal-status table:

```markdown
| ✅ Retry history — `recordDeadLetter({sourceJobId, dlqJobId})` + `findDeadLetterSource` + `findDeadLetterTarget`; trigger-detection impossibility verified; OPTION-A fix to Goal 2's writer enables composition _(done — issue #4 closed)_ | Goal 3 |
```

### 4. COMPATIBILITY.md

Add a sentence under "What pg-bossier surfaces are scoped per goal":

```markdown
- Goal 3 adds no new pg-boss surface. The writer reads/writes only `pgbossier.record`. (Future trigger-based DLQ detection would read `pgboss.queue.dead_letter`, but the trigger is not modified.)
```

- [ ] **Verify lint + build + test (docs touch should be a no-op for code checks).**

- [ ] **Commit**

```bash
git commit -m "docs: README Recording dead-letter lineage section + CHANGELOG/CLAUDE.md/COMPATIBILITY.md sync"
```

---

## Task 7 — Final verification + merge

**Files:** branch `feature/goal-3-retry-history-lineage`

- [ ] **Step 1: Full local CI gate**

```bash
npm run lint && npm run build && npm test
```

Expected: clean. Test count: 163 baseline + ~10 new = ~173.

- [ ] **Step 2: Push branch**

```bash
git push -u origin feature/goal-3-retry-history-lineage
```

- [ ] **Step 3: Merge into develop**

From a `develop` checkout:

```bash
git checkout develop && git pull origin develop
git merge --no-ff feature/goal-3-retry-history-lineage
git push origin develop
```

- [ ] **Step 4: Wait for develop CI green**

```bash
gh run watch <run-id> --exit-status
```

- [ ] **Step 5: Close issue #4**

```bash
gh issue close 4 --comment "Delivered via merge commit <hash> on develop. ..."
```

- [ ] **Step 6: Clean up worktree**

```bash
git worktree remove .worktrees/feature-goal-3-retry-history-lineage
git branch -d feature/goal-3-retry-history-lineage
git push origin --delete feature/goal-3-retry-history-lineage
```

---

## Verification

After all tasks land on `develop`:

- [ ] `npm run lint && npm run build && npm test` all green on `develop`.
- [ ] Issue #4 closed.
- [ ] CLAUDE.md project-status paragraph reflects Goal 3 delivered.
- [ ] CHANGELOG.md `[Unreleased]` has Goal 3 entries (Added + Changed).
- [ ] Goal 2's tests still pass under the new key-level merge semantic.
- [ ] `recordDeadLetter` and `findDeadLetter*` callable via the public package surface.
- [ ] Adversarial-review folder remains at `docs/superpowers/debates/2026-05-24-goal-3-retry-history-lineage/`.

---

## Out-of-scope items (named here so adversarial review of the plan can flag if any creep back in)

These were named out-of-scope in the v2 spec and should NOT appear in the implementation:

1. Schema column `dead_letter_source_id` — rejected, no reliable population mechanism.
2. Separate link table — rejected for the same reason.
3. Reserved data-key convention (`_pgbossier_source_id` auto-derivation) — rejected.
4. Statement-level after-trigger correlation — impossible.
5. Capturing `singleton_key` as a plain column — separate issue.
6. Skipping housekeeping-only UPDATEs in the trigger — under #21.
7. Plural `deadLetteredAs` (`string[]`) — 3-of-3 settled on 1:1.
8. Lineage-integrity diagnostic — future ops tool, separate issue.
9. Chained-DLQ traversal helper — nice-to-have, defer.
10. `bossier.send()` wrapper that auto-injects `_originalJobId` — future ergonomic improvement.

If any of these slip into a task during implementation, stop and reconcile with the spec before proceeding.

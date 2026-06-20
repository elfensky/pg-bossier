# pg-bossier Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build pg-bossier's storage substrate — the `pgbossier.record` table, the `pgboss.job` capture trigger, `install` / `uninstall`, install-time backfill, and the app-hook client skeleton. This is the first feature code in the repo.

**Architecture:** A Postgres trigger on `pgboss.job` mirrors every job state change into `pgbossier.record` (one row per `(job_id, attempt)`); an app-hook wrapping client owns the three pg-bossier-only columns. All pg-boss behavior verified against pg-boss 12.18.2. Full design: `docs/superpowers/specs/2026-05-20-substrate-spec.md`.

**Tech Stack:** TypeScript (strict, ESM, `NodeNext`) · `pg` (Postgres client) · `vitest` (test runner) · `@testcontainers/postgresql` (ephemeral Postgres for integration tests) · pg-boss 12.18.2.

---

## Before you start

- **Work on a branch, never `main`.** Per `CLAUDE.md`, create a worktree first:
  `git worktree add .worktrees/feat-substrate -b feat/substrate`, then `cd` into it and `npm install`. Every commit in this plan lands on `feat/substrate`.
- **These are integration tests against a real Postgres + pg-boss** (via testcontainers) — the substrate spec forbids mocks. They need Docker running. They are slow (~10–30s container startup per file); the `vitest` config below sets generous timeouts.
- **All SQL is lifted verbatim from the substrate spec** (`docs/superpowers/specs/2026-05-20-substrate-spec.md`) — it was verified against pg-boss 12.18.2.
- Run `npm run lint && npm run build` before the final task's commit.

## File structure

| Path | Created/Modified | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `vitest` / testcontainers / `pg` dev+peer deps; add `test` script |
| `vitest.config.ts` | Create | vitest config — long timeouts for containers |
| `test/harness.ts` | Create | Spin up Postgres + pg-boss; `getRecord` query helper |
| `test/smoke.test.ts` | Create | Proves vitest runs |
| `test/harness.test.ts` | Create | Proves the Postgres+pg-boss harness works |
| `test/install.test.ts` | Create | `install()` creates schema/table/indexes/trigger |
| `test/capture.test.ts` | Create | Trigger captures create/active/complete, retries, ignores `touch` |
| `test/backfill.test.ts` | Create | `install()` backfills pre-existing `pgboss.job` rows |
| `test/uninstall.test.ts` | Create | `uninstall()` removes everything cleanly |
| `test/client.test.ts` | Create | App-hook client skeleton |
| `src/sql.ts` | Create | SQL string constants (DDL, trigger, backfill) |
| `src/install.ts` | Create | `install(pool)` / `uninstall(pool)` |
| `src/record.ts` | Create | `RecordRow` type, `recordPatch()` app-hook helper |
| `src/client.ts` | Create | `bossier()` wrapping client skeleton |
| `src/index.ts` | Modify | Replace the placeholder with the public exports |

---

### Task 1: Scaffold the vitest toolchain

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `test/smoke.test.ts`

- [ ] **Step 1: Add dev dependencies and the test script**

Run:
```bash
npm install --save-dev vitest @testcontainers/postgresql pg @types/pg pg-boss@12.18.2
```

Then add a `test` script to `package.json`'s `"scripts"` block:
```json
"test": "vitest run"
```

Then ensure `package.json`'s `peerDependencies` lists both `pg-boss` (`12.18.2`) and `pg` — pg-bossier's `install(pool)` and `bossier()` client take a `pg.Pool` the consumer supplies, so `pg` is a peer dependency; add it if missing. The `--save-dev` installs above are what make both available to the integration tests.

- [ ] **Step 2: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
```

`fileParallelism: false` — each test file starts its own Postgres container; running them serially keeps Docker resource use bounded.

- [ ] **Step 3: Create `test/smoke.test.ts`**

```typescript
import { test, expect } from 'vitest';

test('vitest runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Run the smoke test**

Run: `npm test`
Expected: PASS — `1 passed`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts test/smoke.test.ts
git commit -m "test: scaffold vitest toolchain"
```

---

### Task 2: Postgres + pg-boss integration harness

**Files:**
- Create: `test/harness.ts`
- Create: `test/harness.test.ts`

- [ ] **Step 1: Write the failing harness test**

`test/harness.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('harness brings up Postgres with the pgboss schema', async () => {
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job'`,
  );
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/harness.test.ts`
Expected: FAIL — cannot resolve `./harness.js`.

- [ ] **Step 3: Write `test/harness.ts`**

```typescript
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import PgBoss from 'pg-boss';
import pg from 'pg';

export interface Harness {
  pool: pg.Pool;
  boss: PgBoss;
  teardown: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  const boss = new PgBoss(connectionString);
  await boss.start(); // creates the pgboss schema and tables
  const pool = new pg.Pool({ connectionString });
  return {
    pool,
    boss,
    teardown: async () => {
      await pool.end();
      await boss.stop();
      await container.stop();
    },
  };
}

export interface RecordRow {
  job_id: string;
  queue: string;
  attempt: number;
  state: string;
  data: unknown;
  output: unknown;
  progress: unknown;
  terminal_detail: unknown;
  input_snapshot: unknown;
  created_on: Date | null;
  started_on: Date | null;
  completed_on: Date | null;
  captured_at: Date;
}

export async function getRecords(pool: pg.Pool, jobId: string): Promise<RecordRow[]> {
  const { rows } = await pool.query<RecordRow>(
    `SELECT * FROM pgbossier.record WHERE job_id = $1 ORDER BY attempt`,
    [jobId],
  );
  return rows;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/harness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/harness.ts test/harness.test.ts
git commit -m "test: add Postgres + pg-boss integration harness"
```

---

### Task 3: `install()` — schema, table, indexes

**Files:**
- Create: `src/sql.ts`
- Create: `src/install.ts`
- Create: `test/install.test.ts`

- [ ] **Step 1: Write the failing install test**

`test/install.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('install creates the pgbossier.record table with all 13 columns', async () => {
  const { rows } = await h.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  const cols = rows.map((r) => r.column_name).sort();
  expect(cols).toEqual(
    ['attempt', 'captured_at', 'completed_on', 'created_on', 'data', 'input_snapshot',
     'job_id', 'output', 'progress', 'queue', 'started_on', 'state', 'terminal_detail'],
  );
});

test('install creates the five record indexes', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  const idx = rows.map((r) => r.indexname);
  for (const name of ['record_pkey', 'record_queue_state_idx', 'record_captured_at_idx',
                       'record_data_gin', 'record_output_gin', 'record_terminal_detail_gin']) {
    expect(idx).toContain(name);
  }
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/install.test.ts`
Expected: FAIL — cannot resolve `../src/install.js`.

- [ ] **Step 3: Create `src/sql.ts` (schema, table, indexes)**

```typescript
export const SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS pgbossier;`;

export const RECORD_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pgbossier.record (
  job_id          uuid        NOT NULL,
  queue           text        NOT NULL,
  attempt         integer     NOT NULL,
  state           text        NOT NULL,
  data            jsonb,
  output          jsonb,
  progress        jsonb,
  terminal_detail jsonb,
  input_snapshot  jsonb,
  created_on      timestamptz,
  started_on      timestamptz,
  completed_on    timestamptz,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt)
);`;

export const RECORD_INDEXES_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON pgbossier.record (queue, state);`,
  `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON pgbossier.record (captured_at);`,
  `CREATE INDEX IF NOT EXISTS record_data_gin            ON pgbossier.record USING gin (data);`,
  `CREATE INDEX IF NOT EXISTS record_output_gin          ON pgbossier.record USING gin (output);`,
  `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON pgbossier.record USING gin (terminal_detail);`,
];
```

- [ ] **Step 4: Create `src/install.ts`**

```typescript
import type { Pool } from 'pg';
import { SCHEMA_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL } from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(RECORD_TABLE_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -- test/install.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts src/install.ts test/install.test.ts
git commit -m "feat: install() creates pgbossier.record table and indexes"
```

---

### Task 4: `install()` — the capture trigger

**Files:**
- Modify: `src/sql.ts`
- Modify: `src/install.ts`
- Modify: `test/install.test.ts`

- [ ] **Step 1: Add the failing trigger assertion**

Append to `test/install.test.ts`:
```typescript
test('install creates the pgbossier_capture trigger on pgboss.job', async () => {
  const { rows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'pgboss.job'::regclass AND NOT tgisinternal`,
  );
  expect(rows.map((r) => r.tgname)).toContain('pgbossier_capture');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/install.test.ts`
Expected: FAIL — `pgbossier_capture` not found.

- [ ] **Step 3: Add the trigger SQL to `src/sql.ts`**

Append to `src/sql.ts`:
```typescript
export const CAPTURE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now())
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      captured_at  = EXCLUDED.captured_at;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;`;

export const CAPTURE_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;
CREATE TRIGGER pgbossier_capture
  AFTER INSERT OR UPDATE OF state ON pgboss.job
  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();`;
```

- [ ] **Step 4: Run the function + trigger SQL in `install()`**

In `src/install.ts`, update the import and append two statements:
```typescript
import type { Pool } from 'pg';
import {
  SCHEMA_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL,
} from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(RECORD_TABLE_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
  await pool.query(CAPTURE_FUNCTION_SQL);
  await pool.query(CAPTURE_TRIGGER_SQL);
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -- test/install.test.ts`
Expected: PASS — all three tests green.

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts src/install.ts test/install.test.ts
git commit -m "feat: install() creates the pgboss.job capture trigger"
```

---

### Task 5: Capture — create, active, complete, cancel

**Files:**
- Create: `test/capture.test.ts`

- [ ] **Step 1: Write the failing capture test**

`test/capture.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('send -> fetch -> complete is mirrored into pgbossier.record', async () => {
  const queue = 'cap-complete';
  await h.boss.createQueue(queue);

  const jobId = await h.boss.send(queue, { hello: 'world' });
  expect(jobId).toBeTruthy();
  let rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.attempt).toBe(0);
  expect(rows[0]!.data).toEqual({ hello: 'world' });

  await h.boss.fetch(queue);
  rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');

  await h.boss.complete(queue, jobId!, { ok: true });
  rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('completed');
  expect(rows[0]!.output).toEqual({ ok: true });
});

test('cancel is mirrored', async () => {
  const queue = 'cap-cancel';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.cancel(queue, jobId!);
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('cancelled');
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/capture.test.ts`
Expected: FAIL — at the time of writing this task, this is the first capture test; if the trigger from Task 4 is correct it should actually PASS. Run it to confirm. If it FAILS, the trigger is wrong — debug `src/sql.ts` against the substrate spec before continuing.

- [ ] **Step 3: No new implementation**

The capture trigger built in Task 4 is the implementation. This task is a behavioral test of it. If Step 2 passed, proceed.

- [ ] **Step 4: Commit**

```bash
git add test/capture.test.ts
git commit -m "test: verify trigger captures create/active/complete/cancel"
```

---

### Task 6: Capture — retries produce per-attempt rows

**Files:**
- Modify: `test/capture.test.ts`

- [ ] **Step 1: Add the failing retry test**

Append to `test/capture.test.ts`:
```typescript
test('a job that fails twice then completes yields three attempt rows', async () => {
  const queue = 'cap-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 2 });

  // attempt 0
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-0' });
  // attempt 1
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-1' });
  // attempt 2
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(rows[0]!.state).toBe('retry');
  expect(rows[0]!.output).toEqual({ err: 'fail-0' });
  expect(rows[1]!.state).toBe('retry');
  expect(rows[1]!.output).toEqual({ err: 'fail-1' });
  expect(rows[2]!.state).toBe('completed');
  expect(rows[2]!.output).toEqual({ ok: true });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- test/capture.test.ts`
Expected: PASS. This exercises the verified `attempt := retry_count` mapping and the `ON CONFLICT` per-attempt-row behavior. If the attempt numbers or states differ, re-check the substrate spec's "capture trigger" section — do not patch the test to match a wrong trigger.

- [ ] **Step 3: Commit**

```bash
git add test/capture.test.ts
git commit -m "test: verify per-attempt record rows across retries"
```

---

### Task 7: Capture — `touch()` does not create record rows

**Files:**
- Modify: `test/capture.test.ts`

- [ ] **Step 1: Add the failing touch test**

Append to `test/capture.test.ts`:
```typescript
test('touch() heartbeats do not add or change record rows', async () => {
  const queue = 'cap-touch';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active
  const before = await getRecords(h.pool, jobId!);

  await h.boss.touch(queue, jobId!);
  await h.boss.touch(queue, jobId!);

  const after = await getRecords(h.pool, jobId!);
  expect(after).toHaveLength(before.length);
  expect(after[0]!.captured_at).toEqual(before[0]!.captured_at);
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- test/capture.test.ts`
Expected: PASS — `touch()` updates only `heartbeat_on`, which the `AFTER INSERT OR UPDATE OF state` trigger ignores, so `captured_at` is unchanged.

- [ ] **Step 3: Commit**

```bash
git add test/capture.test.ts
git commit -m "test: verify touch() heartbeats are not captured"
```

---

### Task 8: Backfill on install

**Files:**
- Modify: `src/sql.ts`
- Modify: `src/install.ts`
- Create: `test/backfill.test.ts`

- [ ] **Step 1: Write the failing backfill test**

`test/backfill.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('install backfills jobs that already existed in pgboss.job', async () => {
  const queue = 'backfill-q';
  await h.boss.createQueue(queue);
  // job created BEFORE pg-bossier is installed -> no trigger yet
  const jobId = await h.boss.send(queue, { pre: 'install' });

  let rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(0); // not captured — trigger does not exist yet

  await install(h.pool);

  rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ pre: 'install' });
});

test('re-running install is idempotent and does not duplicate rows', async () => {
  await install(h.pool);
  await install(h.pool);
  const { rows } = await h.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pgbossier.record`,
  );
  // exact count is data-dependent; assert no error and a stable count across re-runs
  const first = Number(rows[0]!.n);
  await install(h.pool);
  const { rows: again } = await h.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pgbossier.record`,
  );
  expect(Number(again[0]!.n)).toBe(first);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/backfill.test.ts`
Expected: FAIL — the pre-install job is never mirrored (install does not yet backfill).

- [ ] **Step 3: Add the backfill SQL to `src/sql.ts`**

Append to `src/sql.ts`:
```typescript
export const BACKFILL_SQL = `
INSERT INTO pgbossier.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM pgboss.job
ON CONFLICT (job_id, attempt) DO NOTHING;`;
```

- [ ] **Step 4: Run backfill at the end of `install()`**

In `src/install.ts`, add `BACKFILL_SQL` to the import and run it last:
```typescript
import type { Pool } from 'pg';
import {
  SCHEMA_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL, BACKFILL_SQL,
} from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(RECORD_TABLE_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
  await pool.query(CAPTURE_FUNCTION_SQL);
  await pool.query(CAPTURE_TRIGGER_SQL);
  await pool.query(BACKFILL_SQL);
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -- test/backfill.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts src/install.ts test/backfill.test.ts
git commit -m "feat: install() backfills existing pgboss.job rows"
```

---

### Task 9: `uninstall()`

**Files:**
- Modify: `src/install.ts`
- Create: `test/uninstall.test.ts`

- [ ] **Step 1: Write the failing uninstall test**

`test/uninstall.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install, uninstall } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('uninstall removes the schema, table, function, and the trigger on pgboss.job', async () => {
  await uninstall(h.pool);

  const schema = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(schema.rows).toHaveLength(0);

  const trigger = await h.pool.query(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_capture'`,
  );
  expect(trigger.rows).toHaveLength(0);

  // pgboss.job itself is untouched
  const job = await h.pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job'`,
  );
  expect(job.rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/uninstall.test.ts`
Expected: FAIL — `uninstall` is not exported from `src/install.ts`.

- [ ] **Step 3: Add `uninstall()` to `src/install.ts`**

Append:
```typescript
export async function uninstall(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS pgbossier CASCADE;`);
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `npm test -- test/uninstall.test.ts`
Expected: PASS — `DROP SCHEMA … CASCADE` removes the function, and cascades to drop the trigger that depends on it.

- [ ] **Step 5: Commit**

```bash
git add src/install.ts test/uninstall.test.ts
git commit -m "feat: uninstall() drops the pgbossier schema and cascades the trigger"
```

---

### Task 10: App-hook client skeleton

**Files:**
- Create: `src/record.ts`
- Create: `src/client.ts`
- Create: `test/client.test.ts`

- [ ] **Step 1: Write the failing client test**

`test/client.test.ts`:
```typescript
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('recordPatch writes app-hook columns without clobbering trigger columns', async () => {
  const queue = 'client-q';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 5 } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ done: 5 });
  // trigger-owned columns untouched
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ in: 1 });
});

test('the wrapping client delegates pg-boss methods', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(typeof client.boss.send).toBe('function');
  expect(client.boss).toBe(h.boss);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npm test -- test/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.js`.

- [ ] **Step 3: Create `src/record.ts`**

```typescript
import type { Pool } from 'pg';

/** The three pg-bossier-owned columns the app-hook may write. */
export interface RecordPatch {
  progress?: unknown;
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}

/**
 * Update the app-hook-owned columns of a record row. A plain UPDATE, not an
 * upsert: the capture trigger always creates the row first, so the app-hook
 * never needs the insert path — and this avoids the NOT NULL queue/state
 * columns. If no row exists yet, the UPDATE affects zero rows (a no-op).
 */
export async function recordPatch(
  pool: Pool, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE pgbossier.record SET
       progress        = COALESCE($3, progress),
       terminal_detail = COALESCE($4, terminal_detail),
       input_snapshot  = COALESCE($5, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [
      jobId, attempt,
      patch.progress ?? null,
      patch.terminal_detail ?? null,
      patch.input_snapshot ?? null,
    ],
  );
}
```

- [ ] **Step 4: Create `src/client.ts`**

```typescript
import type PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
}

export interface BossierClient {
  /** The underlying pg-boss instance — its queue ops are used unchanged. */
  boss: PgBoss;
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
}

/**
 * The app-hook wrapping client skeleton. v1 exposes the pg-boss instance for
 * queue ops plus `recordPatch`; the per-goal write features (terminal_detail,
 * progress, input_snapshot — issues #3/#5/#7) build their methods on this.
 */
export function bossier(options: BossierOptions): BossierClient {
  const { boss, pool } = options;
  return {
    boss,
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, jobId, attempt, patch),
  };
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `npm test -- test/client.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add src/record.ts src/client.ts test/client.test.ts
git commit -m "feat: add app-hook client skeleton (bossier, recordPatch)"
```

---

### Task 11: Public exports and final verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace the placeholder `src/index.ts`**

```typescript
export { install, uninstall } from './install.js';
export { bossier } from './client.js';
export type { BossierClient, BossierOptions } from './client.js';
export type { RecordPatch } from './record.js';
```

- [ ] **Step 2: Verify the build compiles**

Run: `npm run build`
Expected: `tsc` exits 0, `dist/` contains `index.js`, `install.js`, `client.js`, `record.js`, `sql.js` and their `.d.ts` files.

- [ ] **Step 3: Verify lint passes**

Run: `npm run lint`
Expected: exits 0. If `no-floating-promises` or import-style rules flag anything, fix it (every `pool.query` / `boss.*` call must be `await`ed).

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: every test file passes — smoke, harness, install, capture, backfill, uninstall, client.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: export the substrate public API"
```

---

## Done condition

- `npm run lint && npm run build && npm test` all pass.
- `install(pool)` creates the `pgbossier` schema, `pgbossier.record`, its indexes, the `pgbossier.capture()` function, the `pgbossier_capture` trigger on `pgboss.job`, and backfills existing rows — idempotently.
- The trigger mirrors create/active/complete/cancel/retry transitions; per-attempt rows are correct; `touch()` is ignored.
- `uninstall(pool)` removes everything, cascading the trigger, leaving `pgboss.job` untouched.
- `bossier({ boss, pool })` returns a client exposing `boss` and `recordPatch`.

## After this plan

Per `CLAUDE.md`'s worktree workflow: from the main checkout, `git checkout main && git merge --no-ff feat/substrate`, bump `package.json` minor version + add the `CHANGELOG.md` entry in the merge, push, then `git worktree remove .worktrees/feat-substrate`.

The substrate is then in place. The per-goal write features build on `recordPatch`: terminal_detail (#3), input_snapshot (#5), progress (#7); the query API (#6) reads `pgbossier.record`; lifecycle events (#8) emit from the capture points.

## Notes for the executor

- **Docker must be running** — every test file except `smoke` starts a Postgres container.
- **One implementation decision the spec left open is recorded in code:** `recordPatch` is a plain `UPDATE`, not the `recordUpsert` the substrate spec named — see the doc comment in `src/record.ts` for why (the trigger always creates the row first).
- If a capture test fails, the bug is almost certainly in `src/sql.ts` (the trigger), not the test — re-check against the substrate spec's verified SQL before changing a test.
- Test files run serially (`fileParallelism: false`); the suite takes a few minutes.

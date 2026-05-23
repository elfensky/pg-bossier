# Goal 7 Lifecycle Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pg-bossier Goal 7 — the job-lifecycle event API. Postgres `NOTIFY` from the existing capture trigger feeds a typed Node `EventEmitter` consumers subscribe to via `await bossier.subscribe()`. Six event types, plus `'job'` (catch-all), `'connected'`, `'warning'`, and discriminated `'error'`. Catch-up after a gap via a new monotonic `seq` cursor and `getEventsSince(seq)` read.

**Architecture:** One capture point. The shipped `pgbossier.capture()` trigger gains a `nextval` + `pg_notify` inside its existing fail-open block. A new `BossierEvents` class holds one dedicated `pg` connection, runs `LISTEN pgbossier_job`, parses each notification's thin identity envelope, maps state→event with a one-time `'warning'` for unknown states, and re-emits typed events. Reconnect uses exponential backoff (1 s → 30 s cap, ±20 % jitter) with a cancellable wait. Delivery contract: **at most once, with a per-gap `'error'`** carrying `{ reason: 'gap' | 'parse' | 'handler', error, at }`. Durable replay is **final-state-per-attempt** via the new `seq` cursor.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Node 18+, ESM, `pg` (node-postgres) for LISTEN/NOTIFY, vitest + `@testcontainers/postgresql` for integration tests, pg-boss 12.18.2 as the wrapped queue.

**Spec:** [`docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md`](../specs/2026-05-22-goal-7-lifecycle-events-design.md) (v2, committed `3124712` plus the `attempt`-semantics fix)
**Charter:** [`CLAUDE.md`](../../../CLAUDE.md) — feature branches via `git worktree`, `--no-ff` merge into `develop`; `CHANGELOG` under `[Unreleased]`; lint + build + test must all pass before claiming done.

---

## File map (locked before tasks)

**New files**
- `src/events.ts` — `BossierEvents` class, all event types, `subscribe(pool, opts)` factory, state→event map, reconnect loop. One responsibility: subscriber transport.
- `test/events.test.ts` — every integration test for the events API. One container per file (matches existing pattern).

**Modified files**
- `src/sql.ts` — add `SEQUENCE_SQL`, `RECORD_SEQ_COLUMN_SQL`, `RECORD_SEQ_INDEX_SQL`; replace `CAPTURE_FUNCTION_SQL` with the v2 body.
- `src/install.ts` — sequence + ALTER + index, in the right order.
- `src/read.ts` — add the `seq` field to `JobRecord` + raw row type; add `getEventsSince` read.
- `src/client.ts` — `subscribe()` + `getEventsSince()` on `BossierMethods`.
- `src/index.ts` — re-export `BossierEvents`, `JobEvent`, `JobEventName`, `BossierErrorEvent`, `BossierWarningEvent`, `ErrorReason`, `SubscribeOptions`, `GetEventsSinceOpts`.
- `README.md` — new "Lifecycle events" section under the operational API.
- `COMPATIBILITY.md` — new "Unsupported topologies" subsection.
- `CHANGELOG.md` — entry under `## [Unreleased]` → `Added`.
- `CLAUDE.md` — project-status paragraph.

**Decomposition principle.** `src/events.ts` is a single cohesive module (subscriber lifecycle). The `getEventsSince` read lives in `src/read.ts` next to the other read methods, not in `events.ts`, because it pairs with the existing read API.

---

## Task 0 — Worktree, branch, baseline

**Files:** `.worktrees/feature-goal-7-lifecycle-events/` (gitignored)

- [ ] **Step 1: Create the worktree off `develop`**

Run from the main checkout:
```bash
git worktree add .worktrees/feature-goal-7-lifecycle-events \
  -b feature/goal-7-lifecycle-events develop
```

Expected: new directory at `.worktrees/feature-goal-7-lifecycle-events/`, branch checked out.

- [ ] **Step 2: Install deps in the worktree**

```bash
cd .worktrees/feature-goal-7-lifecycle-events
npm install
```

Expected: `node_modules/` populated, no errors.

- [ ] **Step 3: Verify baseline is green**

```bash
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` emits to `dist/`, all existing tests pass. If anything is red, STOP and fix the baseline first.

---

## Task 1 — Add `seq` column SQL constants (TDD)

**Files:**
- Modify: `src/sql.ts`
- Test: `test/install.test.ts` (extend)

**Goal:** Add the sequence + idempotent column + index to the install path, *before* the trigger function references `pgbossier.record_seq`.

- [ ] **Step 1: Write the failing tests**

Append to `test/install.test.ts`:

```ts
import { test, expect } from 'vitest';
import { install } from '../src/install.js';
import { startHarness } from './harness.js';

test('install creates pgbossier.record_seq sequence', async () => {
  const h = await startHarness();
  try {
    await install(h.pool);
    const { rows } = await h.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname = 'record_seq' AND relnamespace = 'pgbossier'::regnamespace`,
    );
    expect(rows.length).toBe(1);
  } finally { await h.teardown(); }
});

test('install adds seq column to pgbossier.record with NOT NULL default', async () => {
  const h = await startHarness();
  try {
    await install(h.pool);
    const { rows } = await h.pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'pgbossier' AND table_name = 'record' AND column_name = 'seq'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toContain(`nextval('pgbossier.record_seq'`);
  } finally { await h.teardown(); }
});

test('install is idempotent', async () => {
  const h = await startHarness();
  try { await install(h.pool); await install(h.pool); } finally { await h.teardown(); }
});

test('install adds seq column to a pre-existing v1 pgbossier.record (upgrade path)', async () => {
  const h = await startHarness();
  try {
    // Simulate a v1 install: schema + table, no sequence/seq column.
    await h.pool.query(`CREATE SCHEMA IF NOT EXISTS pgbossier;`);
    await h.pool.query(`
      CREATE TABLE pgbossier.record (
        job_id uuid NOT NULL, queue text NOT NULL, attempt integer NOT NULL,
        state text NOT NULL, data jsonb, output jsonb, progress jsonb,
        terminal_detail jsonb, input_snapshot jsonb,
        created_on timestamptz, started_on timestamptz, completed_on timestamptz,
        captured_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, attempt)
      );
    `);
    await h.pool.query(
      `INSERT INTO pgbossier.record (job_id, queue, attempt, state)
       VALUES ('00000000-0000-0000-0000-000000000001', 'q', 0, 'created')`,
    );
    await install(h.pool);
    const { rows } = await h.pool.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM pgbossier.record`,
    );
    expect(rows[0]!.seq).toMatch(/^\d+$/);
  } finally { await h.teardown(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/install.test.ts
```

Expected: the four new tests fail (seq column / sequence missing).

- [ ] **Step 3: Add the new SQL constants in `src/sql.ts`**

Just below `SCHEMA_SQL`:

```ts
export const SEQUENCE_SQL = `CREATE SEQUENCE IF NOT EXISTS pgbossier.record_seq;`;
```

After `RECORD_INDEXES_SQL`:

```ts
export const RECORD_SEQ_COLUMN_SQL = `
ALTER TABLE pgbossier.record
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('pgbossier.record_seq');`;

export const RECORD_SEQ_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS record_seq_idx ON pgbossier.record (seq);`;
```

- [ ] **Step 4: Wire them into `src/install.ts`**

Replace the body of `install()` so it runs the sequence before the table (the seq column DEFAULT references the sequence):

```ts
import type { Pool } from 'pg';
import {
  SCHEMA_SQL, SEQUENCE_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
  RECORD_SEQ_COLUMN_SQL, RECORD_SEQ_INDEX_SQL,
  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL, BACKFILL_SQL,
} from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(SEQUENCE_SQL);
  await pool.query(RECORD_TABLE_SQL);
  await pool.query(RECORD_SEQ_COLUMN_SQL);
  await pool.query(RECORD_SEQ_INDEX_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
  await pool.query(CAPTURE_FUNCTION_SQL);
  await pool.query(CAPTURE_TRIGGER_SQL);
  await pool.query(BACKFILL_SQL);
}
// uninstall() unchanged
```

- [ ] **Step 5: Run tests to verify pass**

```bash
npm test -- test/install.test.ts
```

Expected: all install tests pass, including the four new ones.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: every test passes.

- [ ] **Step 7: Commit**

```bash
git add src/sql.ts src/install.ts test/install.test.ts
git commit -m "feat(sql): add seq sequence + column for Goal 7 event cursor

Sequence pgbossier.record_seq + NOT NULL BIGINT seq column on
pgbossier.record, with an index. Idempotent ADD COLUMN IF NOT EXISTS
upgrades existing installs in place.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Update trigger function to advance `seq` and emit `pg_notify`

**Files:**
- Modify: `src/sql.ts` (replace `CAPTURE_FUNCTION_SQL`)
- Test: `test/capture.test.ts` (extend)

**Goal:** Trigger advances `seq` on every INSERT/UPDATE and publishes a thin envelope on `pgbossier_job`.

- [ ] **Step 1: Write the failing tests**

Append to `test/capture.test.ts`:

```ts
import pg from 'pg';

test('record.seq advances on every transition (INSERT and UPDATE)', async () => {
  const queue = 'cap-seq';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  let rows = await getRecords(h.pool, jobId!);
  const seqAfterCreated = BigInt((rows[0] as unknown as { seq: string }).seq);

  await h.boss.fetch(queue);
  rows = await getRecords(h.pool, jobId!);
  const seqAfterActive = BigInt((rows[0] as unknown as { seq: string }).seq);

  await h.boss.complete(queue, jobId!, { ok: true });
  rows = await getRecords(h.pool, jobId!);
  const seqAfterCompleted = BigInt((rows[0] as unknown as { seq: string }).seq);

  expect(seqAfterActive).toBeGreaterThan(seqAfterCreated);
  expect(seqAfterCompleted).toBeGreaterThan(seqAfterActive);
});

test('trigger publishes pg_notify on pgbossier_job with identity + seq', async () => {
  const queue = 'cap-notify';
  await h.boss.createQueue(queue);

  const listener = new pg.Client({
    connectionString: (h.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  });
  await listener.connect();
  await listener.query('LISTEN pgbossier_job');
  const received: { channel: string; payload: string | undefined }[] = [];
  listener.on('notification', (msg) => {
    received.push({ channel: msg.channel, payload: msg.payload });
  });

  const jobId = await h.boss.send(queue, { hello: 'evt' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  expect(received.length).toBeGreaterThanOrEqual(3);
  for (const ev of received) {
    expect(ev.channel).toBe('pgbossier_job');
    const parsed = JSON.parse(ev.payload!) as Record<string, unknown>;
    expect(parsed.job_id).toBe(jobId);
    expect(parsed.queue).toBe(queue);
    expect(typeof parsed.attempt).toBe('number');
    expect(typeof parsed.state).toBe('string');
    expect(typeof parsed.seq).toBe('number');
    expect(typeof parsed.captured_at).toBe('string');
  }
  await listener.end();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/capture.test.ts
```

Expected: the two new tests fail.

- [ ] **Step 3: Replace `CAPTURE_FUNCTION_SQL` in `src/sql.ts`**

```ts
export const CAPTURE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_seq bigint;
BEGIN
  BEGIN
    new_seq := nextval('pgbossier.record_seq');

    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at, seq)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now(), new_seq)
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      seq          = new_seq;

    PERFORM pg_notify(
      'pgbossier_job',
      json_build_object(
        'job_id',      NEW.id,
        'queue',       NEW.name,
        'attempt',     NEW.retry_count,
        'state',       NEW.state,
        'seq',         new_seq,
        'captured_at', now()
      )::text
    );
  EXCEPTION WHEN OTHERS THEN
    -- fail-open per issue #1: log and continue.
    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;`;
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- test/capture.test.ts
```

Expected: all capture tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts test/capture.test.ts
git commit -m "feat(sql): trigger advances seq and publishes pg_notify

Capture trigger now advances pgbossier.record_seq on every INSERT/UPDATE
and emits a thin identity envelope on the pgbossier_job channel. Still
inside the existing fail-open BEGIN/EXCEPTION block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Add `seq` to `JobRecord` types and read SELECTs

**Files:**
- Modify: `src/read.ts`
- Modify: `test/harness.ts`

**Goal:** `JobRecord` exposes `seq: bigint`. Reads return the column. Existing tests stay green.

- [ ] **Step 1: Update `RawRecordRow` in `src/read.ts`**

Add `seq: string;` after `captured_at`. BIGINT comes back as string from pg by default.

- [ ] **Step 2: Add `seq` to `RecordShared`**

```ts
interface RecordShared<TInput> {
  jobId: string;
  queue: string;
  attempt: number;
  data: TInput | null;
  progress: unknown;
  inputSnapshot: unknown;
  createdOn: Date | null;
  startedOn: Date | null;
  completedOn: Date | null;
  capturedAt: Date;
  seq: bigint;
}
```

- [ ] **Step 3: Update the row→JobRecord mapper to convert `seq` to `bigint`**

Find where `JobRecord` is built from a `RawRecordRow` (the existing per-method inline mappers). Extract them into a single private helper at the top of `read.ts` to consolidate (DRY): `function toJobRecord<TInput, TOutput>(row: RawRecordRow): JobRecord<TInput, TOutput>`. Make sure it sets `seq: BigInt(row.seq)`. Reuse from `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `listLongRunning`.

- [ ] **Step 4: Update every SELECT in `read.ts` to include the `seq` column**

Search `read.ts` for SELECT statements. Add `seq` to every explicit column list. `SELECT *` already covers it.

- [ ] **Step 5: Update `test/harness.ts` `RecordRow` interface**

Add `seq: string;` to the `RecordRow` interface.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/read.ts test/harness.ts
git commit -m "feat(read): expose seq on JobRecord; carry it through reads

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Implement `getEventsSince(pool, since, opts)`

**Files:**
- Modify: `src/read.ts`
- Test: `test/read.test.ts`

**Goal:** Query `pgbossier.record WHERE seq > $1 ORDER BY seq ASC` with optional limit.

- [ ] **Step 1: Write the failing tests**

Append to `test/read.test.ts`:

```ts
import { getEventsSince } from '../src/read.js';

test('getEventsSince returns rows with seq strictly greater than cursor', async () => {
  const queue = 'cursor-basic';
  await h.boss.createQueue(queue);

  const id1 = await h.boss.send(queue, { n: 1 });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, id1!, { ok: 1 });

  const rows0 = await getRecords(h.pool, id1!);
  const cursor = BigInt(rows0[0]!.seq);

  const id2 = await h.boss.send(queue, { n: 2 });
  await h.boss.fetch(queue);

  const events = await getEventsSince(h.pool, cursor);
  const ids = events.map((e) => e.jobId);
  expect(ids).toContain(id2!);
  expect(ids).not.toContain(id1!);

  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq > events[i - 1]!.seq).toBe(true);
  }
});

test('getEventsSince(0n) returns every row', async () => {
  const queue = 'cursor-all';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  const all = await getEventsSince(h.pool, 0n);
  expect(all.length).toBeGreaterThan(0);
});

test('getEventsSince respects the limit option', async () => {
  const queue = 'cursor-limit';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 5; i++) await h.boss.send(queue, { i });
  const events = await getEventsSince(h.pool, 0n, { limit: 3 });
  expect(events.length).toBe(3);
});

test('getEventsSince returns final-state-per-attempt only', async () => {
  const queue = 'cursor-final-state';
  await h.boss.createQueue(queue);
  const { rows } = await h.pool.query<{ s: string }>(
    `SELECT COALESCE(max(seq), 0)::text AS s FROM pgbossier.record`,
  );
  const cursor = BigInt(rows[0]!.s);

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const events = await getEventsSince(h.pool, cursor);
  const forJob = events.filter((e) => e.jobId === jobId);
  // One row per (job_id, attempt) — final state only.
  expect(forJob.length).toBe(1);
  expect(forJob[0]!.state).toBe('completed');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/read.test.ts
```

- [ ] **Step 3: Implement `getEventsSince` in `src/read.ts`**

```ts
export interface GetEventsSinceOpts {
  /** Cap the returned slice. Default: 1000. */
  limit?: number;
}

/**
 * Read rows from `pgbossier.record` whose `seq` is strictly greater than
 * `since`, ordered ascending by `seq`. Pairs with the `seq` value carried
 * in lifecycle event payloads.
 *
 * IMPORTANT: the audit table is a current-state table (one row per
 * `(job_id, attempt)`, upserted in place). So this returns the **latest
 * state** of every attempt whose row was touched after the cursor —
 * NOT the full transition sequence within an attempt.
 */
export async function getEventsSince<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  since: bigint,
  opts: GetEventsSinceOpts = {},
): Promise<JobRecord<TInput, TOutput>[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT job_id, queue, attempt, state, data, output, progress,
            terminal_detail, input_snapshot,
            created_on, started_on, completed_on, captured_at, seq
       FROM pgbossier.record
      WHERE seq > $1
      ORDER BY seq ASC
      LIMIT $2`,
    [since.toString(), limit],
  );
  return rows.map(toJobRecord<TInput, TOutput>);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- test/read.test.ts
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/read.ts test/read.test.ts
git commit -m "feat(read): getEventsSince(seq) cursor for catch-up after gaps

Returns rows whose seq is strictly greater than the cursor, ordered
ascending. Honest scope: final-state-per-attempt — intermediate
transitions within an attempt are overwritten.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — `src/events.ts` skeleton: types + `subscribe()` + `'connected'`

**Files:**
- Create: `src/events.ts`
- Test: `test/events.test.ts` (new)

**Goal:** Subscriber opens a dedicated pool connection, runs `LISTEN`, emits `'connected'`, supports `close()` and `AbortSignal`.

- [ ] **Step 1: Create `test/events.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { subscribe } from '../src/events.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('subscribe() returns events that emit "connected" on LISTEN', async () => {
  const events = await subscribe(h.pool);
  // Most implementations emit 'connected' before subscribe() resolves.
  // Either we caught it already or it'll fire on a future tick.
  const connected = new Promise<void>((resolve) => events.once('connected', resolve));
  await Promise.race([
    connected,
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
  ]);
  await events.close();
});

test('close() releases the connection back to the pool', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  // After close, idle count should equal total (connection released).
  expect(h.pool.idleCount).toBe(h.pool.totalCount);
});

test('close() is idempotent', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  await events.close();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- test/events.test.ts
```

Expected: fails — `src/events.ts` doesn't exist.

- [ ] **Step 3: Create `src/events.ts` skeleton**

```ts
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import type { JobState } from './read.js';

export type JobEventName =
  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';

export interface JobEvent {
  /** Friendly event name. Pass-through string for unknown future pg-boss states. */
  event: JobEventName | string;
  jobId: string;
  queue: string;
  attempt: number;
  /** Raw pg-boss state. */
  state: JobState | string;
  /** Monotonic per-transition cursor. Pairs with getEventsSince(seq). */
  seq: bigint;
  capturedAt: Date;
}

export type ErrorReason = 'gap' | 'parse' | 'handler';

export interface BossierErrorEvent {
  reason: ErrorReason;
  error: unknown;
  at: Date;
}

export interface BossierWarningEvent {
  unknownState: string;
  jobId: string;
  at: Date;
}

interface BossierEventsMap {
  created:   [JobEvent];
  started:   [JobEvent];
  completed: [JobEvent];
  failed:    [JobEvent];
  cancelled: [JobEvent];
  retried:   [JobEvent];
  job:       [JobEvent];
  connected: [];
  warning:   [BossierWarningEvent];
  error:     [BossierErrorEvent];
}

export interface SubscribeOptions {
  signal?: AbortSignal;
}

export interface BossierEvents extends EventEmitter {
  on<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  once<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  off<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

class BossierEventsImpl extends EventEmitter implements BossierEvents {
  private pool: Pool;
  private client: PoolClient | null = null;
  private closed = false;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async open(): Promise<void> {
    if (this.closed) return;
    this.client = await this.pool.connect();
    await this.client.query('LISTEN pgbossier_job');
    this.emit('connected');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client) {
      try { await this.client.query('UNLISTEN pgbossier_job'); } catch { /* */ }
      this.client.release();
      this.client = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export async function subscribe(
  pool: Pool,
  opts: SubscribeOptions = {},
): Promise<BossierEvents> {
  if (opts.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const events = new BossierEventsImpl(pool);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { void events.close(); }, { once: true });
  }
  await events.open();
  return events;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/events.test.ts
```

Expected: all three pass.

- [ ] **Step 5: Lint + build + full suite**

```bash
npm run lint && npm run build && npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat(events): subscriber skeleton with 'connected' + idempotent close()

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Notification parsing + per-type emit + `'job'` catch-all

**Files:**
- Modify: `src/events.ts`
- Test: `test/events.test.ts`

**Goal:** Notifications get parsed, state→event mapped, emitted on per-type listener first, then `'job'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/events.test.ts`:

```ts
test('six event types fire for a job that fails-with-retry-then-succeeds', async () => {
  const queue = 'evt-six';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const seen: { event: string; attempt: number }[] = [];
  for (const name of ['created', 'started', 'completed', 'failed', 'cancelled', 'retried'] as const) {
    events.on(name, (e) => seen.push({ event: name, attempt: e.attempt }));
  }

  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 200));

  // Verified against test/capture.test.ts behavior.
  expect(seen).toEqual([
    { event: 'created',   attempt: 0 },
    { event: 'started',   attempt: 0 },
    { event: 'retried',   attempt: 0 },
    { event: 'created',   attempt: 1 },
    { event: 'started',   attempt: 1 },
    { event: 'completed', attempt: 1 },
  ]);
  await events.close();
});

test("catch-all 'job' listener receives every transition", async () => {
  const queue = 'evt-catchall';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const all: string[] = [];
  events.on('job', (e) => all.push(e.event));

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  expect(all).toEqual(['created', 'started', 'completed']);
  await events.close();
});

test("per-type event fires before 'job' for the same transition", async () => {
  const queue = 'evt-order';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const order: string[] = [];
  events.on('completed', () => order.push('completed-listener'));
  events.on('job', (e) => order.push(`job-listener(${e.event})`));

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  const idx = order.indexOf('completed-listener');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(order[idx + 1]).toBe('job-listener(completed)');
  await events.close();
});

test('seq on emitted events is monotonically increasing', async () => {
  const queue = 'evt-seq';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const seqs: bigint[] = [];
  events.on('job', (e) => seqs.push(e.seq));

  for (let i = 0; i < 3; i++) {
    const jobId = await h.boss.send(queue, { i });
    await h.boss.fetch(queue);
    await h.boss.complete(queue, jobId!, { i });
  }
  await new Promise((r) => setTimeout(r, 200));

  expect(seqs.length).toBe(9);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  }
  await events.close();
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 3: Add the notification handler and state map to `src/events.ts`**

Module-level constant, above the class:

```ts
const STATE_TO_EVENT: Record<string, JobEventName> = {
  created:   'created',
  active:    'started',
  retry:     'retried',
  completed: 'completed',
  failed:    'failed',
  cancelled: 'cancelled',
};
```

Update `BossierEventsImpl.open()` to register the notification handler:

```ts
async open(): Promise<void> {
  if (this.closed) return;
  this.client = await this.pool.connect();
  this.client.on('notification', (msg) => this.handleNotification(msg));
  await this.client.query('LISTEN pgbossier_job');
  this.emit('connected');
}
```

Add the handler method:

```ts
private handleNotification(msg: { channel: string; payload: string | undefined }): void {
  if (msg.channel !== 'pgbossier_job' || msg.payload === undefined) return;

  let parsed: { job_id?: string; queue?: string; attempt?: number;
                state?: string; seq?: number | string; captured_at?: string };
  try {
    parsed = JSON.parse(msg.payload) as typeof parsed;
  } catch {
    // Task 7 wires this to 'error' with reason='parse'.
    return;
  }

  const { job_id, queue, attempt, state, seq, captured_at } = parsed;
  if (typeof job_id !== 'string' || typeof queue !== 'string' ||
      typeof attempt !== 'number' || typeof state !== 'string' ||
      (typeof seq !== 'number' && typeof seq !== 'string') ||
      typeof captured_at !== 'string') {
    return;
  }

  const eventName = STATE_TO_EVENT[state];
  const jobEvent: JobEvent = {
    event: eventName ?? state,
    jobId: job_id,
    queue,
    attempt,
    state,
    seq: BigInt(seq),
    capturedAt: new Date(captured_at),
  };

  if (eventName) {
    this.emit(eventName, jobEvent);   // per-type first
  } else {
    // Unknown state — Task 7 wires the 'warning' event.
  }
  this.emit('job', jobEvent);          // then catch-all
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/events.test.ts
npm test
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat(events): parse notifications and emit per-type then 'job'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Unknown-state fallback + `'warning'` + parse-error `'error'`

**Files:**
- Modify: `src/events.ts`
- Test: `test/events.test.ts`

**Goal:** Unknown `state` values pass through with `event = state`, emit only on `'job'`, fire `'warning'` once per unknown state. Malformed JSON fires `'error'` with `reason: 'parse'`.

- [ ] **Step 1: Write the failing tests**

```ts
test("unknown state passes through with event = state and fires 'warning' once", async () => {
  const events = await subscribe(h.pool);
  const jobEvents: { event: string; state: string }[] = [];
  const warnings: { unknownState: string; jobId: string }[] = [];
  events.on('job', (e) => jobEvents.push({ event: e.event, state: e.state }));
  events.on('warning', (w) => warnings.push({ unknownState: w.unknownState, jobId: w.jobId }));

  const fakeId = '00000000-0000-0000-0000-000000000aaa';
  const payload1 = JSON.stringify({
    job_id: fakeId, queue: 'q', attempt: 0, state: 'paused', seq: 999999, captured_at: new Date().toISOString(),
  });
  const payload2 = JSON.stringify({
    job_id: fakeId, queue: 'q', attempt: 1, state: 'paused', seq: 1000000, captured_at: new Date().toISOString(),
  });
  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload1]);
  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload2]);
  await new Promise((r) => setTimeout(r, 100));

  expect(jobEvents).toEqual([
    { event: 'paused', state: 'paused' },
    { event: 'paused', state: 'paused' },
  ]);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toEqual({ unknownState: 'paused', jobId: fakeId });
  await events.close();
});

test("malformed JSON fires 'error' (reason='parse'); stream continues", async () => {
  const events = await subscribe(h.pool);
  const errors: { reason: string }[] = [];
  let jobEventsAfter = 0;
  events.on('error', (ev) => errors.push({ reason: ev.reason }));
  events.on('job', () => { jobEventsAfter += 1; });

  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, ['{not valid json']);

  const queue = 'evt-after-parse-error';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 150));

  expect(errors.map((e) => e.reason)).toContain('parse');
  expect(jobEventsAfter).toBeGreaterThan(0);
  await events.close();
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 3: Update `BossierEventsImpl` for warning + parse-error**

Add private state at the top of the class:

```ts
private seenUnknownStates = new Set<string>();
```

Add a helper:

```ts
private emitError(reason: ErrorReason, error: unknown): void {
  const event: BossierErrorEvent = { reason, error, at: new Date() };
  this.emit('error', event);
}
```

Update `handleNotification`:

```ts
private handleNotification(msg: { channel: string; payload: string | undefined }): void {
  if (msg.channel !== 'pgbossier_job' || msg.payload === undefined) return;

  let parsed: { job_id?: string; queue?: string; attempt?: number;
                state?: string; seq?: number | string; captured_at?: string };
  try {
    parsed = JSON.parse(msg.payload) as typeof parsed;
  } catch (err) {
    this.emitError('parse', err);
    return;
  }

  const { job_id, queue, attempt, state, seq, captured_at } = parsed;
  if (typeof job_id !== 'string' || typeof queue !== 'string' ||
      typeof attempt !== 'number' || typeof state !== 'string' ||
      (typeof seq !== 'number' && typeof seq !== 'string') ||
      typeof captured_at !== 'string') {
    this.emitError('parse', new Error(`pgbossier: malformed notification payload: ${msg.payload}`));
    return;
  }

  const eventName = STATE_TO_EVENT[state];
  const jobEvent: JobEvent = {
    event: eventName ?? state,
    jobId: job_id,
    queue,
    attempt,
    state,
    seq: BigInt(seq),
    capturedAt: new Date(captured_at),
  };

  if (eventName) {
    this.emit(eventName, jobEvent);
  } else {
    if (!this.seenUnknownStates.has(state)) {
      this.seenUnknownStates.add(state);
      const warning: BossierWarningEvent = {
        unknownState: state, jobId: job_id, at: new Date(),
      };
      this.emit('warning', warning);
    }
  }
  this.emit('job', jobEvent);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat(events): unknown-state pass-through + 'warning' + parse 'error'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Handler-throw routing to `'error'` with `reason='handler'`

**Files:**
- Modify: `src/events.ts`
- Test: `test/events.test.ts`

**Goal:** A thrown listener does NOT crash the stream. Library catches and re-emits as `'error'` with `reason: 'handler'`.

- [ ] **Step 1: Write the failing test**

```ts
test("thrown handler routes to 'error' (reason='handler'); stream continues", async () => {
  const events = await subscribe(h.pool);
  const errors: { reason: string; error: unknown }[] = [];
  const after: string[] = [];
  events.on('error', (ev) => errors.push({ reason: ev.reason, error: ev.error }));
  events.on('completed', () => { throw new Error('boom from handler'); });
  events.on('job', (e) => after.push(e.event));

  const queue = 'evt-handler-throw';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 200));

  expect(errors.some((e) => e.reason === 'handler')).toBe(true);
  expect(after).toContain('completed');
  await events.close();
});
```

- [ ] **Step 2: Run to verify fail**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 3: Wrap per-type and `'job'` emits with a try/catch**

Add a private method to `BossierEventsImpl`:

```ts
private safeEmit<K extends keyof BossierEventsMap>(
  name: K, ...args: BossierEventsMap[K]
): void {
  const listeners = this.listeners(name).slice();
  for (const listener of listeners) {
    try {
      (listener as (...a: BossierEventsMap[K]) => void)(...args);
    } catch (err) {
      this.emitError('handler', err);
    }
  }
}
```

In `handleNotification`, replace the per-type and `'job'` emits:

Old:
```ts
if (eventName) { this.emit(eventName, jobEvent); } else { /* ... */ }
this.emit('job', jobEvent);
```

New:
```ts
if (eventName) {
  this.safeEmit(eventName, jobEvent);
} else {
  if (!this.seenUnknownStates.has(state)) {
    this.seenUnknownStates.add(state);
    const warning: BossierWarningEvent = {
      unknownState: state, jobId: job_id, at: new Date(),
    };
    this.emit('warning', warning);
  }
}
this.safeEmit('job', jobEvent);
```

Leave `'connected'`, `'warning'`, and `'error'` going through plain `this.emit` — those use Node default semantics.

- [ ] **Step 4: Run tests**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat(events): catch handler throws, route to 'error' reason='handler'

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — Reconnect with exponential backoff + jitter + cancellable wait

**Files:**
- Modify: `src/events.ts`
- Test: `test/events.test.ts`

**Goal:** On client `'error'`/`'end'`, the subscriber releases the dead client, waits `min(2^n × 1s, 30s) × jitter(0.8, 1.2)`, reconnects, emits `'connected'` then `'error'` (reason='gap'). `close()` cancels the wait.

- [ ] **Step 1: Write the failing tests**

```ts
test("reconnect after pg_terminate_backend; 'error' (gap) then 'connected'", async () => {
  const events = await subscribe(h.pool);
  const log: string[] = [];
  events.on('connected', () => log.push('connected'));
  events.on('error', (ev) => log.push(`error:${ev.reason}`));

  // Find any backend with our LISTEN registered.
  const { rows } = await h.pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
  );
  expect(rows.length).toBeGreaterThan(0);
  await h.pool.query(`SELECT pg_terminate_backend($1)`, [rows[0]!.pid]);

  await new Promise((r) => setTimeout(r, 3000));

  expect(log).toContain('connected');
  expect(log).toContain('error:gap');
  expect(log.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);

  const queue = 'evt-reconnect';
  await h.boss.createQueue(queue);
  const got: string[] = [];
  events.on('job', (e) => got.push(e.event));
  await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 200));
  expect(got).toContain('created');

  await events.close();
});

test('close() during backoff wait cancels reconnect', async () => {
  const events = await subscribe(h.pool);

  const { rows } = await h.pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
  );
  await h.pool.query(`SELECT pg_terminate_backend($1)`, [rows[0]!.pid]);

  // Close during the backoff wait.
  await new Promise((r) => setTimeout(r, 50));
  await events.close();

  let secondConnected = false;
  events.on('connected', () => { secondConnected = true; });
  await new Promise((r) => setTimeout(r, 2000));
  expect(secondConnected).toBe(false);
});
```

- [ ] **Step 2: Run to verify fail**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 3: Add the reconnect loop**

Private fields in `BossierEventsImpl`:

```ts
private failureCount = 0;
private reconnectCancellers: (() => void)[] = [];
```

Replace `open()`:

```ts
async open(): Promise<void> {
  if (this.closed) return;
  this.client = await this.pool.connect();
  this.client.on('notification', (msg) => this.handleNotification(msg));
  this.client.on('error', (err) => this.onClientLost(err));
  this.client.on('end', () => this.onClientLost(new Error('connection ended')));
  await this.client.query('LISTEN pgbossier_job');
  this.failureCount = 0;
  this.emit('connected');
}

private onClientLost(err: unknown): void {
  if (this.closed || !this.client) return;
  try { this.client.release(err as Error); } catch { /* */ }
  this.client = null;
  this.scheduleReconnect();
}

private scheduleReconnect(): void {
  if (this.closed) return;
  const delayMs = this.computeBackoffMs();
  const wait = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    this.reconnectCancellers.push(() => { clearTimeout(timer); resolve(); });
  });
  void wait.then(async () => {
    if (this.closed) return;
    try {
      await this.open();
      this.emitError('gap', new Error('event-stream gap during reconnect'));
    } catch (err) {
      this.failureCount += 1;
      this.scheduleReconnect();
    }
  });
}

private computeBackoffMs(): number {
  const base = Math.min(1000 * Math.pow(2, this.failureCount), 30_000);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter);
}
```

Update `close()` to cancel pending waits:

```ts
async close(): Promise<void> {
  if (this.closed) return;
  this.closed = true;
  for (const cancel of this.reconnectCancellers) {
    try { cancel(); } catch { /* */ }
  }
  this.reconnectCancellers = [];
  if (this.client) {
    try { await this.client.query('UNLISTEN pgbossier_job'); } catch { /* */ }
    this.client.release();
    this.client = null;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- test/events.test.ts
npm run lint && npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat(events): reconnect with exponential backoff + jitter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — `AbortSignal` integration test

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write tests** (no new code — Task 5 wired this)

```ts
test('AbortSignal.abort() closes the subscriber', async () => {
  const ac = new AbortController();
  const events = await subscribe(h.pool, { signal: ac.signal });
  ac.abort();
  await new Promise((r) => setTimeout(r, 50));
  expect(h.pool.idleCount).toBe(h.pool.totalCount);
});

test('subscribe() with already-aborted signal throws AbortError', async () => {
  const ac = new AbortController();
  ac.abort();
  await expect(subscribe(h.pool, { signal: ac.signal })).rejects.toThrow(/abort/i);
});
```

- [ ] **Step 2: Run**

```bash
npm test -- test/events.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add test/events.test.ts
git commit -m "test(events): AbortSignal integration coverage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 — Wire `subscribe` + `getEventsSince` onto the `bossier` client

**Files:**
- Modify: `src/client.ts`, `src/index.ts`
- Test: `test/client.test.ts`

- [ ] **Step 1: Update `src/client.ts`**

Add imports at the top:

```ts
import { subscribe, type BossierEvents, type SubscribeOptions } from './events.js';
import {
  // existing imports plus:
  getEventsSince, type GetEventsSinceOpts,
} from './read.js';
```

Add to `BossierMethods`:

```ts
/** Open a subscription to job-lifecycle events. */
subscribe: (opts?: SubscribeOptions) => Promise<BossierEvents>;
/** Read pgbossier.record rows with seq > since, ordered ascending. */
getEventsSince: <TInput = unknown, TOutput = unknown>(
  since: bigint, opts?: GetEventsSinceOpts,
) => Promise<JobRecord<TInput, TOutput>[]>;
```

Add to the `methods` object in `bossier()`:

```ts
subscribe: (opts) => subscribe(pool, opts),
getEventsSince: <TInput = unknown, TOutput = unknown>(
  since: bigint, opts?: GetEventsSinceOpts,
) => getEventsSince<TInput, TOutput>(pool, since, opts),
```

- [ ] **Step 2: Re-exports in `src/index.ts`**

```ts
export { subscribe } from './events.js';
export type {
  BossierEvents, JobEvent, JobEventName,
  BossierErrorEvent, BossierWarningEvent, ErrorReason,
  SubscribeOptions,
} from './events.js';
export type { GetEventsSinceOpts } from './read.js';
```

- [ ] **Step 3: Write the wiring test**

Append to `test/client.test.ts`:

```ts
test('bossier.subscribe() returns events that fire on transitions', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const events = await client.subscribe();
  const seen: string[] = [];
  events.on('job', (e) => seen.push(e.event));

  const queue = 'cli-subscribe';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 150));

  expect(seen).toContain('created');
  await events.close();
});

test('bossier.getEventsSince() returns rows after the cursor', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const queue = 'cli-cursor';
  await h.boss.createQueue(queue);

  const { rows: r0 } = await h.pool.query<{ s: string }>(
    `SELECT COALESCE(max(seq), 0)::text AS s FROM pgbossier.record`,
  );
  const cursor = BigInt(r0[0]!.s);

  const jobId = await h.boss.send(queue, {});
  const events = await client.getEventsSince(cursor);
  expect(events.some((e) => e.jobId === jobId)).toBe(true);
});
```

- [ ] **Step 4: Run and build**

```bash
npm test
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "feat(client): wire subscribe() and getEventsSince() onto bossier

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12 — Cross-subscriber broadcast + backfill-silence tests

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the tests**

```ts
test('two subscribers on the same pool both receive every event', async () => {
  const a = await subscribe(h.pool);
  const b = await subscribe(h.pool);
  const aSeen: string[] = [], bSeen: string[] = [];
  a.on('job', (e) => aSeen.push(e.jobId));
  b.on('job', (e) => bSeen.push(e.jobId));

  const queue = 'evt-broadcast';
  await h.boss.createQueue(queue);
  const id = await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 200));

  expect(aSeen).toContain(id!);
  expect(bSeen).toContain(id!);
  await a.close(); await b.close();
});

test('install() backfill does NOT fire events for historical pgboss.job rows', async () => {
  const h2 = await startHarness();
  try {
    const queue = 'evt-backfill';
    await h2.boss.createQueue(queue);
    await h2.boss.send(queue, { before: 'install' });

    await install(h2.pool);

    const events = await subscribe(h2.pool);
    const seen: string[] = [];
    events.on('job', (e) => seen.push(e.event));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.length).toBe(0);

    await h2.boss.send(queue, { after: 'subscribe' });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toContain('created');
    await events.close();
  } finally { await h2.teardown(); }
});
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- test/events.test.ts
git add test/events.test.ts
git commit -m "test(events): cross-subscriber broadcast + backfill silence

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13 — Forbidden-imports static-grep test

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('src/events.ts imports only from pg and node built-ins', () => {
  const source = readFileSync(resolve(__dirname, '../src/events.ts'), 'utf8');
  const importRe = /from\s+['"]([^'"]+)['"]/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(source))) seen.add(m[1]!);

  for (const dep of seen) {
    const allowed = dep === 'pg'
      || dep.startsWith('node:')
      || dep.startsWith('./')
      || dep.startsWith('../');
    expect({ dep, allowed }).toEqual({ dep, allowed: true });
  }
  for (const dep of seen) {
    expect(dep.includes('pg-boss/src')).toBe(false);
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- test/events.test.ts
git add test/events.test.ts
git commit -m "test(events): assert no Forbidden-tier imports in events.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14 — Idle-session-timeout reconnect test

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the test**

```ts
test('reconnect handles idle_session_timeout disconnect', async () => {
  await h.pool.query(`ALTER DATABASE postgres SET idle_session_timeout = '2s'`);

  // Open subscriber AFTER setting the database default so its connection inherits it.
  const events = await subscribe(h.pool);
  const log: string[] = [];
  events.on('connected', () => log.push('connected'));
  events.on('error', (ev) => log.push(`error:${ev.reason}`));

  await new Promise((r) => setTimeout(r, 5000));

  expect(log.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);
  expect(log).toContain('error:gap');

  await h.pool.query(`ALTER DATABASE postgres RESET idle_session_timeout`);
  await events.close();
}, 15_000);
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- test/events.test.ts
git add test/events.test.ts
git commit -m "test(events): reconnect on idle_session_timeout disconnect

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15 — Notification-flood test

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the test**

```ts
test('subscriber receives every event during a burst (notification flood)', async () => {
  const events = await subscribe(h.pool);
  let received = 0;
  events.on('created', () => { received += 1; });

  const queue = 'evt-flood';
  await h.boss.createQueue(queue);
  const N = 200;
  const sends: Promise<string | null>[] = [];
  for (let i = 0; i < N; i++) sends.push(h.boss.send(queue, { i }));
  await Promise.all(sends);
  await new Promise((r) => setTimeout(r, 1500));
  expect(received).toBe(N);
  await events.close();
}, 30_000);
```

- [ ] **Step 2: Run + commit**

```bash
npm test -- test/events.test.ts
git add test/events.test.ts
git commit -m "test(events): notification flood — 200 inserts in a tight loop

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16 — Performance probe (conditional gate; currently informational)

**Files:**
- Test: `test/events.test.ts`

- [ ] **Step 1: Write the probe**

```ts
test('performance probe: per-transition overhead with pg-bossier', async () => {
  const queue = 'evt-perf';
  await h.boss.createQueue(queue);

  const N = 100;
  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const id = await h.boss.send(queue, { i });
    await h.boss.fetch(queue);
    await h.boss.complete(queue, id!, { ok: true });
  }
  const elapsedNs = process.hrtime.bigint() - start;
  const perTransitionMs = Number(elapsedNs) / 1_000_000 / (N * 3);

  // Informational until issue #12 lands a budget.
  console.log(`[perf] per-transition with pg-bossier: ${perTransitionMs.toFixed(3)} ms`);

  // Sanity ceiling — well under 100 ms on slow CI.
  expect(perTransitionMs).toBeLessThan(100);
}, 60_000);
```

When issue #12 lands its number, replace `100` with the agreed budget. That's the conditional gate.

- [ ] **Step 2: Run + commit**

```bash
npm test -- test/events.test.ts
git add test/events.test.ts
git commit -m "test(events): performance probe — per-transition overhead

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17 — README "Lifecycle events" section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read current README**

```bash
cat README.md
```

Find the "Operational API" section (Goal 5 reads, Goal 6 progress). Insert the new section after it.

- [ ] **Step 2: Append**

```md
### Lifecycle events (Goal 7)

Subscribe to job state transitions instead of polling:

```ts
import { bossier } from 'pg-bossier';

const client = bossier({ boss, pool });
const events = await client.subscribe();
let lastSeq = 0n;

events.on('connected', () => console.log('event stream live'));
events.on('failed', e => console.warn(`job ${e.jobId} failed on attempt ${e.attempt}`));
events.on('job', e => { lastSeq = e.seq; });
events.on('error', async e => {
  if (e.reason === 'gap') {
    const missed = await client.getEventsSince(lastSeq);
    for (const row of missed) { lastSeq = row.seq; handleCatchUp(row); }
  }
});

process.on('SIGINT', async () => {
  await events.close();
  await boss.stop();
});
```

**Event types.** `'created'`, `'started'`, `'completed'`, `'failed'`, `'cancelled'`, `'retried'`. Catch-all `'job'`. Subscriber-level `'connected'` (every successful LISTEN), `'warning'` (first occurrence of an unknown pg-boss state), `'error'` (`reason: 'gap' | 'parse' | 'handler'`).

**Delivery contract.** At most once. On a connection drop the subscriber auto-reconnects with exponential backoff + jitter and emits `'error'` with `reason: 'gap'`. Durable replay via `getEventsSince(seq)`. **Important scope:** the audit table holds the final state per attempt, not the full transition sequence within an attempt — `getEventsSince` recovers latest-state-per-attempt only.

**`attempt` semantics.** `created` carries the new attempt number (0 for first send, 1 for first retry). `retried` carries the FAILING attempt's number (the OLD one) and is immediately followed by a `created` event for the new attempt row.

**Connection cost.** Each live subscriber holds one dedicated pool connection. Size your pool accordingly. For long-running processes only (web servers, workers) — not lambdas / FaaS.

**Unsupported topologies.** PgBouncer in transaction-pool mode silently breaks `LISTEN`. Use session-pool mode, a direct Postgres connection, or skip PgBouncer for the subscriber's connection. See [`COMPATIBILITY.md`](./COMPATIBILITY.md).

**MaxListenersExceededWarning.** If you add many `'job'` listeners (e.g. for metrics fan-out), call `events.setMaxListeners(0)` to suppress Node's 10-listener default warning.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): Lifecycle events section for Goal 7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18 — `COMPATIBILITY.md` "Unsupported topologies" section

**Files:**
- Modify: `COMPATIBILITY.md`

- [ ] **Step 1: Append**

```md
## Unsupported topologies (Goal 7)

Postgres `LISTEN/NOTIFY` — pg-bossier's lifecycle event transport — has hard topology constraints. The subscriber's connection must reach the primary through a non-multiplexed session.

### PgBouncer in transaction-pool mode — unsupported

In transaction-pool mode, PgBouncer reuses backends between transactions. `LISTEN` registers on a specific backend; when the proxy hands the next transaction to a different backend, the LISTEN is invisible to it. The subscriber sees no errors and no events — a silent failure.

Three viable consumer options:

1. Route the subscriber connection through PgBouncer in **session-pool** mode.
2. Use a separate Postgres connection (no PgBouncer) for the subscriber.
3. Connect directly to Postgres for `subscribe()`.

Detect silently-broken subscribers via the `'connected'` event — register a listener and alert if no `'connected'` arrives within N seconds of `subscribe()` returning.

### Standby / read-replica connections — unsupported

`NOTIFY` is not replicated to streaming or logical replicas. A subscriber connected to a standby reads no events. After a primary failover, a subscriber connected by IP/DNS to the old primary (now a standby) will reconnect "cleanly" but receive nothing.

**Recommended:** use `target_session_attrs=read-write` in the connection string (libpq ≥ 14 / pg ≥ 8.5) so the driver discovers the writable primary on every (re)connection.

### `pg_notify` inside the capture trigger

The capture trigger's `pg_notify` is enqueued and delivered on transaction commit. A pg-boss op that rolls back produces neither an audit row nor an event (both share the trigger savepoint).

**Silent-gap edge case.** If `pg_notify` itself ever fails inside the trigger's `EXCEPTION WHEN OTHERS` block (vanishingly rare with the ~150-byte bounded payload), the implicit savepoint rolls back the audit row write too. The pg-boss op still succeeds. No JS `'error'` fires because no notification was delivered.

### Channel name

`pgbossier_job` — pg-bossier-owned per the namespacing constraint in issue #1. Non-Node consumers can `LISTEN pgbossier_job` directly.
```

- [ ] **Step 2: Commit**

```bash
git add COMPATIBILITY.md
git commit -m "docs(compatibility): Unsupported topologies for Goal 7

PgBouncer transaction-mode, standby/replica limitations,
target_session_attrs recommendation, SQL-side silent-gap edge case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19 — `CHANGELOG.md` entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update under `## [Unreleased]` → `Added`**

```md
### Added

- **Goal 7 — Lifecycle event API** (#8). `subscribe()` returns a typed `BossierEvents` (Node `EventEmitter`) that fires `'created'`, `'started'`, `'completed'`, `'failed'`, `'cancelled'`, `'retried'`, plus a `'job'` catch-all, `'connected'`, `'warning'`, and a discriminated `'error'` (`reason: 'gap' | 'parse' | 'handler'`). Transport: Postgres `LISTEN/NOTIFY` on `pgbossier_job` from the existing capture trigger. Auto-reconnect with exponential backoff + jitter. `AbortSignal` and `Symbol.asyncDispose` support.
- **`seq BIGINT` monotonic event cursor** on `pgbossier.record` (sequence `pgbossier.record_seq`, advanced on every INSERT/UPDATE). Included in the NOTIFY payload.
- **`getEventsSince(seq, opts?)`** on the `bossier` client — catch-up read for use after a gap signal. Returns the latest state per attempt (the audit table upserts each `(job_id, attempt)`).
- `COMPATIBILITY.md`: new "Unsupported topologies" section (PgBouncer transaction-mode, standby connections, `target_session_attrs=read-write`).
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): Goal 7 entry under [Unreleased]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 20 — `CLAUDE.md` project-status update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the project-status paragraph**

Find the line that mentions Goal 6 delivered. Append after it (same paragraph):

```
 Goal 7's lifecycle event API — `subscribe()` returning a typed `BossierEvents`, `getEventsSince(seq)`, a monotonic `seq` column on `pgbossier.record`, and `pg_notify` inside the capture trigger — merged via the feature/goal-7-lifecycle-events branch; its issue #8 is closed.
```

Update the "Goal status — current snapshot" table row for Goal 7:

```md
| Goal 7 — Lifecycle events | ✅ **Delivered.** `subscribe()` + typed `BossierEvents` with six event types plus catch-all / connected / warning / discriminated error; `getEventsSince(seq)` catch-up read; monotonic `seq` column on `pgbossier.record`. Issue #8 closed. |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): sync — Goal 7 delivered, issue #8 closed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21 — Full lint + build + test green

- [ ] **Step 1: Run everything**

```bash
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` emits to `dist/`, every test passes. Don't merge with anything red.

- [ ] **Step 2: Final review of `dist/`**

```bash
ls dist/
```

Expected to include `events.js` and `events.d.ts` plus the index re-exports of all new symbols.

---

## Task 22 — Merge feature branch into `develop`

- [ ] **Step 1: Return to the main checkout**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git checkout develop
git pull --ff-only origin develop
```

- [ ] **Step 2: `--no-ff` merge**

```bash
git merge --no-ff feature/goal-7-lifecycle-events -m "Merge feature/goal-7-lifecycle-events: Goal 7 lifecycle event API

- subscribe() returns typed BossierEvents with six event types plus catch-all,
  connected, warning, and discriminated error.
- Postgres LISTEN/NOTIFY transport from the existing capture trigger.
- Monotonic seq column + getEventsSince(seq) catch-up read.
- Exponential backoff + jitter on reconnect; AbortSignal + Symbol.asyncDispose.
- README + COMPATIBILITY documentation including PgBouncer transaction-mode
  unsupported-topology note.
- Issue #8 closed."
```

- [ ] **Step 3: Verify**

```bash
git log --oneline -n 5
npm run lint && npm run build && npm test
```

Expected: merge commit on top of develop; all checks green.

- [ ] **Step 4: Push** (only if the user asks)

```bash
# git push origin develop
```

- [ ] **Step 5: Clean up the worktree + branch**

```bash
git worktree remove .worktrees/feature-goal-7-lifecycle-events
git branch -d feature/goal-7-lifecycle-events
```

- [ ] **Step 6: Close issue #8 on GitHub** (only if pushed)

```bash
# gh issue close 8 -c "Delivered via feature/goal-7-lifecycle-events merged to develop."
```

---

## Notes for the engineer

- **Existing patterns to match.** `src/progress.ts` (Goal 6) and `src/read.ts` are the closest structural analogues. Module-level functions + a small client wrapper + integration tests through testcontainers.
- **Fail-open is non-negotiable.** Any change to `CAPTURE_FUNCTION_SQL` must keep the inner `BEGIN…EXCEPTION WHEN OTHERS` block.
- **BIGINT handling.** pg returns BIGINT as string by default. Convert via `BigInt(row.seq)` at the boundary. Don't change the global type parser.
- **Test order independence.** One container per file; each test uses a unique queue name. Don't rely on cross-test state.
- **No reach into pg-boss internals.** Task 13's static-grep test enforces this.
- **Commits are incremental.** Each task ends with a commit. `develop` preserves the per-task history.

## Self-review

**Spec coverage** (must-land items from the spec's Revisions section):

1. `seq BIGINT` column → Task 1 ✓
2. `getEventsSince` → Task 4 ✓
3. Honest replay scope (final-state-per-attempt) → Task 4 docstring + Task 17 README + Task 18 COMPATIBILITY ✓
4. PgBouncer doc → Task 17 + Task 18 ✓
5. Exponential backoff + jitter → Task 9 ✓
6. Unknown-state fallback → Task 7 ✓
7. Performance probe conditional gate → Task 16 ✓
8. SQL-side silent-gap doc → Task 18 ✓
9. `'error'` discriminant → Task 7 + Task 8 ✓
10. `'error'` listener type `[unknown]` → Task 5 types ✓
11. `attempt` semantics doc → Task 17 ✓
12. Per-type vs `'job'` ordering → Task 6 ✓
13. `closed` race in reconnect → Task 9 ✓
14. `'connected'` event → Task 5 + Task 6 ✓

**Should-haves:**
- `AbortSignal` → Task 5 + Task 10 ✓
- `Symbol.asyncDispose` → Task 5 ✓
- Backfill behavior → Task 12 + Task 17 ✓
- `target_session_attrs=read-write` → Task 18 ✓
- Idle-session timeout test → Task 14 ✓
- Notification flood test → Task 15 ✓
- MaxListenersExceededWarning → Task 17 ✓
- No-Forbidden-imports test → Task 13 ✓

**Placeholder scan:** no TBD / TODO / implement-later. Every step has executable code or commands.

**Type consistency:** `JobEvent`, `BossierErrorEvent`, `BossierWarningEvent`, `ErrorReason`, `SubscribeOptions`, `GetEventsSinceOpts` — same names across every task. `subscribe(pool, opts)` signature consistent across Tasks 5/9/10/11.

All must-land and should-have items are covered by at least one task.

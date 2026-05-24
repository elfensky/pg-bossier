import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import {
  recordTerminalDetail,
  type TerminalDetailFailed,
} from '../src/terminal-detail.js';
import { findById, getRetryHistory } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Validation rejects missing class on failed.
// ─────────────────────────────────────────────────────────────────────────────
test('validation rejects missing class on failed state', async () => {
  const queue = 'td-validate-missing-class';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  const before = await getRecords(h.pool, jobId!);
  expect(before[0]!.terminal_detail).toBeNull();

  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: {} as TerminalDetailFailed,
    }),
  ).rejects.toThrow(/pg-bossier: terminal_detail validation: failed state requires class/);

  const after = await getRecords(h.pool, jobId!);
  expect(after[0]!.terminal_detail).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Validation rejects unknown class.
// ─────────────────────────────────────────────────────────────────────────────
test('validation rejects unknown class on failed state', async () => {
  const queue = 'td-validate-unknown-class';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: { class: 'maybe' as 'transient' },
    }),
  ).rejects.toThrow(/pg-bossier: terminal_detail validation/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Validation accepts both legal class values.
// ─────────────────────────────────────────────────────────────────────────────
test('validation accepts class=transient and class=non_retryable', async () => {
  const queue = 'td-validate-legal-classes';
  await h.boss.createQueue(queue);

  const j1 = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, j1!, { err: 't' });
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, j1!, 0, {
      state: 'failed',
      detail: { class: 'transient' },
    }),
  ).resolves.toBeUndefined();
  const r1 = await getRecords(h.pool, j1!);
  expect(r1[0]!.terminal_detail).toEqual({ class: 'transient' });

  const j2 = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, j2!, { err: 't' });
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, j2!, 0, {
      state: 'failed',
      detail: { class: 'non_retryable' },
    }),
  ).resolves.toBeUndefined();
  const r2 = await getRecords(h.pool, j2!);
  expect(r2[0]!.terminal_detail).toEqual({ class: 'non_retryable' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — Validation accepts non-failed states with any shape.
// ─────────────────────────────────────────────────────────────────────────────
test('validation accepts completed and cancelled with any shape', async () => {
  const queue = 'td-validate-non-failed';
  await h.boss.createQueue(queue);

  const jc = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jc!, { ok: true });
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jc!, 0, {
      state: 'completed',
      detail: { duration: 42 },
    }),
  ).resolves.toBeUndefined();
  const completedRow = await getRecords(h.pool, jc!);
  expect(completedRow[0]!.terminal_detail).toEqual({ duration: 42 });

  const jx = await h.boss.send(queue, {});
  await h.boss.cancel(queue, jx!);
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jx!, 0, {
      state: 'cancelled',
      detail: { cancelledBy: 'user', reason: 'x' },
    }),
  ).resolves.toBeUndefined();
  const cancelledRow = await getRecords(h.pool, jx!);
  expect(cancelledRow[0]!.terminal_detail).toEqual({ cancelledBy: 'user', reason: 'x' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — Happy path: handler-throw failure end-to-end via boss.work.
// ─────────────────────────────────────────────────────────────────────────────
test('handler-throw failure end-to-end records terminal detail', async () => {
  const queue = 'td-work-throw';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });

  // Register a worker whose handler throws on every job; pg-boss will move
  // the row through active → failed (retryLimit: 0). The worker, on catching
  // the throw, calls recordTerminalDetail with state: 'failed' + a transient
  // class. We exercise the full lifecycle (not boss.fail directly).
  let observedJobId: string | undefined;
  let observedAttempt: number | undefined;
  const workId = await h.boss.work(
    queue,
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    async (jobs) => {
      const j = jobs[0]!;
      observedJobId = j.id;
      // pg-boss's Job type doesn't expose retry_count on the work payload; the
      // chronicle row reflects the attempt the trigger captured. For a first
      // attempt with retryLimit: 0 this is always 0.
      observedAttempt = 0;
      throw new Error('rate-limited');
    },
  );

  // Wait until the chronicle row has transitioned to failed.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rs = await getRecords(h.pool, jobId!);
    if (rs[0]?.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await h.boss.offWork(queue);
  void workId; // unused; offWork by queue name is sufficient

  const rowsAtFailed = await getRecords(h.pool, jobId!);
  expect(rowsAtFailed[0]!.state).toBe('failed');
  expect(observedJobId).toBe(jobId);

  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, observedAttempt!, {
    state: 'failed',
    detail: { class: 'transient', message: 'rate-limited' },
  });

  const job = await findById(h.pool, SCHEMAS, jobId!);
  expect(job).not.toBeNull();
  expect(job!.state).toBe('failed');
  expect(job!.terminalDetail).toMatchObject({
    class: 'transient',
    message: 'rate-limited',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — Wrong (jobId, attempt) is a silent no-op.
// ─────────────────────────────────────────────────────────────────────────────
test('wrong jobId/attempt is a silent no-op', async () => {
  await expect(
    recordTerminalDetail(
      h.pool,
      SCHEMAS,
      '00000000-0000-0000-0000-000000000000',
      0,
      { state: 'failed', detail: { class: 'transient' } },
    ),
  ).resolves.toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — Late call after pg-boss DELETE+INSERT retry.
// ─────────────────────────────────────────────────────────────────────────────
test('late recordTerminalDetail writes to attempt 0 while row is in retry state', async () => {
  const queue = 'td-late-after-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  // pg-boss creates attempt 1 only when a worker fetches it (DELETE+INSERT of
  // the prior row with retry_count incremented). Two fetches are required to
  // both produce the attempt-1 chronicle row and leave attempt-0 in retry.
  await h.boss.fetch(queue);                            // attempt 0 → active
  await h.boss.fail(queue, jobId!, { err: 'boom-0' });  // attempt 0 → retry
  await h.boss.fetch(queue);                            // attempt 1 row created (active)
  // attempt 0's chronicle row remains in state='retry' (the row-version preserved
  // by the capture trigger before pg-boss DELETE+INSERTed it as attempt 1).

  const beforeWrite = await getRecords(h.pool, jobId!);
  expect(beforeWrite.length).toBeGreaterThanOrEqual(2);
  const attemptZeroBefore = beforeWrite.find((r) => r.attempt === 0);
  expect(attemptZeroBefore).toBeDefined();
  expect(attemptZeroBefore!.state).toBe('retry');
  const attemptOneBefore = beforeWrite.find((r) => r.attempt === 1);
  expect(attemptOneBefore).toBeDefined();
  expect(attemptOneBefore!.terminal_detail).toBeNull();

  // Worker writes the detail for attempt 0 (the one it just handled). The
  // SQL state-bind ANY(['failed','retry']) makes this work against the
  // retry-state row left behind by pg-boss's DELETE+INSERT.
  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'boom-0' },
  });

  const history = await getRetryHistory(h.pool, SCHEMAS, jobId!);
  const attemptZero = history.find((r) => r.attempt === 0);
  expect(attemptZero).toBeDefined();
  expect(attemptZero!.terminalDetail).toMatchObject({
    class: 'transient',
    message: 'boom-0',
  });
  const attemptOne = history.find((r) => r.attempt === 1);
  expect(attemptOne).toBeDefined();
  expect(attemptOne!.terminalDetail).toBeNull();

  // Clean up — finish attempt 1 so pg-boss doesn't keep the queue active.
  await h.boss.complete(queue, jobId!, { ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — Concurrent calls — last-writer-wins.
// ─────────────────────────────────────────────────────────────────────────────
test('sequential calls overwrite — last-writer-wins', async () => {
  const queue = 'td-last-writer-wins';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'first' },
  });
  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'non_retryable', message: 'second' },
  });

  const job = await findById(h.pool, SCHEMAS, jobId!);
  expect(job!.terminalDetail).toMatchObject({
    class: 'non_retryable',
    message: 'second',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — State-mismatch is a silent no-op.
// ─────────────────────────────────────────────────────────────────────────────
test('state-mismatch is a silent no-op (failed payload against completed row)', async () => {
  const queue = 'td-state-mismatch';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const before = await getRecords(h.pool, jobId!);
  expect(before[0]!.state).toBe('completed');
  expect(before[0]!.terminal_detail).toBeNull();

  // The SQL state-bind is ANY(['failed','retry']) — won't match 'completed'.
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: { class: 'transient' },
    }),
  ).resolves.toBeUndefined();

  const after = await getRecords(h.pool, jobId!);
  expect(after[0]!.terminal_detail).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — JSON.stringify edge cases (BigInt + circular).
// ─────────────────────────────────────────────────────────────────────────────
test('throws on BigInt in detail (JSON.stringify throws synchronously)', async () => {
  const queue = 'td-bigint';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: { class: 'transient', id: 1n } as unknown as TerminalDetailFailed,
    }),
  ).rejects.toThrow(/pg-bossier: terminal_detail validation:.*BigInt/i);

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toBeNull();
});

test('throws on circular reference in detail', async () => {
  const queue = 'td-circular';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const detail: Record<string, unknown> = { class: 'transient' };
  detail.self = detail;
  await expect(
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: detail as unknown as TerminalDetailFailed,
    }),
  ).rejects.toThrow(/pg-bossier: terminal_detail validation:.*not JSON-serializable/);

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toBeNull();
});

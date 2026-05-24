import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { recordDeadLetter } from '../src/dead-letter.js';
import { recordTerminalDetail } from '../src/terminal-detail.js';
import { findDeadLetterSource, findDeadLetterTarget } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Happy round-trip: send, fail via boss.work handler-throw,
// recordDeadLetter, verify terminal_detail.deadLetteredAs is set.
// ─────────────────────────────────────────────────────────────────────────────
test('recordDeadLetter writes deadLetteredAs onto the source\'s last failed row', async () => {
  const queue = 'dl-happy';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  expect(jobId).toBeTruthy();

  // Drive the failure through the worker so the chronicle row transitions to 'failed'.
  await h.boss.work(
    queue,
    { batchSize: 1, pollingIntervalSeconds: 0.5 },
    () => { throw new Error('boom'); },
  );

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rs = await getRecords(h.pool, jobId!);
    if (rs[0]?.state === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await h.boss.offWork(queue);

  const dlqJobId = randomUUID();
  await recordDeadLetter(h.pool, SCHEMAS, {
    sourceJobId: jobId!,
    dlqJobId,
  });

  const rows = await getRecords(h.pool, jobId!);
  const failedRow = rows.find((r) => r.state === 'failed');
  expect(failedRow).toBeDefined();
  expect(failedRow!.terminal_detail).toEqual({ deadLetteredAs: dlqJobId });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Source row not found is a fail-open warning + no throw.
// ─────────────────────────────────────────────────────────────────────────────
test('recordDeadLetter logs not_found warning when no failed row exists for the source', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const phantomSource = randomUUID();
    await expect(
      recordDeadLetter(h.pool, SCHEMAS, {
        sourceJobId: phantomSource,
        dlqJobId: randomUUID(),
      }),
    ).resolves.toBeUndefined();

    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('not_found'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Conflicting second call: first write wins; warning logged.
// ─────────────────────────────────────────────────────────────────────────────
test('recordDeadLetter conflict: existing different dlqJobId is preserved, conflict warning logged', async () => {
  const queue = 'dl-conflict';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const firstDlq = randomUUID();
  const secondDlq = randomUUID();

  await recordDeadLetter(h.pool, SCHEMAS, {
    sourceJobId: jobId!,
    dlqJobId: firstDlq,
  });

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await recordDeadLetter(h.pool, SCHEMAS, {
      sourceJobId: jobId!,
      dlqJobId: secondDlq,
    });
    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('conflict'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toEqual({ deadLetteredAs: firstDlq });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — Idempotent same-id call: no warning.
// ─────────────────────────────────────────────────────────────────────────────
test('recordDeadLetter idempotent: same dlqJobId twice is a no-op without warning', async () => {
  const queue = 'dl-idempotent';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const dlqJobId = randomUUID();

  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });

  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toEqual({ deadLetteredAs: dlqJobId });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — Composition with recordTerminalDetail (terminal-detail-first order).
// ─────────────────────────────────────────────────────────────────────────────
test('composition: recordTerminalDetail then recordDeadLetter merges keys', async () => {
  const queue = 'dl-compose-td-first';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'rate limited' },
  });

  const dlqJobId = randomUUID();
  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toEqual({
    class: 'transient',
    message: 'rate limited',
    deadLetteredAs: dlqJobId,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — Composition with recordTerminalDetail (deadLetter-first order)
// — this is the test that locks the OPTION-A merge fix.
// ─────────────────────────────────────────────────────────────────────────────
test('composition: recordDeadLetter then recordTerminalDetail preserves deadLetteredAs', async () => {
  const queue = 'dl-compose-dl-first';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const dlqJobId = randomUUID();
  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });

  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'non_retryable' },
  });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toEqual({
    class: 'non_retryable',
    deadLetteredAs: dlqJobId,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — Concurrent writes don't race destructively. JSONB || is atomic
// per UPDATE; final row should have both keys present.
// ─────────────────────────────────────────────────────────────────────────────
test('concurrent recordDeadLetter and recordTerminalDetail: both fields survive', async () => {
  const queue = 'dl-concurrent';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const dlqJobId = randomUUID();
  await Promise.all([
    recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId }),
    recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
      state: 'failed',
      detail: { class: 'transient', message: 'concurrent' },
    }),
  ]);

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.terminal_detail).toMatchObject({
    class: 'transient',
    message: 'concurrent',
    deadLetteredAs: dlqJobId,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — findDeadLetterSource: happy + null cases.
// ─────────────────────────────────────────────────────────────────────────────
test('findDeadLetterSource returns the source attempt for a linked dlqJobId, null otherwise', async () => {
  const queue = 'dl-find-source';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const dlqJobId = randomUUID();
  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });

  const found = await findDeadLetterSource(h.pool, SCHEMAS, dlqJobId);
  expect(found).not.toBeNull();
  expect(found!.jobId).toBe(jobId);
  expect(found!.queue).toBe(queue);
  expect(typeof found!.attempt).toBe('number');

  const missing = await findDeadLetterSource(h.pool, SCHEMAS, randomUUID());
  expect(missing).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — findDeadLetterTarget: happy + null cases.
// ─────────────────────────────────────────────────────────────────────────────
test('findDeadLetterTarget returns the DLQ link for a source job, null otherwise', async () => {
  const queue = 'dl-find-target';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });

  const dlqJobId = randomUUID();
  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobId!, dlqJobId });

  const found = await findDeadLetterTarget(h.pool, SCHEMAS, jobId!);
  expect(found).not.toBeNull();
  expect(found!.dlqJobId).toBe(dlqJobId);
  expect(typeof found!.attempt).toBe('number');

  const missing = await findDeadLetterTarget(h.pool, SCHEMAS, randomUUID());
  expect(missing).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — Chained DLQ A→B→C. Locks the multi-hop walk: each link is
// resolved at the per-hop step, not transitively.
// ─────────────────────────────────────────────────────────────────────────────
test('chained DLQ A→B→C: findDeadLetterSource/Target walk one hop at a time', async () => {
  const queueA = 'dl-chain-a';
  const queueB = 'dl-chain-b';
  await h.boss.createQueue(queueA);
  await h.boss.createQueue(queueB);

  // Source A: real failed job in queueA.
  const jobA = await h.boss.send(queueA, {}, { retryLimit: 0 });
  await h.boss.fetch(queueA);
  await h.boss.fail(queueA, jobA!, { err: 'a-failed' });

  // Source B: a real failed job in queueB (because B is itself a source on
  // the next hop, recordDeadLetter requires a failed row to attach to).
  const jobB = await h.boss.send(queueB, {}, { retryLimit: 0 });
  await h.boss.fetch(queueB);
  await h.boss.fail(queueB, jobB!, { err: 'b-failed' });

  // C is just a downstream UUID — no real DLQ row needed.
  const jobC = randomUUID();

  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobA!, dlqJobId: jobB! });
  await recordDeadLetter(h.pool, SCHEMAS, { sourceJobId: jobB!, dlqJobId: jobC });

  // Reverse walk: C points at B; B points at A.
  const sourceOfC = await findDeadLetterSource(h.pool, SCHEMAS, jobC);
  expect(sourceOfC).not.toBeNull();
  expect(sourceOfC!.jobId).toBe(jobB);

  const sourceOfB = await findDeadLetterSource(h.pool, SCHEMAS, jobB!);
  expect(sourceOfB).not.toBeNull();
  expect(sourceOfB!.jobId).toBe(jobA);

  // Forward walk: A points at B; B points at C.
  const targetOfA = await findDeadLetterTarget(h.pool, SCHEMAS, jobA!);
  expect(targetOfA).not.toBeNull();
  expect(targetOfA!.dlqJobId).toBe(jobB);

  const targetOfB = await findDeadLetterTarget(h.pool, SCHEMAS, jobB!);
  expect(targetOfB).not.toBeNull();
  expect(targetOfB!.dlqJobId).toBe(jobC);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11 — EXPLAIN confirms findDeadLetterSource's @> probe is index-eligible.
// Forces enable_seqscan = off because at test-suite scale the planner picks
// a seq scan over the small table even though the GIN index is present.
// ─────────────────────────────────────────────────────────────────────────────
test('findDeadLetterSource uses the terminal_detail GIN index', async () => {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT job_id FROM ${SCHEMAS.pgbossier}.record
       WHERE terminal_detail @> jsonb_build_object('deadLetteredAs', $1::text)
       LIMIT 1`,
      ['00000000-0000-0000-0000-000000000000'],
    );
    await client.query('ROLLBACK');
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/record_terminal_detail_gin/i);
  } finally {
    client.release();
  }
});

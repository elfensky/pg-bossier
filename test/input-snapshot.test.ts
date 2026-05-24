import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { recordInputSnapshot, getInputSnapshot } from '../src/input-snapshot.js';
import { getRetryHistory } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Happy round-trip with explicit attempt.
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot + getInputSnapshot round-trip with explicit attempt', async () => {
  const queue = 'is-happy-explicit';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  expect(jobId).toBeTruthy();

  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { records: ['a', 'b'] });

  const result = await getInputSnapshot<{ records: string[] }>(h.pool, SCHEMAS, jobId!, 0);
  expect(result).toEqual({ records: ['a', 'b'] });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Happy round-trip without attempt (returns wrapped result).
// ─────────────────────────────────────────────────────────────────────────────
test('getInputSnapshot without attempt returns the wrapped {snapshot, attempt} result', async () => {
  const queue = 'is-happy-wrapped';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { records: ['a', 'b'] });

  const result = await getInputSnapshot<{ records: string[] }>(h.pool, SCHEMAS, jobId!);
  expect(result).toEqual({ snapshot: { records: ['a', 'b'] }, attempt: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Reader explicit-attempt vs most-recent.
// ─────────────────────────────────────────────────────────────────────────────
test('reader explicit-attempt returns T; reader without attempt returns wrapped result', async () => {
  const queue = 'is-explicit-vs-recent';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { phase: 'one' });

  const explicit = await getInputSnapshot<{ phase: string }>(h.pool, SCHEMAS, jobId!, 0);
  expect(explicit).toEqual({ phase: 'one' });

  const wrapped = await getInputSnapshot<{ phase: string }>(h.pool, SCHEMAS, jobId!);
  expect(wrapped).toEqual({ snapshot: { phase: 'one' }, attempt: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — Reader UUID guard: malformed jobId resolves to null without hitting DB.
// ─────────────────────────────────────────────────────────────────────────────
test('getInputSnapshot UUID guard: malformed jobId resolves to null', async () => {
  await expect(getInputSnapshot(h.pool, SCHEMAS, 'not-a-uuid')).resolves.toBeNull();
  await expect(getInputSnapshot(h.pool, SCHEMAS, 'not-a-uuid', 0)).resolves.toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — Reader returns null for unknown valid-UUID jobId.
// ─────────────────────────────────────────────────────────────────────────────
test('getInputSnapshot returns null for unknown jobId', async () => {
  const phantom = randomUUID();
  await expect(getInputSnapshot(h.pool, SCHEMAS, phantom)).resolves.toBeNull();
  await expect(getInputSnapshot(h.pool, SCHEMAS, phantom, 0)).resolves.toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — Writer rejects undefined with prefixed message.
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot throws on undefined snapshot', async () => {
  const queue = 'is-reject-undefined';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  await expect(
    recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, undefined),
  ).rejects.toThrow(/pg-bossier: input_snapshot validation: snapshot must not be undefined/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — Writer rejects null with prefixed message.
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot throws on null snapshot', async () => {
  const queue = 'is-reject-null';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  await expect(
    recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, null),
  ).rejects.toThrow(/pg-bossier: input_snapshot validation: snapshot must not be null/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — Writer rejects non-JSON-serializable values (BigInt, circular ref).
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot throws on non-JSON-serializable values', async () => {
  const queue = 'is-reject-nonjson';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  // BigInt: JSON.stringify throws synchronously.
  await expect(
    recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, 10n),
  ).rejects.toThrow(/pg-bossier: input_snapshot validation/);

  // Circular reference: JSON.stringify throws synchronously.
  const circular: Record<string, unknown> = { name: 'self' };
  circular.self = circular;
  await expect(
    recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, circular),
  ).rejects.toThrow(/pg-bossier: input_snapshot validation/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — Primitive snapshots round-trip (number, string, boolean, array).
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot accepts primitive snapshots (number, string, boolean, array)', async () => {
  const queue = 'is-primitives';
  await h.boss.createQueue(queue);

  const numJobId = await h.boss.send(queue, {});
  await recordInputSnapshot(h.pool, SCHEMAS, numJobId!, 0, 42);
  expect(await getInputSnapshot<number>(h.pool, SCHEMAS, numJobId!, 0)).toBe(42);

  const strJobId = await h.boss.send(queue, {});
  await recordInputSnapshot(h.pool, SCHEMAS, strJobId!, 0, 'hello');
  expect(await getInputSnapshot<string>(h.pool, SCHEMAS, strJobId!, 0)).toBe('hello');

  const boolJobId = await h.boss.send(queue, {});
  await recordInputSnapshot(h.pool, SCHEMAS, boolJobId!, 0, true);
  expect(await getInputSnapshot<boolean>(h.pool, SCHEMAS, boolJobId!, 0)).toBe(true);

  const arrJobId = await h.boss.send(queue, {});
  await recordInputSnapshot(h.pool, SCHEMAS, arrJobId!, 0, [1, 2, 3]);
  expect(await getInputSnapshot<number[]>(h.pool, SCHEMAS, arrJobId!, 0)).toEqual([1, 2, 3]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — Non-finite numbers: NaN → JSON null per JSON.stringify standard.
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot serializes NaN to JSON null (standard JSON.stringify behavior)', async () => {
  const queue = 'is-nonfinite';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { x: NaN });

  const result = await getInputSnapshot<{ x: number | null }>(h.pool, SCHEMAS, jobId!, 0);
  expect(result).toEqual({ x: null });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11 — Silent no-op on wrong (jobId, attempt): warning logged, no throw.
// ─────────────────────────────────────────────────────────────────────────────
test('recordInputSnapshot is a silent no-op (logs not_found) on wrong (jobId, attempt)', async () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const phantom = randomUUID();
    await expect(
      recordInputSnapshot(h.pool, SCHEMAS, phantom, 0, { x: 1 }),
    ).resolves.toBeUndefined();

    const calls = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('not_found'))).toBe(true);
  } finally {
    warnSpy.mockRestore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12 — Retry preservation across DELETE+INSERT: both attempts retain
// their respective input snapshots, visible via getRetryHistory.
// ─────────────────────────────────────────────────────────────────────────────
test('input snapshots are preserved per-attempt across pg-boss DELETE+INSERT retries', async () => {
  const queue = 'is-retry-preservation';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  // attempt 0 -> active, write snapshot, fail
  await h.boss.fetch(queue);
  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { phase: 'zero', source: 'first' });
  await h.boss.fail(queue, jobId!, { err: 'boom' });

  // pg-boss DELETE+INSERT -> attempt 1; fetch and write a different snapshot, complete
  await h.boss.fetch(queue);
  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 1, { phase: 'one', source: 'second' });
  await h.boss.complete(queue, jobId!, { ok: true });

  // Both rows survive; each row carries its own snapshot.
  const rows = await getRecords(h.pool, jobId!);
  expect(rows.map((r) => r.attempt)).toEqual([0, 1]);
  expect(rows[0]!.input_snapshot).toEqual({ phase: 'zero', source: 'first' });
  expect(rows[1]!.input_snapshot).toEqual({ phase: 'one', source: 'second' });

  // getRetryHistory exposes the snapshots in attempt order via `inputSnapshot` field.
  const history = await getRetryHistory(h.pool, SCHEMAS, jobId!);
  expect(history.map((r) => r.inputSnapshot)).toEqual([
    { phase: 'zero', source: 'first' },
    { phase: 'one', source: 'second' },
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13 — GIN index on input_snapshot exists after install.
// ─────────────────────────────────────────────────────────────────────────────
test('GIN index on input_snapshot is created by install', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'record' AND indexname = 'record_input_snapshot_gin'`,
    [SCHEMAS.pgbossier],
  );
  expect(rows.length).toBe(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 14 — GIN index is used for containment query.
// Forces enable_seqscan = off because at test-suite scale the planner picks
// a seq scan over the small table even though the GIN index is present.
// (Mirrors the pattern used in test/dead-letter.test.ts Test 11.)
// ─────────────────────────────────────────────────────────────────────────────
test('GIN index is used for input_snapshot containment query', async () => {
  // Populate a few rows so the planner has something to scan.
  const queue = 'is-gin-explain';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) {
    const jobId = await h.boss.send(queue, {});
    await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, { kind: 'foo', i });
  }

  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (FORMAT TEXT)
       SELECT job_id FROM ${SCHEMAS.pgbossier}.record
       WHERE input_snapshot @> $1::jsonb
       LIMIT 1`,
      [JSON.stringify({ kind: 'foo' })],
    );
    await client.query('ROLLBACK');
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/record_input_snapshot_gin/i);
  } finally {
    client.release();
  }
});

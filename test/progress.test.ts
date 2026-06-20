import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { setProgress, getProgress } from '../src/progress.js';
import { getRetryHistory } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('setProgress writes progress to the current attempt row', async () => {
  const queue = 'progress-set';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, SCHEMAS, jobId!, { processed: 120, total: 500 });
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ processed: 120, total: 500 });
});

test('setProgress accepts a bare display string', async () => {
  const queue = 'progress-set-string';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, SCHEMAS, jobId!, 'Step 3 of 5');
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toBe('Step 3 of 5');
});

test('setProgress throws on null, undefined, or a non-serializable value', async () => {
  const queue = 'progress-set-bad';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await expect(setProgress(h.pool, SCHEMAS, jobId!, null)).rejects.toThrow();
  await expect(setProgress(h.pool, SCHEMAS, jobId!, undefined)).rejects.toThrow();
  await expect(setProgress(h.pool, SCHEMAS, jobId!, 10n)).rejects.toThrow();
});

test('setProgress is a no-op (no throw) for an unknown or malformed job id', async () => {
  await expect(
    setProgress(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000', { x: 1 }),
  ).resolves.toBeUndefined();
  await expect(
    setProgress(h.pool, SCHEMAS, 'not-a-uuid', { x: 1 }),
  ).resolves.toBeUndefined();
});

test('getProgress returns the value and its source attempt', async () => {
  const queue = 'progress-get';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setProgress(h.pool, SCHEMAS, jobId!, { pct: 40 });
  const result = await getProgress(h.pool, SCHEMAS, jobId!);
  // attempt: 0 — initial attempt of a freshly-sent job (no retries yet)
  expect(result).toEqual({ progress: { pct: 40 }, attempt: 0 });
});

test('getProgress returns null for a job that never wrote progress', async () => {
  const queue = 'progress-get-none';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await expect(getProgress(h.pool, SCHEMAS, jobId!)).resolves.toBeNull();
});

test('getProgress returns null for unknown and malformed job ids', async () => {
  await expect(
    getProgress(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000'),
  ).resolves.toBeNull();
  await expect(getProgress(h.pool, SCHEMAS, 'not-a-uuid')).resolves.toBeNull();
});

test('getProgress carries the prior attempt forward through a retry gap', async () => {
  const queue = 'progress-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  await h.boss.fetch(queue);                          // attempt 0 -> active
  await setProgress(h.pool, SCHEMAS, jobId!, { processed: 200 });
  await h.boss.fail(queue, jobId!, { err: 'boom' });  // attempt 0 -> retry
  await h.boss.fetch(queue);                          // attempt 1 -> active

  // attempt 1's row exists with progress still NULL
  const rows = await getRecords(h.pool, jobId!);
  expect(rows.map((r) => r.attempt)).toEqual([0, 1]);
  expect(rows[1]!.progress).toBeNull();

  // getProgress carries attempt 0's value forward; its attempt is the lower one
  expect(await getProgress(h.pool, SCHEMAS, jobId!)).toEqual({
    progress: { processed: 200 }, attempt: 0,
  });

  // once attempt 1 writes, getProgress flips to it
  await setProgress(h.pool, SCHEMAS, jobId!, { processed: 480 });
  expect(await getProgress(h.pool, SCHEMAS, jobId!)).toEqual({
    progress: { processed: 480 }, attempt: 1,
  });

  await h.boss.complete(queue, jobId!, { ok: true });
});

test('per-attempt progress stays visible via getRetryHistory after terminal state', async () => {
  const queue = 'progress-forensic';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  await h.boss.fetch(queue);
  await setProgress(h.pool, SCHEMAS, jobId!, { attempt: 'zero' });
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await setProgress(h.pool, SCHEMAS, jobId!, { attempt: 'one' });
  await h.boss.complete(queue, jobId!, { ok: true });

  const history = await getRetryHistory(h.pool, SCHEMAS, jobId!);
  expect(history.map((r) => r.progress)).toEqual([
    { attempt: 'zero' }, { attempt: 'one' },
  ]);
});

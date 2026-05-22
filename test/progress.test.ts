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

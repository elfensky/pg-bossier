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

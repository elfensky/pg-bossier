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

test('app-hook columns survive a later capture-trigger re-fire', async () => {
  const queue = 'client-survive';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 2 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 7 } });

  // a state change re-fires the capture trigger (ON CONFLICT DO UPDATE)
  await h.boss.fetch(queue); // created -> active

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');          // trigger updated its own column
  expect(rows[0]!.progress).toEqual({ done: 7 }); // app-hook column was NOT clobbered
});

test('the client exposes the read methods bound to its pool', async () => {
  const queue = 'client-read';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { via: 'client' });

  const client = bossier({ boss: h.boss, pool: h.pool });
  const job = await client.findById(jobId!);
  expect(job!.jobId).toBe(jobId);

  const listed = await client.listJobs({ queue });
  expect(listed.total).toBe(1);

  expect(typeof client.getRetryHistory).toBe('function');
  expect(typeof client.latestPerQueue).toBe('function');
  expect(typeof client.countByState).toBe('function');
  expect(typeof client.countByQueue).toBe('function');
  expect(typeof client.listLongRunning).toBe('function');
});

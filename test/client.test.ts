import { test, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

/** The eight methods pg-bossier adds on top of pg-boss's API. */
const BOSSIER_METHOD_NAMES = [
  'recordPatch', 'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
] as const;

test('recordPatch writes app-hook columns without clobbering trigger columns', async () => {
  const queue = 'client-q';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 5 } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ done: 5 });
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ in: 1 });
});

test('forwarded pg-boss queue ops run through the unified client', async () => {
  const queue = 'client-forward';
  const client = bossier({ boss: h.boss, pool: h.pool });

  // createQueue/send/fetch/complete are pg-boss methods, called on the
  // bossier client. If proxy method-binding were wrong, these would throw
  // "Cannot read private member" — pg-boss 12 uses #private fields.
  await client.createQueue(queue);
  const jobId = await client.send(queue, { forwarded: true });
  expect(jobId).toBeTruthy();

  const [job] = await client.fetch(queue);
  expect(job!.id).toBe(jobId);
  await client.complete(queue, jobId!);

  // the capture trigger still recorded every transition
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('completed');
});

test('the unified client is still a PgBoss instance', () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(client instanceof PgBoss).toBe(true);
});

test('forwarded EventEmitter methods bind to the underlying instance', () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const before = h.boss.listenerCount('error');
  const listener = (): void => undefined;
  client.on('error', listener);
  // the listener landed on the real instance, where pg-boss emits from
  expect(h.boss.listenerCount('error')).toBe(before + 1);
  h.boss.removeListener('error', listener);
});

test('app-hook columns survive a later capture-trigger re-fire', async () => {
  const queue = 'client-survive';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 2 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 7 } });

  await h.boss.fetch(queue); // created -> active, re-fires the trigger

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');
  expect(rows[0]!.progress).toEqual({ done: 7 });
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

  const history = await client.getRetryHistory(jobId!);
  expect(history.map((r) => r.attempt)).toEqual([0]);

  const latest = await client.latestPerQueue([queue]);
  expect(latest[0]!.jobId).toBe(jobId);

  const byState = await client.countByState({ queue });
  expect(byState.created).toBe(1);

  const byQueue = await client.countByQueue({ queue });
  expect(byQueue[queue]).toBe(1);

  const longRunning = await client.listLongRunning({ queue, longerThanSeconds: 0 });
  expect(longRunning).toEqual([]);
});

test('pg-bossier method names do not collide with pg-boss method names', () => {
  const pgBossMethods = new Set(Object.getOwnPropertyNames(PgBoss.prototype));
  for (const name of BOSSIER_METHOD_NAMES) {
    expect(pgBossMethods.has(name)).toBe(false);
  }
});

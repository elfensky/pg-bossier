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

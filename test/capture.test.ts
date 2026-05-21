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

import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { findById, getRetryHistory } from '../src/read.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('findById returns the latest attempt of a job', async () => {
  const queue = 'read-findbyid';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { n: 1 });

  const job = await findById(h.pool, jobId!);
  expect(job).not.toBeNull();
  expect(job!.jobId).toBe(jobId);
  expect(job!.queue).toBe(queue);
  expect(job!.state).toBe('created');
  expect(job!.attempt).toBe(0);
  expect(job!.data).toEqual({ n: 1 });
});

test('findById returns null for an unknown job id', async () => {
  const job = await findById(h.pool, '00000000-0000-0000-0000-000000000000');
  expect(job).toBeNull();
});

test('findById returns null for a malformed job id (no Postgres error)', async () => {
  const job = await findById(h.pool, 'not-a-uuid');
  expect(job).toBeNull();
});

test('findById returns the current attempt of a retried job, not attempt 0', async () => {
  const queue = 'read-findbyid-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'first' });   // attempt 0 -> retry
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });    // attempt 1 -> completed

  const job = await findById(h.pool, jobId!);
  expect(job!.attempt).toBe(1);
  expect(job!.state).toBe('completed');
});

test('getRetryHistory returns every attempt of a job, oldest first', async () => {
  const queue = 'read-history';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 2 });

  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-0' });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-1' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const history = await getRetryHistory(h.pool, jobId!);
  expect(history.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(history[2]!.state).toBe('completed');
});

test('getRetryHistory returns an empty array for an unknown job id', async () => {
  const history = await getRetryHistory(h.pool, '00000000-0000-0000-0000-000000000000');
  expect(history).toEqual([]);
});

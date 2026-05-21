import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { findById, getRetryHistory, listJobs } from '../src/read.js';

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

test('listJobs filters by queue and reports an accurate total', async () => {
  const queue = 'read-list';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 5; i++) await h.boss.send(queue, { i });

  const result = await listJobs(h.pool, { queue });
  expect(result.total).toBe(5);
  expect(result.rows).toHaveLength(5);
  expect(result.rows.every((r) => r.queue === queue)).toBe(true);
});

test('listJobs paginates without overlap and total is independent of limit', async () => {
  const queue = 'read-list-page';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 6; i++) await h.boss.send(queue, { i });

  const page1 = await listJobs(h.pool, { queue, limit: 2, offset: 0 });
  const page2 = await listJobs(h.pool, { queue, limit: 2, offset: 2 });
  expect(page1.total).toBe(6);
  expect(page2.total).toBe(6);
  const ids1 = page1.rows.map((r) => r.jobId);
  const ids2 = page2.rows.map((r) => r.jobId);
  expect(ids1).toHaveLength(2);
  expect(ids2).toHaveLength(2);
  expect(ids1.some((id) => ids2.includes(id))).toBe(false);
});

test('listJobs filters by state and counts a retried job once', async () => {
  const queue = 'read-list-state';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const result = await listJobs(h.pool, { queue, states: ['completed'] });
  expect(result.total).toBe(1);
  expect(result.rows[0]!.jobId).toBe(jobId);
});

test('listJobs returns an empty result for a queue with no jobs', async () => {
  const result = await listJobs(h.pool, { queue: 'read-list-empty' });
  expect(result).toEqual({ rows: [], total: 0 });
});

test('listJobs filters by a creation-time window', async () => {
  const queue = 'read-list-window';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) await h.boss.send(queue, { i });

  const hourAgo = new Date(Date.now() - 3_600_000);
  const hourAhead = new Date(Date.now() + 3_600_000);
  const recent = await listJobs(h.pool, { queue, createdAfter: hourAgo });
  expect(recent.total).toBe(3);
  const future = await listJobs(h.pool, { queue, createdAfter: hourAhead });
  expect(future.total).toBe(0);
});

test('listJobs rejects a non-positive limit', async () => {
  await expect(listJobs(h.pool, { limit: 0 })).rejects.toThrow();
});

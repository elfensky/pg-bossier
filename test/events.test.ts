import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { subscribe } from '../src/events.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('subscribe() returns events that emit "connected" on LISTEN', async () => {
  const events = await subscribe(h.pool);
  // Most implementations emit 'connected' before subscribe() resolves.
  // Either we caught it already or it'll fire on a future tick.
  const connected = new Promise<void>((resolve) => events.once('connected', resolve));
  await Promise.race([
    connected,
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
  ]);
  await events.close();
});

test('close() releases the connection back to the pool', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  // After close, idle count should equal total (connection released).
  expect(h.pool.idleCount).toBe(h.pool.totalCount);
});

test('close() is idempotent', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  await events.close();
});

test('five event types fire for a job that fails-with-retry-then-succeeds', async () => {
  const queue = 'evt-six';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const seen: { event: string; attempt: number }[] = [];
  for (const name of ['created', 'started', 'completed', 'failed', 'cancelled', 'retried'] as const) {
    events.on(name, (e) => seen.push({ event: name, attempt: e.attempt }));
  }

  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 200));

  // pg-boss retries by DELETE+INSERT with state='retry' (same retry_count=0),
  // then fetchNextJob UPDATEs retry_count to 1 and state='active' in one step.
  // There is no separate 'created' notification for attempt 1 — the row goes
  // directly retry→active. Verified against test/capture.test.ts behavior.
  expect(seen).toEqual([
    { event: 'created',   attempt: 0 },
    { event: 'started',   attempt: 0 },
    { event: 'retried',   attempt: 0 },
    { event: 'started',   attempt: 1 },
    { event: 'completed', attempt: 1 },
  ]);
  await events.close();
});

test("catch-all 'job' listener receives every transition", async () => {
  const queue = 'evt-catchall';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const all: string[] = [];
  events.on('job', (e) => all.push(e.event));

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  expect(all).toEqual(['created', 'started', 'completed']);
  await events.close();
});

test("per-type event fires before 'job' for the same transition", async () => {
  const queue = 'evt-order';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const order: string[] = [];
  events.on('completed', () => order.push('completed-listener'));
  events.on('job', (e) => order.push(`job-listener(${e.event})`));

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  const idx = order.indexOf('completed-listener');
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(order[idx + 1]).toBe('job-listener(completed)');
  await events.close();
});

test('seq on emitted events is monotonically increasing', async () => {
  const queue = 'evt-seq';
  await h.boss.createQueue(queue);
  const events = await subscribe(h.pool);
  const seqs: bigint[] = [];
  events.on('job', (e) => seqs.push(e.seq));

  for (let i = 0; i < 3; i++) {
    const jobId = await h.boss.send(queue, { i });
    await h.boss.fetch(queue);
    await h.boss.complete(queue, jobId!, { i });
  }
  await new Promise((r) => setTimeout(r, 200));

  expect(seqs.length).toBe(9);
  for (let i = 1; i < seqs.length; i++) {
    expect(seqs[i]! > seqs[i - 1]!).toBe(true);
  }
  await events.close();
});

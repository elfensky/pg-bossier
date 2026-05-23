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

test("unknown state passes through with event = state and fires 'warning' once", async () => {
  const events = await subscribe(h.pool);
  const jobEvents: { event: string; state: string }[] = [];
  const warnings: { unknownState: string; jobId: string }[] = [];
  events.on('job', (e) => jobEvents.push({ event: e.event, state: e.state }));
  events.on('warning', (w) => warnings.push({ unknownState: w.unknownState, jobId: w.jobId }));

  const fakeId = '00000000-0000-0000-0000-000000000aaa';
  const payload1 = JSON.stringify({
    job_id: fakeId, queue: 'q', attempt: 0, state: 'paused', seq: 999999, captured_at: new Date().toISOString(),
  });
  const payload2 = JSON.stringify({
    job_id: fakeId, queue: 'q', attempt: 1, state: 'paused', seq: 1000000, captured_at: new Date().toISOString(),
  });
  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload1]);
  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload2]);
  await new Promise((r) => setTimeout(r, 100));

  expect(jobEvents).toEqual([
    { event: 'paused', state: 'paused' },
    { event: 'paused', state: 'paused' },
  ]);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toEqual({ unknownState: 'paused', jobId: fakeId });
  await events.close();
});

test("thrown handler routes to 'error' (reason='handler'); stream continues", async () => {
  const events = await subscribe(h.pool);
  const errors: { reason: string; error: unknown }[] = [];
  const after: string[] = [];
  events.on('error', (ev) => errors.push({ reason: ev.reason, error: ev.error }));
  events.on('completed', () => { throw new Error('boom from handler'); });
  events.on('job', (e) => after.push(e.event));

  const queue = 'evt-handler-throw';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 200));

  expect(errors.some((e) => e.reason === 'handler')).toBe(true);
  expect(after).toContain('completed');
  await events.close();
});

test("malformed JSON fires 'error' (reason='parse'); stream continues", async () => {
  const events = await subscribe(h.pool);
  const errors: { reason: string }[] = [];
  let jobEventsAfter = 0;
  events.on('error', (ev) => errors.push({ reason: ev.reason }));
  events.on('job', () => { jobEventsAfter += 1; });

  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, ['{not valid json']);

  const queue = 'evt-after-parse-error';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 150));

  expect(errors.map((e) => e.reason)).toContain('parse');
  expect(jobEventsAfter).toBeGreaterThan(0);
  await events.close();
});

test("reconnect after pg_terminate_backend; 'error' (gap) then 'connected'", async () => {
  const events = await subscribe(h.pool);
  const log: string[] = [];
  events.on('connected', () => log.push('connected'));
  events.on('error', (ev) => log.push(`error:${ev.reason}`));

  // Find any backend with our LISTEN registered.
  const { rows } = await h.pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
  );
  expect(rows.length).toBeGreaterThan(0);
  await h.pool.query(`SELECT pg_terminate_backend($1)`, [rows[0]!.pid]);

  await new Promise((r) => setTimeout(r, 3000));

  expect(log).toContain('connected');
  expect(log).toContain('error:gap');
  expect(log.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);

  const queue = 'evt-reconnect';
  await h.boss.createQueue(queue);
  const got: string[] = [];
  events.on('job', (e) => got.push(e.event));
  await h.boss.send(queue, {});
  await new Promise((r) => setTimeout(r, 200));
  expect(got).toContain('created');

  await events.close();
}, 10_000);

test('close() during backoff wait cancels reconnect', async () => {
  const events = await subscribe(h.pool);

  const { rows } = await h.pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
  );
  await h.pool.query(`SELECT pg_terminate_backend($1)`, [rows[0]!.pid]);

  // Close during the backoff wait.
  await new Promise((r) => setTimeout(r, 50));
  await events.close();

  let secondConnected = false;
  events.on('connected', () => { secondConnected = true; });
  await new Promise((r) => setTimeout(r, 2000));
  expect(secondConnected).toBe(false);
}, 10_000);

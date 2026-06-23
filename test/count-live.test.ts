import { test, expect, beforeEach, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #27: countByState/countByQueue count the chronicle by default, which RETAINS
// jobs pg-boss has deleted — an all-time superset of live queue depth. The
// { live: true } option counts the live pgboss.job table instead.

let h: Harness;
beforeEach(async () => { h = await startHarness(); await install(h.pool); });
afterEach(async () => { await h.teardown(); });

test('{ live: true } excludes a GC-deleted job the chronicle still retains', async () => {
  const queue = 'count-gc';
  await h.boss.createQueue(queue);

  // Job A: run to completion, then simulate pg-boss GC (DELETE the live row —
  // DELETE does not fire the UPDATE OF state trigger, so the record survives).
  const a = (await h.boss.send(queue, {}))!;
  await h.boss.fetch(queue);
  await h.boss.complete(queue, a);
  await h.pool.query(`DELETE FROM pgboss.job WHERE id = $1`, [a]);

  // Job B: still live (created).
  await h.boss.send(queue, {});

  const client = bossier({ boss: h.boss, pool: h.pool });

  // Chronicle: A (completed, GC'd) is still counted — the superset.
  const chronicle = await client.countByState({ queue });
  expect(chronicle.completed).toBe(1);
  expect(chronicle.created).toBe(1);

  // Live: A is gone from pgboss.job; only B remains.
  const live = await client.countByState({ queue, live: true });
  expect(live.completed).toBe(0);
  expect(live.created).toBe(1);
});

test('countByQueue { live: true } groups the live pgboss.job table by queue', async () => {
  await h.boss.createQueue('lq-a');
  await h.boss.createQueue('lq-b');
  await h.boss.send('lq-a', {});
  await h.boss.send('lq-a', {});
  await h.boss.send('lq-b', {});

  const client = bossier({ boss: h.boss, pool: h.pool });
  const live = await client.countByQueue({ queues: ['lq-a', 'lq-b'], live: true });
  expect(live).toEqual({ 'lq-a': 2, 'lq-b': 1 });
});

test('{ live: true } respects the states filter', async () => {
  const queue = 'count-live-states';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {}); // created
  await h.boss.send(queue, {}); // created
  await h.boss.fetch(queue);    // oldest -> active

  const client = bossier({ boss: h.boss, pool: h.pool });
  const live = await client.countByState({ queue, states: ['active'], live: true });
  expect(live.active).toBe(1);
  expect(live.created).toBe(0); // filtered out by the states clause
});

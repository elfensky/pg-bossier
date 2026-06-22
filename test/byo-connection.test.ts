import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';
import { pgBossDb } from '../src/db.js';

// WS-B: pg-bossier's reads/writes must run through pg-boss's own DB handle
// (boss.getDb()) so a consumer using an ORM adapter never has to hand it a
// separate pg.Pool. LISTEN/NOTIFY (subscribeEvents) is the documented exception
// — it needs a dedicated connection an ORM adapter can't expose.

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('reads and writes work with no pool — routed through boss.getDb()', async () => {
  const queue = 'byo-no-pool';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  // No `pool`: pg-bossier must query through pg-boss's own DB handle.
  const client = bossier({ boss: h.boss });

  const rec = await client.findById(jobId!);
  expect(rec?.jobId).toBe(jobId);
  expect(rec?.queue).toBe(queue);
  expect(rec?.data).toEqual({ in: 1 });

  await client.setProgress(jobId!, { pct: 42 });
  expect(await client.getProgress(jobId!)).toEqual({ progress: { pct: 42 }, attempt: 0 });

  const counts = await client.countByQueue({ queue });
  expect(counts[queue]).toBe(1);
});

test('explicit db: pgBossDb(boss) also routes reads through pg-boss', async () => {
  const queue = 'byo-explicit-db';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  const client = bossier({ boss: h.boss, db: pgBossDb(h.boss) });
  expect((await client.findById(jobId!))?.jobId).toBe(jobId);
});

test('subscribeEvents without a pool rejects with a clear error', async () => {
  const client = bossier({ boss: h.boss }); // no pool
  await expect(client.subscribeEvents()).rejects.toThrow(/requires a `pool`/);
});

test('with a pool, reads/writes and subscribeEvents both work (back-compat)', async () => {
  const queue = 'byo-with-pool';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  const client = bossier({ boss: h.boss, pool: h.pool });

  expect((await client.findById(jobId!))?.jobId).toBe(jobId);

  const events = await client.subscribeEvents();
  expect(typeof events.close).toBe('function');
  await events.close();
});

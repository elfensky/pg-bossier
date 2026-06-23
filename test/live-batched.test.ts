import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #34: getLiveHeartbeats reads many jobs' live heartbeats in one query, to avoid
// an N+1 loop of per-row getLiveHeartbeat on a dashboard.

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('getLiveHeartbeats returns a Map keyed by every requested id', async () => {
  const queue = 'hb-batch';
  await h.boss.createQueue(queue);
  const a = (await h.boss.send(queue, {}))!;
  const b = (await h.boss.send(queue, {}))!;
  await h.boss.fetch(queue); // make one active (a live row with a heartbeat slot)

  // Stamp a heartbeat directly. UPDATE of a non-state column does NOT fire the
  // capture trigger (AFTER UPDATE OF state), so this only touches the live row.
  await h.pool.query(`UPDATE pgboss.job SET heartbeat_on = now() WHERE id = $1`, [a]);

  const unknown = randomUUID();
  const client = bossier({ boss: h.boss, pool: h.pool });
  const map = await client.getLiveHeartbeats([a, b, unknown, 'not-a-uuid']);

  // Every requested id is a key.
  expect(new Set(map.keys())).toEqual(new Set([a, b, unknown, 'not-a-uuid']));
  expect(map.get(a)).toBeInstanceOf(Date);     // live + heartbeat
  expect(map.get(b)).toBeNull();               // live, no heartbeat stamped
  expect(map.get(unknown)).toBeNull();         // no live row
  expect(map.get('not-a-uuid')).toBeNull();    // malformed id
});

test('batched result matches per-row getLiveHeartbeat', async () => {
  const queue = 'hb-parity';
  await h.boss.createQueue(queue);
  const id = (await h.boss.send(queue, {}))!;
  await h.boss.fetch(queue);
  await h.pool.query(`UPDATE pgboss.job SET heartbeat_on = now() WHERE id = $1`, [id]);

  const client = bossier({ boss: h.boss, pool: h.pool });
  const single = await client.getLiveHeartbeat(id);
  const batched = (await client.getLiveHeartbeats([id])).get(id);
  expect(batched).toEqual(single);
});

test('empty input returns an empty Map (no query)', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect((await client.getLiveHeartbeats([])).size).toBe(0);
});

test('getLiveHeartbeats works with no pool (BYO connection)', async () => {
  const queue = 'hb-byo';
  await h.boss.createQueue(queue);
  const id = (await h.boss.send(queue, {}))!;
  const client = bossier({ boss: h.boss }); // no pool
  const map = await client.getLiveHeartbeats([id]);
  expect(map.has(id)).toBe(true);
});

import { test, expect, beforeEach, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #31: capture is fail-open and silent. captureHealth() gives an app-level
// signal — freshness (lastCapturedSeq/At) + a bounded coverage check (how many
// live pgboss.job rows have no chronicle record).

let h: Harness;
beforeEach(async () => { h = await startHarness(); await install(h.pool); });
afterEach(async () => { await h.teardown(); });

test('empty install: null freshness, nothing to check, nothing missing', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(await client.captureHealth()).toEqual({
    lastCapturedSeq: null, lastCapturedAt: null, checked: 0, missing: 0,
  });
});

test('after captures: freshness advances and coverage is complete', async () => {
  const queue = 'health-ok';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await h.boss.send(queue, {});

  const client = bossier({ boss: h.boss, pool: h.pool });
  const health = await client.captureHealth();
  expect(health.lastCapturedSeq).not.toBeNull();
  expect(health.lastCapturedSeq! > 0n).toBe(true);
  expect(health.lastCapturedAt).toBeInstanceOf(Date);
  expect(health.checked).toBe(2);
  expect(health.missing).toBe(0); // every live job has a record
});

test('a dropped record surfaces as missing coverage', async () => {
  const queue = 'health-gap';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;

  // Simulate a silent fail-open capture drop: the live job exists, its
  // chronicle row does not.
  await h.pool.query(`DELETE FROM pgbossier.record WHERE job_id = $1`, [jobId]);

  const client = bossier({ boss: h.boss, pool: h.pool });
  const health = await client.captureHealth();
  expect(health.checked).toBe(1);
  expect(health.missing).toBe(1); // the gap is now observable
});

test('sampleLimit bounds the coverage check', async () => {
  const queue = 'health-bound';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) await h.boss.send(queue, {});

  const client = bossier({ boss: h.boss, pool: h.pool });
  const health = await client.captureHealth({ sampleLimit: 2 });
  expect(health.checked).toBe(2); // sampled, not all 3
});

test('sampleLimit validation rejects bad input', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  await expect(client.captureHealth({ sampleLimit: 0 })).rejects.toThrow(/positive integer/);
  await expect(client.captureHealth({ sampleLimit: -1 })).rejects.toThrow(/positive integer/);
});

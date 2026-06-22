import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// WS-C: getLiveState reads pg-boss's CURRENT runtime state (non-forensic), with
// provenance (livePresent / liveReadAt / recordState) so a missing live row is
// never mistaken for "completed" — the retry DELETE+INSERT gap is the case.

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('getLiveState reflects a live job and carries provenance', async () => {
  const queue = 'live-active';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, { in: 1 }))!;
  const client = bossier({ boss: h.boss, pool: h.pool });

  // created: a live row exists
  let live = await client.getLiveState(jobId);
  expect(live).not.toBeNull();
  expect(live!.livePresent).toBe(true);
  expect(live!.recordState).toBe('created');
  expect(live!.job?.id).toBe(jobId);
  expect(live!.liveReadAt).toBeInstanceOf(Date);

  // fetch -> active
  await h.boss.fetch(queue);
  live = await client.getLiveState(jobId);
  expect(live!.livePresent).toBe(true);
  expect(live!.job?.state).toBe('active');
  expect(live!.recordState).toBe('active');
});

test('missing live row + active recordState => transitioning, not "done"', async () => {
  const queue = 'live-gap';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;
  await h.boss.fetch(queue); // active; record captured as 'active'
  // Simulate the retry DELETE+INSERT gap: the live row is momentarily gone.
  await h.pool.query(`DELETE FROM pgboss.job WHERE id = $1`, [jobId]);

  const client = bossier({ boss: h.boss, pool: h.pool });
  const live = await client.getLiveState(jobId);
  expect(live!.livePresent).toBe(false); // no live row...
  expect(live!.job).toBeNull();
  expect(live!.recordState).toBe('active'); // ...but recordState says NOT done
  expect(await client.getLiveHeartbeat(jobId)).toBeNull();
});

test('getLiveState returns null for a job pg-bossier never captured', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(await client.getLiveState(randomUUID())).toBeNull();
  expect(await client.getLiveHeartbeat(randomUUID())).toBeNull();
  expect(await client.getLiveState('not-a-uuid')).toBeNull(); // malformed short-circuits
});

test('getLiveState works with no pool (BYO connection, via boss.getDb())', async () => {
  const queue = 'live-byo';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;
  const client = bossier({ boss: h.boss }); // no pool
  const live = await client.getLiveState(jobId);
  expect(live!.livePresent).toBe(true);
  expect(live!.recordState).toBe('created');
});

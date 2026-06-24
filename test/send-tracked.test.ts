import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #29: sendTracked pins the job id AND stamps data._originalJobId in one call,
// so the dead-letter lineage contract can't half-drift (the silent failure mode
// of hand-threading { id } and data._originalJobId separately).

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('sendTracked pins the job id and stamps it into data._originalJobId', async () => {
  const queue = 'tracked';
  await h.boss.createQueue(queue);
  const client = bossier({ boss: h.boss, pool: h.pool });

  const id = await client.sendTracked(queue, { url: 'x' });
  expect(id).toBeTruthy();

  // The job's ACTUAL id equals the returned id (the half people forget),
  // and the breadcrumb in data carries the SAME id (can't disagree).
  const rows = await getRecords(h.pool, id!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.job_id).toBe(id);
  expect(rows[0]!.data).toEqual({ url: 'x', _originalJobId: id });
});

test('sendTracked owns data._originalJobId — overwrites a caller-supplied value', async () => {
  const queue = 'tracked-owns';
  await h.boss.createQueue(queue);
  const client = bossier({ boss: h.boss, pool: h.pool });

  // Caller passes their own _originalJobId; sendTracked must overwrite it with
  // the pinned id (the breadcrumb has to equal the job's real id).
  const id = await client.sendTracked(queue, { _originalJobId: 'stale-value', n: 1 });
  const rows = await getRecords(h.pool, id!);
  expect((rows[0]!.data as { _originalJobId: string })._originalJobId).toBe(id);
  expect((rows[0]!.data as { _originalJobId: string })._originalJobId).not.toBe('stale-value');
});

test('sendTracked honors an explicit { id }', async () => {
  const queue = 'tracked-explicit';
  await h.boss.createQueue(queue);
  const client = bossier({ boss: h.boss, pool: h.pool });

  const pinned = randomUUID();
  const id = await client.sendTracked(queue, { n: 1 }, { id: pinned });
  expect(id).toBe(pinned);
  const rows = await getRecords(h.pool, pinned);
  expect(rows[0]!.data).toEqual({ n: 1, _originalJobId: pinned });
});

test('sendTracked feeds the dead-letter round-trip end to end', async () => {
  const queue = 'tracked-dlq';
  await h.boss.createQueue(queue);
  const client = bossier({ boss: h.boss, pool: h.pool });

  // Producer side: one call. No separate { id } / _originalJobId to keep in sync.
  const sourceId = await client.sendTracked(queue, { task: 'process' }, { retryLimit: 0 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, sourceId!, { err: 'boom' }); // -> failed

  // DLQ handler reads the source id back from the breadcrumb and links it.
  const source = await client.findById(sourceId!);
  const breadcrumb = (source!.data as { _originalJobId: string })._originalJobId;
  expect(breadcrumb).toBe(sourceId);

  const dlqJobId = randomUUID();
  await client.recordDeadLetter({ sourceJobId: breadcrumb, dlqJobId });

  expect(await client.findDeadLetterSource(dlqJobId)).toEqual({
    jobId: sourceId, attempt: 0, queue,
  });
  expect(await client.findDeadLetterTarget(sourceId!)).toEqual({ dlqJobId, attempt: 0 });
});

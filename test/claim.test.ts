import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { setClaim, getClaim } from '../src/claim.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('setClaim writes claimed_by to the current attempt row', async () => {
  const queue = 'claim-set';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setClaim(h.pool, SCHEMAS, jobId!, 'worker-42');
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.claimed_by).toBe('worker-42');
});

test('setClaim throws on a non-string or empty ownerId', async () => {
  const queue = 'claim-set-bad';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  // @ts-expect-error — intentionally wrong type
  await expect(setClaim(h.pool, SCHEMAS, jobId!, null)).rejects.toThrow();
  await expect(setClaim(h.pool, SCHEMAS, jobId!, '')).rejects.toThrow();
});

test('setClaim is a no-op (no throw) for an unknown or malformed job id', async () => {
  await expect(
    setClaim(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000', 'w1'),
  ).resolves.toBeUndefined();
  await expect(
    setClaim(h.pool, SCHEMAS, 'not-a-uuid', 'w1'),
  ).resolves.toBeUndefined();
});

test('getClaim returns the most-recent owner', async () => {
  const queue = 'claim-get';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setClaim(h.pool, SCHEMAS, jobId!, 'worker-7');
  expect(await getClaim(h.pool, SCHEMAS, jobId!)).toBe('worker-7');
});

test('getClaim returns null for a job that was never claimed', async () => {
  const queue = 'claim-get-empty';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  expect(await getClaim(h.pool, SCHEMAS, jobId!)).toBeNull();
});

test('getClaim returns null for an unknown or malformed job id', async () => {
  expect(
    await getClaim(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000'),
  ).toBeNull();
  expect(await getClaim(h.pool, SCHEMAS, 'not-a-uuid')).toBeNull();
});

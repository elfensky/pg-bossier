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

test('setClaim returns false (no throw) for an unknown or malformed job id', async () => {
  await expect(
    setClaim(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000', 'w1'),
  ).resolves.toBe(false);
  await expect(
    setClaim(h.pool, SCHEMAS, 'not-a-uuid', 'w1'),
  ).resolves.toBe(false);
});

// #41a: compare-and-set — claim only if unclaimed (or already yours), so two
// racing workers can't both believe they own the same attempt.
test('setClaim is compare-and-set: first claim wins, a different owner loses', async () => {
  const queue = 'claim-cas';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;
  expect(await setClaim(h.pool, SCHEMAS, jobId, 'worker-A')).toBe(true);  // won
  expect(await setClaim(h.pool, SCHEMAS, jobId, 'worker-B')).toBe(false); // lost
  expect(await getClaim(h.pool, SCHEMAS, jobId)).toBe('worker-A');        // A still owns it
});

test('setClaim is idempotent for the owner: re-claiming your own returns true', async () => {
  const queue = 'claim-cas-idem';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;
  expect(await setClaim(h.pool, SCHEMAS, jobId, 'worker-A')).toBe(true);
  expect(await setClaim(h.pool, SCHEMAS, jobId, 'worker-A')).toBe(true); // re-assert, still owns
  expect(await getClaim(h.pool, SCHEMAS, jobId)).toBe('worker-A');
});

test('setClaim under contention: exactly one of two distinct owners wins', async () => {
  const queue = 'claim-race';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, {}))!;
  // Two genuinely-concurrent claims (separate pool connections). The CAS
  // predicate `AND (claimed_by IS NULL OR claimed_by = $2)` is atomic per row,
  // so Postgres row-locking lets exactly one win.
  const [a, b] = await Promise.all([
    setClaim(h.pool, SCHEMAS, jobId, 'worker-A'),
    setClaim(h.pool, SCHEMAS, jobId, 'worker-B'),
  ]);
  expect([a, b].filter(Boolean).length).toBe(1); // exactly one true
  const owner = await getClaim(h.pool, SCHEMAS, jobId);
  expect(owner).toBe(a ? 'worker-A' : 'worker-B'); // winner matches the true result
});

test('getClaim returns the most-recent owner', async () => {
  const queue = 'claim-get';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await setClaim(h.pool, SCHEMAS, jobId!, 'worker-7');
  expect(await getClaim(h.pool, SCHEMAS, jobId!)).toBe('worker-7');
});

test('getClaim is scoped to the current attempt — a prior attempt owner does not leak', async () => {
  const queue = 'claim-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  // attempt 0 is claimed by worker-A
  await setClaim(h.pool, SCHEMAS, jobId!, 'worker-A');
  // simulate a pg-boss retry: the capture trigger inserts a fresh attempt-1 row
  // with claimed_by NULL (the trigger never writes claimed_by).
  await h.pool.query(
    `INSERT INTO pgbossier.record (job_id, queue, attempt, state)
     VALUES ($1, $2, 1, 'created')`,
    [jobId, queue],
  );
  // current (latest) attempt was never claimed → null, NOT the stale 'worker-A'
  expect(await getClaim(h.pool, SCHEMAS, jobId!)).toBeNull();
  // claiming the current attempt then reads back as its owner
  await setClaim(h.pool, SCHEMAS, jobId!, 'worker-B');
  expect(await getClaim(h.pool, SCHEMAS, jobId!)).toBe('worker-B');
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

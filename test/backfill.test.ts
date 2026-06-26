import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });
// #24 + #11: one shared container; reset to a clean NOT-installed slate so each
// test backfills from a known pgboss.job state.
beforeEach(async () => {
  await h.pool.query('DROP SCHEMA IF EXISTS pgbossier CASCADE; DELETE FROM pgboss.job;');
});

test('install backfills a job that already existed in pgboss.job, and reports the count', async () => {
  const queue = 'backfill-q';
  await h.boss.createQueue(queue);
  // job created BEFORE pg-bossier is installed → no trigger captured it
  const jobId = await h.boss.send(queue, { pre: 'install' });

  const { backfilled } = await install(h.pool);
  expect(backfilled).toBe(1);

  const rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ pre: 'install' });
});

test('re-running install is idempotent: no duplicate rows, backfilled count 0', async () => {
  const queue = 'backfill-idem';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await h.boss.send(queue, {});

  const first = await install(h.pool);
  expect(first.backfilled).toBe(2);
  const { rows: c1 } = await h.pool.query<{ n: string }>(`SELECT count(*) AS n FROM pgbossier.record`);

  const second = await install(h.pool);
  expect(second.backfilled).toBe(0); // every row already exists (ON CONFLICT DO NOTHING)
  const { rows: c2 } = await h.pool.query<{ n: string }>(`SELECT count(*) AS n FROM pgbossier.record`);
  expect(Number(c2[0]!.n)).toBe(Number(c1[0]!.n)); // unchanged
});

test('backfill is batched: copies a multi-chunk pgboss.job correctly (#11)', async () => {
  const queue = 'backfill-scale';
  await h.boss.createQueue(queue);
  // Seed N pre-install jobs in one bulk insert. `name` is the only column
  // without a default (it's the partition key); id/state/etc. all default.
  const N = 2500;
  await h.pool.query(
    `INSERT INTO pgboss.job (name) SELECT $1 FROM generate_series(1, $2)`,
    [queue, N],
  );

  // chunkSize 1000 forces 3 batches (1000, 1000, 500) — exercises the keyset
  // cursor advance and the last-partial-batch termination.
  const { backfilled } = await install(h.pool, { backfillChunkSize: 1000 });
  expect(backfilled).toBe(N);

  const { rows } = await h.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pgbossier.record WHERE queue = $1`, [queue],
  );
  expect(Number(rows[0]!.n)).toBe(N);

  // Idempotent across the batched path too — a re-run inserts nothing.
  const again = await install(h.pool, { backfillChunkSize: 1000 });
  expect(again.backfilled).toBe(0);
});

test('backfillChunkSize validation rejects a non-positive value', async () => {
  await expect(install(h.pool, { backfillChunkSize: 0 })).rejects.toThrow(/positive integer/);
  await expect(install(h.pool, { backfillChunkSize: -5 })).rejects.toThrow(/positive integer/);
});

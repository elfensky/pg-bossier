import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('install backfills jobs that already existed in pgboss.job', async () => {
  const queue = 'backfill-q';
  await h.boss.createQueue(queue);
  // job created BEFORE pg-bossier is installed -> no trigger captured it
  const jobId = await h.boss.send(queue, { pre: 'install' });

  // pg-bossier is not installed yet — the record table does not exist
  const pre = await h.pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  expect(pre.rows).toHaveLength(0);

  await install(h.pool);

  const rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ pre: 'install' });
});

test('re-running install is idempotent and does not duplicate rows', async () => {
  await install(h.pool);
  await install(h.pool);
  const { rows } = await h.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pgbossier.record`,
  );
  // exact count is data-dependent; assert a stable count across re-runs
  const first = Number(rows[0]!.n);
  await install(h.pool);
  const { rows: again } = await h.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM pgbossier.record`,
  );
  expect(Number(again[0]!.n)).toBe(first);
});

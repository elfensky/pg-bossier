import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { exportRecords, importRecords } from '../src/archive.js';
import { getRetryHistory, type JobRecord } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

// #46: export → prune → import tiered retention. Direct record inserts give us
// controlled shapes; one shared container with a TRUNCATE between tests (#24).
const S = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });
beforeEach(async () => { await h.pool.query('TRUNCATE pgbossier.record'); });

async function rec(
  jobId: string, queue: string, attempt: number, state: string,
  o: { data?: unknown; output?: unknown; claimedBy?: string; completedOn?: Date } = {},
): Promise<void> {
  await h.pool.query(
    `INSERT INTO pgbossier.record (job_id, queue, attempt, state, data, output, claimed_by, completed_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [jobId, queue, attempt, state,
     o.data === undefined ? null : JSON.stringify(o.data),
     o.output === undefined ? null : JSON.stringify(o.output),
     o.claimedBy ?? null, o.completedOn ?? null],
  );
}

async function collect<T>(gen: AsyncGenerator<T[]>): Promise<T[]> {
  const all: T[] = [];
  for await (const batch of gen) all.push(...batch);
  return all;
}

test('export → (delete) → import round-trips losslessly, including claimed_by + seq', async () => {
  const jobId = randomUUID();
  // a retried job: attempt 0 frozen at retry, attempt 1 completed; with claim owners.
  await rec(jobId, 'arch-q', 0, 'retry', { data: { in: 1 }, output: { err: 'x' }, claimedBy: 'w-A' });
  await rec(jobId, 'arch-q', 1, 'completed', {
    data: { in: 1 }, output: { ok: true }, claimedBy: 'w-B', completedOn: new Date('2020-01-01T00:00:00Z'),
  });

  const exported: JobRecord[] = await collect(exportRecords(h.pool, S, {}));
  expect(exported.length).toBe(2);
  const exportedSeqs = exported.map((r) => r.seq).sort();

  // simulate archive-then-prune: rows leave the table
  await h.pool.query('TRUNCATE pgbossier.record');
  expect(await getRecords(h.pool, jobId)).toHaveLength(0);

  // restore from the archive
  const { imported } = await importRecords(h.pool, S, exported);
  expect(imported).toBe(2);

  const history = await getRetryHistory(h.pool, S, jobId);
  expect(history.length).toBe(2);
  expect(history[0]!.state).toBe('retry');
  expect(history[0]!.claimedBy).toBe('w-A');     // claim owner preserved
  expect(history[0]!.output).toEqual({ err: 'x' });
  expect(history[1]!.state).toBe('completed');
  expect(history[1]!.claimedBy).toBe('w-B');
  expect(history[1]!.data).toEqual({ in: 1 });
  expect(history[1]!.output).toEqual({ ok: true });
  // original seq preserved through the bigint → string → bigint round-trip
  expect(history.map((r) => r.seq).sort()).toEqual(exportedSeqs);
});

test('exportRecords filters by completedBefore', async () => {
  await rec(randomUUID(), 'q', 0, 'completed', { completedOn: new Date('2020-01-01T00:00:00Z') });
  await rec(randomUUID(), 'q', 0, 'completed', { completedOn: new Date() });
  const old = await collect(exportRecords(h.pool, S, { completedBefore: new Date('2021-01-01T00:00:00Z') }));
  expect(old.length).toBe(1);
});

test('importRecords is idempotent and never clobbers (ON CONFLICT DO NOTHING)', async () => {
  const jobId = randomUUID();
  await rec(jobId, 'q', 0, 'completed', { output: { v: 1 } });
  const exported = await collect(exportRecords(h.pool, S, {}));

  await h.pool.query('TRUNCATE pgbossier.record');
  expect((await importRecords(h.pool, S, exported)).imported).toBe(1);
  expect((await importRecords(h.pool, S, exported)).imported).toBe(0); // re-import: all conflict
  expect(await getRecords(h.pool, jobId)).toHaveLength(1);             // no duplicate
});

test('exportRecords yields keyset-paginated batches', async () => {
  for (let i = 0; i < 5; i++) await rec(randomUUID(), 'q', 0, 'completed');
  const sizes: number[] = [];
  for await (const batch of exportRecords(h.pool, S, {}, { batchSize: 2 })) sizes.push(batch.length);
  expect(sizes).toEqual([2, 2, 1]); // 3 batches across the seq cursor
});

test('importRecords([]) is a no-op', async () => {
  expect(await importRecords(h.pool, S, [])).toEqual({ imported: 0 });
});

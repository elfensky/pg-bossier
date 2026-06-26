import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { prune } from '../src/prune.js';
import { resolveSchemas } from '../src/sql.js';

// #42: prune is a guarded retention primitive. We insert chronicle rows directly
// to control state / attempt / timestamps deterministically.
// #24: one shared container; prune operates on the whole table, so each test
// starts from a truncated chronicle (the direct inserts use random job ids).

const S = resolveSchemas();
const OLD = new Date('2020-01-01T00:00:00Z');
const CUTOFF = new Date('2021-01-01T00:00:00Z');

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });
beforeEach(async () => { await h.pool.query('TRUNCATE pgbossier.record'); });

async function rec(
  jobId: string, queue: string, attempt: number, state: string,
  o: { completedOn?: Date; capturedAt?: Date } = {},
): Promise<void> {
  await h.pool.query(
    `INSERT INTO pgbossier.record (job_id, queue, attempt, state, completed_on, captured_at)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, now()))`,
    [jobId, queue, attempt, state, o.completedOn ?? null, o.capturedAt ?? null],
  );
}
async function count(jobId: string): Promise<number> {
  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM pgbossier.record WHERE job_id = $1`, [jobId],
  );
  return (rows[0] as { n: number }).n;
}

test('prune requires at least one bound (refuses to wipe everything)', async () => {
  await expect(prune(h.pool, S, {})).rejects.toThrow(/at least one bound/);
  await expect(prune(h.pool, S)).rejects.toThrow(/at least one bound/);
});

test('prune rejects a bad keepLastPerQueue', async () => {
  await expect(prune(h.pool, S, { keepLastPerQueue: -1 })).rejects.toThrow(/non-negative integer/);
  await expect(prune(h.pool, S, { keepLastPerQueue: 1.5 })).rejects.toThrow(/non-negative integer/);
});

test('olderThan deletes old done jobs, keeps recent ones', async () => {
  const oldDone = randomUUID();
  const recentDone = randomUUID();
  await rec(oldDone, 'q', 0, 'completed', { completedOn: OLD });
  await rec(recentDone, 'q', 0, 'completed', { completedOn: new Date() });

  const { deleted } = await prune(h.pool, S, { olderThan: CUTOFF });
  expect(deleted).toBe(1);
  expect(await count(oldDone)).toBe(0);
  expect(await count(recentDone)).toBe(1);
});

test('an in-flight job is NEVER touched, even when old (the key safety invariant)', async () => {
  const jobId = randomUUID();
  // attempt 0 failed long ago, attempt 1 (current) is active → job is in-flight.
  await rec(jobId, 'q', 0, 'failed', { completedOn: OLD });
  await rec(jobId, 'q', 1, 'active', { capturedAt: OLD });

  const { deleted } = await prune(h.pool, S, { olderThan: CUTOFF });
  expect(deleted).toBe(0);          // current attempt non-terminal → protected whole
  expect(await count(jobId)).toBe(2); // including the old failed attempt-0 row
});

test('an eligible done job is deleted whole — all attempts, incl. non-terminal retry rows', async () => {
  const jobId = randomUUID();
  await rec(jobId, 'q', 0, 'retry', { capturedAt: OLD });
  await rec(jobId, 'q', 1, 'retry', { capturedAt: OLD });
  await rec(jobId, 'q', 2, 'failed', { completedOn: OLD }); // current attempt terminal

  const { deleted } = await prune(h.pool, S, { olderThan: CUTOFF });
  expect(deleted).toBe(3);
  expect(await count(jobId)).toBe(0);
});

test('keepLastPerQueue keeps the N most-recently-completed done jobs per queue', async () => {
  const a1 = randomUUID(), a2 = randomUUID(), a3 = randomUUID(), b1 = randomUUID();
  await rec(a1, 'qA', 0, 'completed', { completedOn: new Date('2020-01-01T00:00:00Z') });
  await rec(a2, 'qA', 0, 'completed', { completedOn: new Date('2020-02-01T00:00:00Z') });
  await rec(a3, 'qA', 0, 'completed', { completedOn: new Date('2020-03-01T00:00:00Z') });
  await rec(b1, 'qB', 0, 'completed', { completedOn: new Date('2020-01-01T00:00:00Z') });

  const { deleted } = await prune(h.pool, S, { keepLastPerQueue: 2 });
  expect(deleted).toBe(1);          // qA: drop the oldest (a1); qB: only 1, kept
  expect(await count(a1)).toBe(0);
  expect(await count(a2)).toBe(1);
  expect(await count(a3)).toBe(1);
  expect(await count(b1)).toBe(1);
});

test('with both bounds, a job must violate BOTH to be deleted (intersection)', async () => {
  const oldKept = randomUUID();   // old, but the most-recent in its queue → kept by keepLast:1
  const oldBeyond = randomUUID(); // old AND beyond keep:1 → violates both → deleted
  await rec(oldBeyond, 'q', 0, 'completed', { completedOn: new Date('2020-01-01T00:00:00Z') });
  await rec(oldKept, 'q', 0, 'completed', { completedOn: new Date('2020-02-01T00:00:00Z') });

  const { deleted } = await prune(h.pool, S, { olderThan: CUTOFF, keepLastPerQueue: 1 });
  expect(deleted).toBe(1);
  expect(await count(oldBeyond)).toBe(0);
  expect(await count(oldKept)).toBe(1);
});

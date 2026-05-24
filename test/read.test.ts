import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { findById, getRetryHistory, listJobs, latestPerQueue, countByState, countByQueue, listLongRunning, getEventsSince, type JobRecord } from '../src/read.js';
import { recordTerminalDetail } from '../src/terminal-detail.js';
import { resolveSchemas } from '../src/sql.js';

const SCHEMAS = resolveSchemas();

// Compile-time fixture: JobRecord.terminalDetail narrows by state. The function
// is never called — it exists so `tsc` checks that the discriminated-union
// narrowing still holds. A break here fails the build, not a test run.
function _narrowingFixture(job: JobRecord): void {
  if (job.state === 'failed' || job.state === 'retry') {
    if (job.terminalDetail) {
      const _cls: 'transient' | 'non_retryable' = job.terminalDetail.class;
      const _dla: string | undefined = job.terminalDetail.deadLetteredAs;
      void _cls;
      void _dla;
    }
  }
  if (job.state === 'completed' && job.terminalDetail) {
    const _anyField: unknown = job.terminalDetail['anyField'];
    void _anyField;
  }
  if (job.state === 'cancelled' && job.terminalDetail) {
    const _by: string | undefined = job.terminalDetail.cancelledBy;
    void _by;
  }
}
void _narrowingFixture;

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('findById returns the latest attempt of a job', async () => {
  const queue = 'read-findbyid';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { n: 1 });

  const job = await findById(h.pool, SCHEMAS, jobId!);
  expect(job).not.toBeNull();
  expect(job!.jobId).toBe(jobId);
  expect(job!.queue).toBe(queue);
  expect(job!.state).toBe('created');
  expect(job!.attempt).toBe(0);
  expect(job!.data).toEqual({ n: 1 });
});

test('findById returns null for an unknown job id', async () => {
  const job = await findById(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000');
  expect(job).toBeNull();
});

test('findById returns null for a malformed job id (no Postgres error)', async () => {
  const job = await findById(h.pool, SCHEMAS, 'not-a-uuid');
  expect(job).toBeNull();
});

test('findById returns the current attempt of a retried job, not attempt 0', async () => {
  const queue = 'read-findbyid-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'first' });   // attempt 0 -> retry
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });    // attempt 1 -> completed

  const job = await findById(h.pool, SCHEMAS, jobId!);
  expect(job!.attempt).toBe(1);
  expect(job!.state).toBe('completed');
});

test('getRetryHistory returns every attempt of a job, oldest first', async () => {
  const queue = 'read-history';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 2 });

  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-0' });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-1' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const history = await getRetryHistory(h.pool, SCHEMAS, jobId!);
  expect(history.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(history[2]!.state).toBe('completed');
});

test('getRetryHistory returns an empty array for an unknown job id', async () => {
  const history = await getRetryHistory(h.pool, SCHEMAS, '00000000-0000-0000-0000-000000000000');
  expect(history).toEqual([]);
});

test('listJobs filters by queue and reports an accurate total', async () => {
  const queue = 'read-list';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 5; i++) await h.boss.send(queue, { i });

  const result = await listJobs(h.pool, SCHEMAS, { queue });
  expect(result.total).toBe(5);
  expect(result.rows).toHaveLength(5);
  expect(result.rows.every((r) => r.queue === queue)).toBe(true);
});

test('listJobs paginates without overlap and total is independent of limit', async () => {
  const queue = 'read-list-page';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 6; i++) await h.boss.send(queue, { i });

  const page1 = await listJobs(h.pool, SCHEMAS, { queue, limit: 2, offset: 0 });
  const page2 = await listJobs(h.pool, SCHEMAS, { queue, limit: 2, offset: 2 });
  expect(page1.total).toBe(6);
  expect(page2.total).toBe(6);
  const ids1 = page1.rows.map((r) => r.jobId);
  const ids2 = page2.rows.map((r) => r.jobId);
  expect(ids1).toHaveLength(2);
  expect(ids2).toHaveLength(2);
  expect(ids1.some((id) => ids2.includes(id))).toBe(false);
});

test('listJobs filters by state and counts a retried job once', async () => {
  const queue = 'read-list-state';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const result = await listJobs(h.pool, SCHEMAS, { queue, states: ['completed'] });
  expect(result.total).toBe(1);
  expect(result.rows[0]!.jobId).toBe(jobId);
});

test('listJobs returns an empty result for a queue with no jobs', async () => {
  const result = await listJobs(h.pool, SCHEMAS, { queue: 'read-list-empty' });
  expect(result).toEqual({ rows: [], total: 0 });
});

test('listJobs filters by a creation-time window', async () => {
  const queue = 'read-list-window';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) await h.boss.send(queue, { i });

  const hourAgo = new Date(Date.now() - 3_600_000);
  const hourAhead = new Date(Date.now() + 3_600_000);
  const recent = await listJobs(h.pool, SCHEMAS, { queue, createdAfter: hourAgo });
  expect(recent.total).toBe(3);
  const future = await listJobs(h.pool, SCHEMAS, { queue, createdAfter: hourAhead });
  expect(future.total).toBe(0);
});

test('listJobs rejects a non-positive limit', async () => {
  await expect(listJobs(h.pool, SCHEMAS, { limit: 0 })).rejects.toThrow();
});

test('latestPerQueue returns the most recent job per queue', async () => {
  const qa = 'read-lpq-a';
  const qb = 'read-lpq-b';
  await h.boss.createQueue(qa);
  await h.boss.createQueue(qb);
  await h.boss.send(qa, { first: true });
  const lastA = await h.boss.send(qa, { last: true });
  const lastB = await h.boss.send(qb, { only: true });

  const rows = await latestPerQueue(h.pool, SCHEMAS, [qa, qb]);
  const byQueue = new Map(rows.map((r) => [r.queue, r]));
  expect(byQueue.get(qa)!.jobId).toBe(lastA);
  expect(byQueue.get(qb)!.jobId).toBe(lastB);
});

test('latestPerQueue returns an empty array for an empty queue list', async () => {
  const rows = await latestPerQueue(h.pool, SCHEMAS, []);
  expect(rows).toEqual([]);
});

test('countByState counts each job once by its current state, all six keys present', async () => {
  const queue = 'read-cbs';
  await h.boss.createQueue(queue);

  // 2 completed (send+fetch+complete each, no other jobs in queue yet)
  for (let i = 0; i < 2; i++) {
    const id = await h.boss.send(queue, {});
    await h.boss.fetch(queue);
    await h.boss.complete(queue, id!, {});
  }
  // 1 retried-then-completed -> current state is 'completed', not 'retry'
  const retried = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);
  await h.boss.fail(queue, retried!, { err: 'x' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, retried!, {});
  // 1 created (sent last so fetch+complete above can't race with it)
  await h.boss.send(queue, {});

  const counts = await countByState(h.pool, SCHEMAS, { queue });
  expect(counts).toEqual({
    created: 1, active: 0, retry: 0, completed: 3, cancelled: 0, failed: 0,
  });
});

test('countByQueue counts jobs per queue, with a state filter', async () => {
  const qa = 'read-cbq-a';
  const qb = 'read-cbq-b';
  await h.boss.createQueue(qa);
  await h.boss.createQueue(qb);
  // qa: 2 failed, 1 created
  for (let i = 0; i < 2; i++) {
    const id = await h.boss.send(qa, {}, { retryLimit: 0 });
    await h.boss.fetch(qa);
    await h.boss.fail(qa, id!, { err: 'x' });
  }
  await h.boss.send(qa, {});
  // qb: 1 failed
  const id = await h.boss.send(qb, {}, { retryLimit: 0 });
  await h.boss.fetch(qb);
  await h.boss.fail(qb, id!, { err: 'x' });

  const counts = await countByQueue(h.pool, SCHEMAS, {
    queues: [qa, qb],
    states: ['failed'],
  });
  expect(counts).toEqual({ [qa]: 2, [qb]: 1 });
});

test('listLongRunning returns active jobs older than the threshold', async () => {
  const queue = 'read-llr';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active

  const running = await listLongRunning(h.pool, SCHEMAS, { queue, longerThanSeconds: 0 });
  expect(running.map((r) => r.jobId)).toContain(jobId);
  expect(running.every((r) => r.state === 'active')).toBe(true);
});

test('listLongRunning excludes a freshly-started job under a large threshold', async () => {
  const queue = 'read-llr-fresh';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active, started just now

  const running = await listLongRunning(h.pool, SCHEMAS, { queue, longerThanSeconds: 3600 });
  expect(running).toHaveLength(0);
});

test('listJobs reports the real total even when the page is past the end', async () => {
  const queue = 'read-list-pastend';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 3; i++) await h.boss.send(queue, { i });

  // a page whose offset skips every match: rows are empty, but the total
  // must still be the true count — not 0.
  const past = await listJobs(h.pool, SCHEMAS, { queue, limit: 10, offset: 100 });
  expect(past.rows).toHaveLength(0);
  expect(past.total).toBe(3);
});

test('listJobs throws when both queue and queues are supplied', async () => {
  await expect(
    listJobs(h.pool, SCHEMAS, { queue: 'read-list-both', queues: ['read-list-both'] }),
  ).rejects.toThrow(/queue/);
});

test('listJobs falls back to a safe ordering for an unknown orderBy value', async () => {
  const queue = 'read-list-badorder';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});

  // a JS caller bypassing the orderBy type must not yield `ORDER BY undefined`.
  const result = await listJobs(h.pool, SCHEMAS, { queue, orderBy: 'bogus' as never });
  expect(result.total).toBe(1);
});

test('latestPerQueue ignores a null created_on when picking the most recent job', async () => {
  const queue = 'read-lpq-null';
  // two captured rows for one queue: one with a real timestamp, one with a
  // NULL created_on (the column is nullable). The real timestamp must win.
  await h.pool.query(
    `INSERT INTO pgbossier.record
       (job_id, queue, attempt, state, created_on, captured_at)
     VALUES
       ($1, $3, 0, 'created', now(), now()),
       ($2, $3, 0, 'created', NULL,  now())`,
    [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
      queue,
    ],
  );

  const rows = await latestPerQueue(h.pool, SCHEMAS, [queue]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.jobId).toBe('11111111-1111-1111-1111-111111111111');
});

test('listLongRunning returns only the current attempt of a retried job, no phantom', async () => {
  // F3 verification: listLongRunning queries pgbossier.record directly (not the
  // RECORD_CURRENT view). That is correct only if a superseded attempt is never
  // frozen at state='active'. pg-boss moves a failed-with-retries job to 'retry'
  // before the next attempt, so the old attempt's capture is 'retry', not
  // 'active' — this test pins that invariant.
  const queue = 'read-llr-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });
  await h.boss.fetch(queue);                       // attempt 0 -> active
  await h.boss.fail(queue, jobId!, { err: 'x' });  // attempt 0 -> retry
  await h.boss.fetch(queue);                       // attempt 1 -> active

  const running = await listLongRunning(h.pool, SCHEMAS, { queue, longerThanSeconds: 0 });
  const forJob = running.filter((r) => r.jobId === jobId);
  expect(forJob).toHaveLength(1);
  expect(forJob[0]!.attempt).toBe(1);
  expect(forJob[0]!.state).toBe('active');
});

test('listLongRunning query is served by record_active_idx, not a seq scan', async () => {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON)
       SELECT * FROM pgbossier.record
       WHERE state = 'active' AND queue = $1
         AND started_on < now() - make_interval(secs => $2)
       ORDER BY started_on ASC, job_id
       LIMIT 100`,
      ['read-llr', 0],
    );
    const plan = JSON.stringify(rows[0]!['QUERY PLAN']);
    expect(plan).toContain('record_active_idx');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
});

test('getEventsSince returns rows with seq strictly greater than cursor', async () => {
  const queue = 'cursor-basic';
  await h.boss.createQueue(queue);

  const id1 = await h.boss.send(queue, { n: 1 });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, id1!, { ok: 1 });

  const rows0 = await getRecords(h.pool, id1!);
  const cursor = BigInt(rows0[0]!.seq);

  const id2 = await h.boss.send(queue, { n: 2 });
  await h.boss.fetch(queue);

  const events = await getEventsSince(h.pool, SCHEMAS, cursor);
  const ids = events.map((e) => e.jobId);
  expect(ids).toContain(id2!);
  expect(ids).not.toContain(id1!);

  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq > events[i - 1]!.seq).toBe(true);
  }
});

test('getEventsSince(0n) returns every row', async () => {
  const queue = 'cursor-all';
  await h.boss.createQueue(queue);
  await h.boss.send(queue, {});
  const all = await getEventsSince(h.pool, SCHEMAS, 0n);
  expect(all.length).toBeGreaterThan(0);
});

test('getEventsSince respects the limit option', async () => {
  const queue = 'cursor-limit';
  await h.boss.createQueue(queue);
  for (let i = 0; i < 5; i++) await h.boss.send(queue, { i });
  const events = await getEventsSince(h.pool, SCHEMAS, 0n, { limit: 3 });
  expect(events.length).toBe(3);
});

test('getEventsSince returns final-state-per-attempt only', async () => {
  const queue = 'cursor-final-state';
  await h.boss.createQueue(queue);
  const { rows } = await h.pool.query<{ s: string }>(
    `SELECT COALESCE(max(seq), 0)::text AS s FROM pgbossier.record`,
  );
  const cursor = BigInt(rows[0]!.s);

  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const events = await getEventsSince(h.pool, SCHEMAS, cursor);
  const forJob = events.filter((e) => e.jobId === jobId);
  // One row per (job_id, attempt) — final state only.
  expect(forJob.length).toBe(1);
  expect(forJob[0]!.state).toBe('completed');
});

test('getRetryHistory returns terminalDetail typed for a retry-state row', async () => {
  // The reader's discriminated-union narrowing claims a `retry`-state row can
  // carry TerminalDetailFailed | null. This test exercises the runtime side of
  // that claim: write detail against an attempt that pg-boss subsequently
  // DELETE+INSERTs as the next attempt, leaving the prior row at state='retry'
  // with the detail attached.
  const queue = 'read-retry-detail';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 1 });

  await h.boss.fetch(queue);                            // attempt 0 → active
  await h.boss.fail(queue, jobId!, { err: 'boom-0' });  // attempt 0 → retry
  await h.boss.fetch(queue);                            // attempt 1 row created (active)

  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'boom-0' },
  });

  const history = await getRetryHistory(h.pool, SCHEMAS, jobId!);
  const attemptZero = history.find((r) => r.attempt === 0);
  expect(attemptZero).toBeDefined();
  // Attempt 0's chronicle row is at state='retry' (preserved row-version), not
  // state='failed' — that's the case the union widening was added for.
  expect(attemptZero!.state).toBe('retry');
  // Compile-time narrowing: under `state === 'retry'`, terminalDetail's union
  // includes TerminalDetailFailed, so .class is statically known.
  if (attemptZero!.state === 'retry' && attemptZero!.terminalDetail) {
    expect(attemptZero!.terminalDetail.class).toBe('transient');
    expect(attemptZero!.terminalDetail.message).toBe('boom-0');
  } else {
    throw new Error('expected attempt 0 in retry state with terminalDetail set');
  }

  // Clean up — finish attempt 1 so pg-boss doesn't keep the queue active.
  await h.boss.complete(queue, jobId!, { ok: true });
});

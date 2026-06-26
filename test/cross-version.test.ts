import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { getRetryHistory } from '../src/read.js';
import { resolveSchemas } from '../src/sql.js';

// #19: cross-version correctness assertions — the canonical drift detectors.
//
// CI-against-one-version does not catch a class of pg-boss-vs-pg-bossier drift:
//   - a pgboss.job column kept as an alias on rename (trigger reads the old
//     name → chronicle silently records wrong/empty data);
//   - a type/nullability shift on a column the trigger reads (row semantically
//     wrong);
//   - pg-boss adding/reordering its own AFTER triggers on pgboss.job (changes
//     which transitions our capture trigger sees);
//   - upgrade-path bugs that only manifest moving across minors.
//
// These tests assert that EVERY pgboss.job column the capture trigger reads
// lands correctly in pgbossier.record for a known success + retry lifecycle, so
// any of the above surfaces as a failing assertion rather than silently-wrong
// history. `.github/workflows/compat-matrix.yml` runs this file against the
// peer-dep floor AND the latest pg-boss 12.x.

const S = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });
beforeEach(async () => {
  await h.pool.query('DELETE FROM pgboss.job; TRUNCATE pgbossier.record;');
});

test('success lifecycle: every captured column matches the known job', async () => {
  const queue = 'xv-success';
  await h.boss.createQueue(queue);
  const data = { space: 'track', n: 42 };
  const jobId = (await h.boss.send(queue, data, {
    priority: 7, retryLimit: 3, singletonKey: 'xv-sk',
  }))!;

  // created — every column the trigger reads from the INSERTed pgboss.job row.
  let rows = await getRecords(h.pool, jobId);
  expect(rows).toHaveLength(1);
  const created = rows[0]!;
  expect(created.queue).toBe(queue);             // NEW.name        -> queue
  expect(created.attempt).toBe(0);               // NEW.retry_count -> attempt
  expect(created.state).toBe('created');         // NEW.state
  expect(created.data).toEqual(data);            // NEW.data
  expect(created.priority).toBe(7);              // NEW.priority
  expect(created.retry_limit).toBe(3);           // NEW.retry_limit
  expect(created.singleton_key).toBe('xv-sk');   // NEW.singleton_key
  expect(created.created_on).not.toBeNull();     // NEW.created_on
  expect(created.captured_at).not.toBeNull();
  expect(BigInt(created.seq) > 0n).toBe(true);

  // active — UPDATE OF state transition is captured, started_on lands.
  await h.boss.fetch(queue);
  rows = await getRecords(h.pool, jobId);
  expect(rows[0]!.state).toBe('active');
  expect(rows[0]!.started_on).not.toBeNull();    // NEW.started_on

  // completed — output + completed_on land; config columns stay stable.
  await h.boss.complete(queue, jobId, { ok: true, result: [1, 2, 3] });
  rows = await getRecords(h.pool, jobId);
  const done = rows[0]!;
  expect(done.state).toBe('completed');
  expect(done.output).toEqual({ ok: true, result: [1, 2, 3] }); // NEW.output
  expect(done.completed_on).not.toBeNull();      // NEW.completed_on
  expect(done.priority).toBe(7);
  expect(done.retry_limit).toBe(3);
  expect(done.singleton_key).toBe('xv-sk');
});

test('retry lifecycle: failure + retry captured as ordered attempt rows', async () => {
  const queue = 'xv-retry';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, { input: 'x' }, { retryLimit: 2 }))!;

  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId, { err: 'boom-0' }); // attempt 0 -> retry
  await h.boss.fetch(queue);                           // attempt 1 -> active
  await h.boss.complete(queue, jobId, { ok: true });   // attempt 1 -> completed

  // The stable id keeps both attempts as distinct, ordered chronicle rows —
  // pg-boss's retry DELETE+INSERT must not collapse them.
  const history = await getRetryHistory(h.pool, S, jobId);
  expect(history.length).toBe(2);
  expect(history[0]!.attempt).toBe(0);
  expect(history[0]!.state).toBe('retry');
  expect(history[0]!.output).toEqual({ err: 'boom-0' }); // failure payload captured
  expect(history[1]!.attempt).toBe(1);
  expect(history[1]!.state).toBe('completed');
  expect(history[1]!.output).toEqual({ ok: true });
});

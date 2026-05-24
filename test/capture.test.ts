import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { recordTerminalDetail } from '../src/terminal-detail.js';
import { recordInputSnapshot } from '../src/input-snapshot.js';
import { resolveSchemas } from '../src/sql.js';
import pg from 'pg';

const SCHEMAS = resolveSchemas();

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('send -> fetch -> complete is mirrored into pgbossier.record', async () => {
  const queue = 'cap-complete';
  await h.boss.createQueue(queue);

  const jobId = await h.boss.send(queue, { hello: 'world' });
  expect(jobId).toBeTruthy();
  let rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.attempt).toBe(0);
  expect(rows[0]!.data).toEqual({ hello: 'world' });

  await h.boss.fetch(queue);
  rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');

  await h.boss.complete(queue, jobId!, { ok: true });
  rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('completed');
  expect(rows[0]!.output).toEqual({ ok: true });
});

test('cancel is mirrored', async () => {
  const queue = 'cap-cancel';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.cancel(queue, jobId!);
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('cancelled');
});

test('a job that fails twice then completes yields three attempt rows', async () => {
  const queue = 'cap-retry';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 2 });

  // attempt 0
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-0' });
  // attempt 1
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'fail-1' });
  // attempt 2
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows.map((r) => r.attempt)).toEqual([0, 1, 2]);
  expect(rows[0]!.state).toBe('retry');
  expect(rows[0]!.output).toEqual({ err: 'fail-0' });
  expect(rows[1]!.state).toBe('retry');
  expect(rows[1]!.output).toEqual({ err: 'fail-1' });
  expect(rows[2]!.state).toBe('completed');
  expect(rows[2]!.output).toEqual({ ok: true });
});

test('touch() heartbeats do not add or change record rows', async () => {
  const queue = 'cap-touch';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});
  await h.boss.fetch(queue); // -> active
  const before = await getRecords(h.pool, jobId!);

  await h.boss.touch(queue, jobId!);
  await h.boss.touch(queue, jobId!);

  const after = await getRecords(h.pool, jobId!);
  expect(after).toHaveLength(before.length);
  expect(after[0]!.captured_at).toEqual(before[0]!.captured_at);
});

test('a job that exhausts its retries is captured as failed', async () => {
  const queue = 'cap-failed';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });

  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'terminal' });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.attempt).toBe(0);
  expect(rows[0]!.state).toBe('failed');
  expect(rows[0]!.output).toEqual({ err: 'terminal' });
});

test('record.seq advances on every transition (INSERT and UPDATE)', async () => {
  const queue = 'cap-seq';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {});

  let rows = await getRecords(h.pool, jobId!);
  const seqAfterCreated = BigInt((rows[0] as unknown as { seq: string }).seq);

  await h.boss.fetch(queue);
  rows = await getRecords(h.pool, jobId!);
  const seqAfterActive = BigInt((rows[0] as unknown as { seq: string }).seq);

  await h.boss.complete(queue, jobId!, { ok: true });
  rows = await getRecords(h.pool, jobId!);
  const seqAfterCompleted = BigInt((rows[0] as unknown as { seq: string }).seq);

  expect(seqAfterActive).toBeGreaterThan(seqAfterCreated);
  expect(seqAfterCompleted).toBeGreaterThan(seqAfterActive);
});

test('trigger publishes pg_notify on pgbossier_job with identity + seq', async () => {
  const queue = 'cap-notify';
  await h.boss.createQueue(queue);

  const listener = new pg.Client({
    connectionString: (h.pool as unknown as { options: { connectionString: string } }).options.connectionString,
  });
  await listener.connect();
  await listener.query('LISTEN pgbossier_job');
  const received: { channel: string; payload: string | undefined }[] = [];
  listener.on('notification', (msg) => {
    received.push({ channel: msg.channel, payload: msg.payload });
  });

  const jobId = await h.boss.send(queue, { hello: 'evt' });
  await h.boss.fetch(queue);
  await h.boss.complete(queue, jobId!, { ok: true });
  await new Promise((r) => setTimeout(r, 100));

  const forQueue = received
    .map((ev) => ({ ...ev, parsed: JSON.parse(ev.payload!) as Record<string, unknown> }))
    .filter((ev) => ev.parsed.queue === queue);
  expect(forQueue).toHaveLength(3);
  for (const ev of forQueue) {
    expect(ev.channel).toBe('pgbossier_job');
    expect(ev.parsed.job_id).toBe(jobId);
    expect(typeof ev.parsed.attempt).toBe('number');
    expect(typeof ev.parsed.state).toBe('string');
    expect(typeof ev.parsed.seq).toBe('number');
    expect(typeof ev.parsed.captured_at).toBe('string');
  }
  await listener.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal 2 regression — terminal_detail preservation across trigger fires.
//
// Section C of the Goal 2 spec depends on the capture trigger's
// `ON CONFLICT DO UPDATE SET` list NOT including `terminal_detail`. The reader
// "trusts the writer" (recordTerminalDetail is the sole writer). If a future
// trigger change adds terminal_detail to the SET list, a subsequent pg-boss
// state UPDATE would silently overwrite the worker's classification with NULL.
// These tests lock that structural guarantee in.
// ─────────────────────────────────────────────────────────────────────────────

test('capture trigger preserves terminal_detail across subsequent fires', async () => {
  const queue = 'cap-td-preserve';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });

  // Drive the row to a state recordTerminalDetail can write against.
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'boom' });
  let rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('failed');
  expect(rows[0]!.terminal_detail).toBeNull();

  // Worker writes the typed classification.
  await recordTerminalDetail(h.pool, SCHEMAS, jobId!, 0, {
    state: 'failed',
    detail: { class: 'transient', message: 'boom' },
  });

  rows = await getRecords(h.pool, jobId!);
  const before = rows[0]!.terminal_detail;
  expect(before).toEqual({ class: 'transient', message: 'boom' });

  // Induce another capture trigger fire on the same (job_id, attempt) row.
  // The trigger fires AFTER INSERT OR UPDATE OF state — a no-op UPDATE that
  // mentions the state column in its SET list still fires the trigger, and
  // exercises the ON CONFLICT DO UPDATE path inside the trigger function.
  // We touch pgboss.job directly so we are not coupled to any specific
  // pg-boss transition path.
  await h.pool.query(
    `UPDATE ${SCHEMAS.pgboss}.job SET state = state WHERE id = $1`,
    [jobId],
  );

  rows = await getRecords(h.pool, jobId!);
  const after = rows[0]!.terminal_detail;
  expect(after).toEqual(before);
});

test('capture trigger DO UPDATE SET clause does not list terminal_detail', async () => {
  // Static check on the trigger function definition. If the SET list ever
  // grows a terminal_detail line, this fails at install time, before any
  // row-level test would catch it.
  const { rows } = await h.pool.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = 'capture'`,
    [SCHEMAS.pgbossier],
  );
  expect(rows[0]).toBeDefined();
  const def = rows[0]!.def;

  // Isolate the DO UPDATE SET block — from `DO UPDATE SET` up to the
  // semicolon that ends the INSERT statement — and assert terminal_detail
  // is not in it.
  const setBlockMatch = /DO UPDATE SET[\s\S]*?;/i.exec(def);
  expect(setBlockMatch).not.toBeNull();
  expect(setBlockMatch![0]).not.toMatch(/terminal_detail/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// Goal 4 regression — input_snapshot preservation across trigger fires.
//
// Same reasoning as the Goal 2 block above: the capture trigger is pg-boss's
// row-mirror; `recordInputSnapshot` is the sole writer of the input_snapshot
// column. If a future trigger change adds input_snapshot to the ON CONFLICT
// DO UPDATE SET list, a subsequent pg-boss state UPDATE would silently
// overwrite the worker-supplied manifest with NULL. These tests lock the
// structural guarantee in.
// ─────────────────────────────────────────────────────────────────────────────

test('capture trigger preserves input_snapshot across subsequent fires', async () => {
  const queue = 'cap-is-preserve';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, {}, { retryLimit: 0 });

  // Drive the row to a state where recordInputSnapshot can write against it.
  await h.boss.fetch(queue);
  await h.boss.fail(queue, jobId!, { err: 'boom' });
  let rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('failed');
  expect(rows[0]!.input_snapshot).toBeNull();

  // Worker writes the snapshot.
  await recordInputSnapshot(h.pool, SCHEMAS, jobId!, 0, {
    records: ['x', 'y'],
  });

  rows = await getRecords(h.pool, jobId!);
  const before = rows[0]!.input_snapshot;
  expect(before).toEqual({ records: ['x', 'y'] });

  // Induce another capture trigger fire on the same (job_id, attempt) row.
  // The trigger fires AFTER INSERT OR UPDATE OF state — a no-op UPDATE that
  // mentions the state column in its SET list still fires the trigger, and
  // exercises the ON CONFLICT DO UPDATE path inside the trigger function.
  // We touch pgboss.job directly so we are not coupled to any specific
  // pg-boss transition path.
  await h.pool.query(
    `UPDATE ${SCHEMAS.pgboss}.job SET state = state WHERE id = $1`,
    [jobId],
  );

  rows = await getRecords(h.pool, jobId!);
  const after = rows[0]!.input_snapshot;
  expect(after).toEqual(before);
});

test('capture trigger DO UPDATE SET clause does not list input_snapshot', async () => {
  // Static check on the trigger function definition. If the SET list ever
  // grows an input_snapshot line, this fails at install time, before any
  // row-level test would catch it.
  const { rows } = await h.pool.query<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = 'capture'`,
    [SCHEMAS.pgbossier],
  );
  expect(rows[0]).toBeDefined();
  const def = rows[0]!.def;

  const setBlockMatch = /DO UPDATE SET[\s\S]*?;/i.exec(def);
  expect(setBlockMatch).not.toBeNull();
  expect(setBlockMatch![0]).not.toMatch(/input_snapshot/i);
});

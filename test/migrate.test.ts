import { test, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startHarness, type Harness, getRecords } from './harness.js';
import { install, migrate } from '../src/install.js';
import { bossier } from '../src/client.js';

// #28: drop+reinstall wiped exactly the forensic history pg-bossier exists to
// keep. migrate() (and install(), now additive) upgrades the record table in
// place — adding missing columns/indexes WITHOUT touching existing rows.

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.teardown(); });

/**
 * Build a deliberately-OLD `pgbossier.record` table: the pre-2026-06-21 shape,
 * before `input_snapshot` / `priority` / `retry_limit` / `singleton_key` / `seq`
 * existed, plus a stray obsolete GIN index. Seed one forensic row for a job that
 * is NOT in pgboss.job (i.e. already GC'd by pg-boss) — the exact data migrate()
 * must preserve.
 */
async function seedOldInstall(jobId: string): Promise<void> {
  await h.pool.query(`CREATE SCHEMA IF NOT EXISTS pgbossier`);
  await h.pool.query(`
    CREATE TABLE pgbossier.record (
      job_id          uuid        NOT NULL,
      queue           text        NOT NULL,
      attempt         integer     NOT NULL,
      state           text        NOT NULL,
      data            jsonb,
      output          jsonb,
      progress        jsonb,
      terminal_detail jsonb,
      created_on      timestamptz,
      started_on      timestamptz,
      completed_on    timestamptz,
      captured_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (job_id, attempt)
    );
  `);
  // An obsolete index a prior version shipped; migrate() should drop it.
  await h.pool.query(`CREATE INDEX record_output_gin ON pgbossier.record USING gin (output);`);
  await h.pool.query(
    `INSERT INTO pgbossier.record (job_id, queue, attempt, state, data, output, completed_on)
     VALUES ($1, 'gc-queue', 0, 'completed', '{"in":1}'::jsonb, '{"out":2}'::jsonb, now())`,
    [jobId],
  );
}

test('migrate() preserves a GC-outlived forensic row while adding new columns', async () => {
  const ghostId = randomUUID(); // a job pg-boss has already deleted
  await seedOldInstall(ghostId);

  await migrate(h.pool);

  // The pre-existing forensic row SURVIVES (the whole point of #28).
  const rows = await getRecords(h.pool, ghostId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.state).toBe('completed');
  expect(rows[0]!.data).toEqual({ in: 1 });
  expect(rows[0]!.output).toEqual({ out: 2 });
  // New columns now exist; the old row reads null for them, and seq was filled.
  expect(rows[0]!.priority).toBeNull();
  expect(rows[0]!.retry_limit).toBeNull();
  expect(rows[0]!.singleton_key).toBeNull();
  expect(rows[0]!.input_snapshot).toBeNull();
  expect(Number(rows[0]!.seq)).toBeGreaterThan(0);

  // Still readable through the typed client.
  const client = bossier({ boss: h.boss, pool: h.pool });
  const found = await client.findById(ghostId);
  expect(found?.state).toBe('completed');
});

test('migrate() brings the record table to the current column set', async () => {
  await seedOldInstall(randomUUID());
  await migrate(h.pool);
  const { rows } = await h.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  expect(rows.map((r) => r.column_name).sort()).toEqual(
    ['attempt', 'captured_at', 'claimed_by', 'completed_on', 'created_on', 'data',
     'input_snapshot', 'job_id', 'output', 'priority', 'progress', 'queue',
     'retry_limit', 'seq', 'singleton_key', 'started_on', 'state', 'terminal_detail'],
  );
});

test('migrate() drops obsolete indexes and creates the current set', async () => {
  await seedOldInstall(randomUUID());
  await migrate(h.pool);
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  const idx = rows.map((r) => r.indexname);
  expect(idx).not.toContain('record_output_gin'); // obsolete → dropped
  for (const want of ['record_queue_state_idx', 'record_seq_idx', 'record_terminal_detail_gin']) {
    expect(idx).toContain(want);
  }
});

test('capture works after migrate() — the trigger is (re)installed', async () => {
  await seedOldInstall(randomUUID());
  await migrate(h.pool);
  const queue = 'post-migrate';
  await h.boss.createQueue(queue);
  const jobId = (await h.boss.send(queue, { hello: 'world' }, { priority: 5 }))!;
  const rows = await getRecords(h.pool, jobId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.priority).toBe(5); // new column captured live
});

test('install() is also additively upgrade-safe (no data loss on re-run)', async () => {
  const ghostId = randomUUID();
  await seedOldInstall(ghostId);
  await install(h.pool); // install on an OLD-shape table must not wipe rows
  const rows = await getRecords(h.pool, ghostId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.priority).toBeNull(); // column added in place
});

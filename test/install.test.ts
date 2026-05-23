import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('install creates the pgbossier.record table with all 14 columns', async () => {
  const { rows } = await h.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  const cols = rows.map((r) => r.column_name).sort();
  expect(cols).toEqual(
    ['attempt', 'captured_at', 'completed_on', 'created_on', 'data', 'input_snapshot',
     'job_id', 'output', 'progress', 'queue', 'seq', 'started_on', 'state', 'terminal_detail'],
  );
});

test('install creates the base record indexes', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  const idx = rows.map((r) => r.indexname);
  for (const name of ['record_pkey', 'record_queue_state_idx', 'record_seq_idx', 'record_captured_at_idx',
                       'record_data_gin', 'record_output_gin', 'record_terminal_detail_gin']) {
    expect(idx).toContain(name);
  }
});

test('install creates the pgbossier_capture trigger on pgboss.job', async () => {
  const { rows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'pgboss.job'::regclass AND NOT tgisinternal`,
  );
  expect(rows.map((r) => r.tgname)).toContain('pgbossier_capture');
});

test('install creates the record_active_idx partial index', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  expect(rows.map((r) => r.indexname)).toContain('record_active_idx');
});

test('install creates pgbossier.record_seq sequence', async () => {
  const h = await startHarness();
  try {
    await install(h.pool);
    const { rows } = await h.pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname = 'record_seq' AND relnamespace = 'pgbossier'::regnamespace`,
    );
    expect(rows.length).toBe(1);
  } finally { await h.teardown(); }
});

test('install adds seq column to pgbossier.record with NOT NULL default', async () => {
  const h = await startHarness();
  try {
    await install(h.pool);
    const { rows } = await h.pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'pgbossier' AND table_name = 'record' AND column_name = 'seq'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.column_default).toContain(`nextval('pgbossier.record_seq'`);
  } finally { await h.teardown(); }
});

test('install is idempotent', async () => {
  const h = await startHarness();
  try { await install(h.pool); await install(h.pool); } finally { await h.teardown(); }
});

test('install adds seq column to a pre-existing v1 pgbossier.record (upgrade path)', async () => {
  const h = await startHarness();
  try {
    // Simulate a v1 install: schema + table, no sequence/seq column.
    await h.pool.query(`CREATE SCHEMA IF NOT EXISTS pgbossier;`);
    await h.pool.query(`
      CREATE TABLE pgbossier.record (
        job_id uuid NOT NULL, queue text NOT NULL, attempt integer NOT NULL,
        state text NOT NULL, data jsonb, output jsonb, progress jsonb,
        terminal_detail jsonb, input_snapshot jsonb,
        created_on timestamptz, started_on timestamptz, completed_on timestamptz,
        captured_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (job_id, attempt)
      );
    `);
    await h.pool.query(
      `INSERT INTO pgbossier.record (job_id, queue, attempt, state)
       VALUES ('00000000-0000-0000-0000-000000000001', 'q', 0, 'created')`,
    );
    await install(h.pool);
    const { rows } = await h.pool.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM pgbossier.record`,
    );
    expect(rows[0]!.seq).toMatch(/^\d+$/);
  } finally { await h.teardown(); }
});

import { test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';

// #24: ONE shared container for the whole file. Every install scenario here
// needs a virgin pg-bossier schema, but they can share a single pg-boss
// container if we reset to a clean slate between them — so beforeEach drops
// every pgbossier/alt schema the tests create (CASCADE also removes the capture
// trigger, which depends on pgbossier.capture()). This collapsed ~10
// per-test testcontainers down to 1. Add any new schema a test creates to the
// reset list — assume the DB is dirty, never assume it's clean.
let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });
beforeEach(async () => {
  await h.pool.query(
    `DROP SCHEMA IF EXISTS pgbossier, altbossier, altpgboss, partialboss CASCADE`,
  );
});

test('install creates the pgbossier.record table with all 18 columns', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  const cols = rows.map((r) => r.column_name).sort();
  expect(cols).toEqual(
    ['attempt', 'captured_at', 'claimed_by', 'completed_on', 'created_on', 'data',
     'input_snapshot', 'job_id', 'output', 'priority', 'progress', 'queue',
     'retry_limit', 'seq', 'singleton_key', 'started_on', 'state', 'terminal_detail'],
  );
});

test('install creates the base record indexes', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  const idx = rows.map((r) => r.indexname);
  for (const name of ['record_pkey', 'record_queue_state_idx', 'record_seq_idx', 'record_captured_at_idx',
                       'record_terminal_detail_gin']) {
    expect(idx).toContain(name);
  }
  // The data / output / input_snapshot GIN indexes were dropped — no read does
  // `@>` containment on those columns, and each GIN taxed every capture write.
  for (const dropped of ['record_data_gin', 'record_output_gin', 'record_input_snapshot_gin']) {
    expect(idx).not.toContain(dropped);
  }
});

test('install creates the pgbossier_capture trigger on pgboss.job', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
     WHERE tgrelid = 'pgboss.job'::regclass AND NOT tgisinternal`,
  );
  expect(rows.map((r) => r.tgname)).toContain('pgbossier_capture');
});

test('install creates the record_active_idx partial index', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  expect(rows.map((r) => r.indexname)).toContain('record_active_idx');
});

test('install creates pgbossier.record_seq sequence', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ relname: string }>(
    `SELECT relname FROM pg_class WHERE relname = 'record_seq' AND relnamespace = 'pgbossier'::regnamespace`,
  );
  expect(rows.length).toBe(1);
});

test('install adds seq column to pgbossier.record with NOT NULL default', async () => {
  await install(h.pool);
  const { rows } = await h.pool.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'pgbossier' AND table_name = 'record' AND column_name = 'seq'`,
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.is_nullable).toBe('NO');
  expect(rows[0]!.column_default).toContain(`nextval('pgbossier.record_seq'`);
});

test('install is idempotent', async () => {
  await install(h.pool);
  await install(h.pool);
});

test('install with custom schema names parameterizes trigger and channel', async () => {
  // Set up an alternate pg-boss schema (so the trigger has a target). For the
  // test, create the minimum pgboss.job-like table.
  await h.pool.query(`CREATE SCHEMA IF NOT EXISTS altpgboss`);
  await h.pool.query(`
    CREATE TABLE IF NOT EXISTS altpgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, retry_count integer NOT NULL DEFAULT 0,
      state text NOT NULL, data jsonb, output jsonb,
      priority integer NOT NULL DEFAULT 0, retry_limit integer NOT NULL DEFAULT 0,
      singleton_key text,
      created_on timestamptz, started_on timestamptz, completed_on timestamptz
    );
  `);

  await install(h.pool, { schema: 'altbossier', pgbossSchema: 'altpgboss' });

  // Verify the alt schema + objects exist
  const { rows: schemaRows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'altbossier'`,
  );
  expect(schemaRows).toHaveLength(1);

  // Verify the trigger name is schema-scoped (altbossier_capture, NOT pgbossier_capture)
  const { rows: triggerRows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'altpgboss.job'::regclass AND tgname LIKE '%_capture'`,
  );
  expect(triggerRows).toHaveLength(1);
  expect(triggerRows[0]!.tgname).toBe('altbossier_capture');
});

test('install rejects schema:"public" before any SQL runs (data-loss prevention)', async () => {
  await expect(install(h.pool, { schema: 'public' })).rejects.toThrow(/reserved/);
  // Verify NO schema was created (no SQL ran)
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

test('two installs with different pgbossier schemas keep distinct triggers', async () => {
  await install(h.pool); // default 'pgbossier'

  // Verify install A's trigger exists
  let trig = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_capture'`,
  );
  expect(trig.rows).toHaveLength(1);

  await install(h.pool, { schema: 'altbossier' });

  // After install B, both triggers should exist on pgboss.job
  trig = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname IN ('pgbossier_capture', 'altbossier_capture')`,
  );
  expect(trig.rows).toHaveLength(2);
  // Install A's trigger MUST still exist (regression test for the v1 collision bug)
  expect(trig.rows.map(r => r.tgname).sort()).toEqual(['altbossier_capture', 'pgbossier_capture']);
});

test('install with wrong pgbossSchema fails on preflight, leaving no state behind', async () => {
  // pg-boss is in default 'pgboss' schema; we pass 'wrong'
  await expect(
    install(h.pool, { pgbossSchema: 'wrong' }),
  ).rejects.toThrow(/wrong/);

  // Critically: pgbossier schema MUST NOT exist (no partial install)
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

test('install is transactional — mid-install failure leaves nothing behind', async () => {
  // A pgbossSchema that exists but has no job table → preflight catches it.
  await h.pool.query(`CREATE SCHEMA IF NOT EXISTS partialboss`);

  await expect(
    install(h.pool, { pgbossSchema: 'partialboss' }),
  ).rejects.toThrow(/partialboss/);

  // pgbossier schema must not exist
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('install creates the pgbossier.record table with all 13 columns', async () => {
  const { rows } = await h.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'pgbossier' AND table_name = 'record'`,
  );
  const cols = rows.map((r) => r.column_name).sort();
  expect(cols).toEqual(
    ['attempt', 'captured_at', 'completed_on', 'created_on', 'data', 'input_snapshot',
     'job_id', 'output', 'progress', 'queue', 'started_on', 'state', 'terminal_detail'],
  );
});

test('install creates the base record indexes', async () => {
  const { rows } = await h.pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'pgbossier' AND tablename = 'record'`,
  );
  const idx = rows.map((r) => r.indexname);
  for (const name of ['record_pkey', 'record_queue_state_idx', 'record_captured_at_idx',
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

import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { recordPatch } from '../src/record.js';
import { resolveSchemas } from '../src/sql.js';

// Compile-time regression guard. `@ts-expect-error` compiles ONLY when
// `terminal_detail` is NOT a member of `RecordPatch`. If a future refactor
// accidentally re-adds the field, this fixture fails to compile and the
// build fails. `recordTerminalDetail` (Task 4) is the sole writer for
// `terminal_detail`; `recordPatch` deliberately does not accept it.
// @ts-expect-error — RecordPatch no longer accepts terminal_detail.
const _shouldNotCompile: import('../src/record.js').RecordPatch = {
  terminal_detail: { ignored: true },
};
void _shouldNotCompile;

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

const schemas = resolveSchemas({});

test('recordPatch still writes input_snapshot after the narrowing', async () => {
  const queue = 'recordpatch-input';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  await recordPatch(h.pool, schemas, jobId!, 0, { input_snapshot: { foo: 'bar' } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.input_snapshot).toEqual({ foo: 'bar' });
  // The trigger-owned columns are untouched by the narrowed UPDATE.
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ in: 1 });
});

test('recordPatch with explicit null clears the column', async () => {
  const queue = 'recordpatch-clear';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  // Write a value first so we have something to clear.
  await recordPatch(h.pool, schemas, jobId!, 0, { input_snapshot: { foo: 'bar' } });
  const beforeRows = await getRecords(h.pool, jobId!);
  expect(beforeRows[0]!.input_snapshot).toEqual({ foo: 'bar' });

  // Explicit null clears the column to SQL NULL (not JSON null).
  await recordPatch(h.pool, schemas, jobId!, 0, { input_snapshot: null });

  const { rows } = await h.pool.query<{ input_snapshot: unknown; is_sql_null: boolean }>(
    `SELECT input_snapshot, input_snapshot IS NULL AS is_sql_null
       FROM ${schemas.pgbossier}.record
      WHERE job_id = $1 AND attempt = 0`,
    [jobId],
  );
  expect(rows[0]!.is_sql_null).toBe(true);
  expect(rows[0]!.input_snapshot).toBeNull();
});

test('recordPatch with omitted field is a no-op', async () => {
  const queue = 'recordpatch-noop';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  // Write a value first.
  await recordPatch(h.pool, schemas, jobId!, 0, { input_snapshot: { foo: 'bar' } });

  // Empty patch must not touch the column.
  await recordPatch(h.pool, schemas, jobId!, 0, {});

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.input_snapshot).toEqual({ foo: 'bar' });
});

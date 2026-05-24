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

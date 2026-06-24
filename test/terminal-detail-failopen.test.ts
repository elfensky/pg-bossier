import { test, expect, vi } from 'vitest';
import { recordTerminalDetail } from '../src/terminal-detail.js';
import { resolveSchemas } from '../src/sql.js';
import type { BossierDb } from '../src/db.js';

// #36: recordTerminalDetail must be fail-open like every other audit writer —
// a DB error or a malformed id must never throw into the consumer's job
// handler. Pure-unit (stub db), no container needed.

const SCHEMAS = resolveSchemas();
const VALID_UUID = '00000000-0000-0000-0000-000000000000';

test('recordTerminalDetail swallows a DB error (fail-open, no throw)', async () => {
  const db = {
    query: () => Promise.reject(new Error('terminating connection due to administrator command')),
  } as unknown as BossierDb;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(
    recordTerminalDetail(db, SCHEMAS, VALID_UUID, 0, { state: 'completed', detail: {} }),
  ).resolves.toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test('recordTerminalDetail short-circuits a malformed job id without querying', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const db = { query } as unknown as BossierDb;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(
    recordTerminalDetail(db, SCHEMAS, 'not-a-uuid', 0, { state: 'completed', detail: {} }),
  ).resolves.toBeUndefined();
  expect(query).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

test('recordTerminalDetail still throws on validation errors (programmer error)', async () => {
  const db = {
    query: () => Promise.reject(new Error('should never be reached')),
  } as unknown as BossierDb;
  await expect(
    recordTerminalDetail(db, SCHEMAS, VALID_UUID, 0, {
      // @ts-expect-error — failed state requires a class
      state: 'failed',
      detail: {},
    }),
  ).rejects.toThrow(/validation/);
});

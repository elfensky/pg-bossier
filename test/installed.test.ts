import { test, expect, vi } from 'vitest';
import { softReadDb } from '../src/installed.js';
import type { BossierDb } from '../src/db.js';

// #40: softReadDb degrades a read to empty ONLY for undefined_table (42P01).
// Pure-unit (stub db), no container.

test('softReadDb returns empty rows on undefined_table (42P01)', async () => {
  const err = Object.assign(new Error('relation "pgbossier.record" does not exist'), { code: '42P01' });
  const db = { query: () => Promise.reject(err) } as unknown as BossierDb;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const res = await softReadDb(db).query('SELECT 1');
  expect(res.rows).toEqual([]);
  expect(warn).toHaveBeenCalled(); // the single fail-soft warning
  warn.mockRestore();
});

test('softReadDb re-throws a non-undefined-table error (does NOT mask real faults)', async () => {
  const err = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const db = { query: () => Promise.reject(err) } as unknown as BossierDb;
  await expect(softReadDb(db).query('SELECT 1')).rejects.toThrow(/deadlock/);
});

test('softReadDb passes a successful query through unchanged', async () => {
  const db = {
    query: () => Promise.resolve({ rows: [{ a: 1 }], rowCount: 1 }),
  } as unknown as BossierDb;
  const res = await softReadDb(db).query<{ a: number }>('SELECT 1');
  expect(res.rows).toEqual([{ a: 1 }]);
});

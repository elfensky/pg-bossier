import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #40: pg-boss is started but pg-bossier is NOT installed (startHarness does not
// install). Reads must fail-soft (return empty, not throw a raw 42P01) so a
// forgotten migrate degrades instead of 500ing the host's request path — and
// isBossierInstalled() reports the state for an explicit startup gate.

const UUID = '00000000-0000-0000-0000-000000000000';

let h: Harness;
beforeEach(async () => { h = await startHarness(); }); // NOTE: no install()
afterEach(async () => { await h.teardown(); });

test('isBossierInstalled() is false before install, true after', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(await client.isBossierInstalled()).toBe(false);
  await install(h.pool);
  expect(await client.isBossierInstalled()).toBe(true);
});

test('every record read fails soft (returns empty, never throws) when not installed', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  expect(await client.findById(UUID)).toBeNull();
  expect(await client.getRetryHistory(UUID)).toEqual([]);
  expect(await client.getClaim(UUID)).toBeNull();
  expect(await client.getProgress(UUID)).toBeNull();
  expect(await client.getInputSnapshot(UUID)).toBeNull();
  expect(await client.listJobs()).toEqual({ rows: [], total: 0 });
  expect(await client.latestPerQueue(['q'])).toEqual([]);
  expect(await client.listLongRunning()).toEqual([]);
  expect(await client.getEventsSince(0n)).toEqual([]);
  expect(await client.findDeadLetterSource(UUID)).toBeNull();
  expect(await client.findDeadLetterTarget(UUID)).toBeNull();
  expect(await client.countByState()).toEqual({
    created: 0, active: 0, retry: 0, completed: 0, cancelled: 0, failed: 0,
  });
  expect(await client.countByQueue()).toEqual({});

  warn.mockRestore();
});

test('reads work normally once installed', async () => {
  await install(h.pool);
  const client = bossier({ boss: h.boss, pool: h.pool });
  // A real read against the now-present (empty) chronicle returns its empty
  // value too — but via the happy path, not the fail-soft fallback.
  expect(await client.countByState()).toEqual({
    created: 0, active: 0, retry: 0, completed: 0, cancelled: 0, failed: 0,
  });
  expect(await client.findById(UUID)).toBeNull();
});

import { test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

// #40: pg-boss is started but pg-bossier is NOT installed (startHarness does not
// install). Reads must fail-soft (return empty, not throw a raw 42P01) so a
// forgotten migrate degrades instead of 500ing the host's request path — and
// isBossierInstalled() reports the state for an explicit startup gate.
// #24: one shared container; reset to a clean NOT-installed slate between tests.

const UUID = '00000000-0000-0000-0000-000000000000';

let h: Harness;
beforeAll(async () => { h = await startHarness(); }); // NOTE: no install()
afterAll(async () => { await h.teardown(); });
beforeEach(async () => {
  await h.pool.query('DROP SCHEMA IF EXISTS pgbossier CASCADE; DELETE FROM pgboss.job;');
});

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

test('setClaim returns false (quiet, no throw) when not installed', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(client.setClaim(UUID, 'w1')).resolves.toBe(false);
  expect(warn).not.toHaveBeenCalled(); // not-installed is a normal CAS false, not warned
  warn.mockRestore();
});

test('captureHealth reports all-null when not installed (not a false-healthy 0/0)', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(await client.captureHealth()).toEqual({
    lastCapturedSeq: null, lastCapturedAt: null, checked: null, missing: null,
  });
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

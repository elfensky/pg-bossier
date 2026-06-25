import { test, expect, beforeEach, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { bossier } from '../src/client.js';

// #39: opt-in startup provisioning. startHarness does NOT install pg-bossier, so
// these exercise the provision-at-startup path against a fresh schema.

const EMPTY_COUNTS = {
  created: 0, active: 0, retry: 0, completed: 0, cancelled: 0, failed: 0,
};

let h: Harness;
beforeEach(async () => { h = await startHarness(); }); // NOTE: no install()
afterEach(async () => { await h.teardown(); });

test('autoMigrate: true provisions the schema at startup', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool, autoMigrate: true });
  // The migration was kicked off in the (sync) constructor; await the barrier.
  await client.ensureInstalled();
  expect(await client.isBossierInstalled()).toBe(true);
  expect(await client.countByState()).toEqual(EMPTY_COUNTS); // a real read works
});

test('ensureInstalled() runs migrate once and is idempotent under concurrency', async () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(await client.isBossierInstalled()).toBe(false);
  // Concurrent calls share the one in-flight migration (no double-migrate error).
  await Promise.all([
    client.ensureInstalled(), client.ensureInstalled(), client.ensureInstalled(),
  ]);
  expect(await client.isBossierInstalled()).toBe(true);
  await client.ensureInstalled(); // calling again after success is a no-op
  expect(await client.isBossierInstalled()).toBe(true);
});

test('ensureInstalled() without a pool rejects with a clear error', async () => {
  const client = bossier({ boss: h.boss }); // BYO connection, no pool
  await expect(client.ensureInstalled()).rejects.toThrow(/requires a `pool`/);
});

test('autoMigrate: true without a pool throws at construction', async () => {
  expect(() => bossier({ boss: h.boss, autoMigrate: true })).toThrow(/requires a `pool`/);
});

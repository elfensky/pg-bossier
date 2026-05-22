import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { subscribe } from '../src/events.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('subscribe() returns events that emit "connected" on LISTEN', async () => {
  const events = await subscribe(h.pool);
  // Most implementations emit 'connected' before subscribe() resolves.
  // Either we caught it already or it'll fire on a future tick.
  const connected = new Promise<void>((resolve) => events.once('connected', resolve));
  await Promise.race([
    connected,
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 2000)),
  ]);
  await events.close();
});

test('close() releases the connection back to the pool', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  // After close, idle count should equal total (connection released).
  expect(h.pool.idleCount).toBe(h.pool.totalCount);
});

test('close() is idempotent', async () => {
  const events = await subscribe(h.pool);
  await events.close();
  await events.close();
});

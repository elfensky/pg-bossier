import { test, expect } from 'vitest';
import * as api from '../src/index.js';

// WS-E: the "complete single surface" — a consumer imports everything (pg-boss's
// class + ORM adapters + types, plus pg-bossier's own API) from `pg-bossier`.
// Pure unit test: importing the entry point is side-effect-free (no DB).

test('re-exports pg-boss class + ORM adapters from one entry point', () => {
  expect(typeof api.PgBoss).toBe('function');
  expect(typeof api.fromPrisma).toBe('function');
  expect(typeof api.fromKnex).toBe('function');
  expect(typeof api.fromKysely).toBe('function');
  expect(typeof api.fromDrizzle).toBe('function');
});

test('exposes pg-bossier own API from the same entry point', () => {
  // The value surface is deliberately minimal: the client factory + the three
  // provisioning functions that run without a client. Everything else hangs off
  // the bossier() client (see the next test).
  expect(typeof api.bossier).toBe('function');
  expect(typeof api.install).toBe('function');
  expect(typeof api.migrate).toBe('function');
  expect(typeof api.uninstall).toBe('function');
});

test('operational free functions are NOT standalone value exports — go through the client', () => {
  // These take pg-bossier's internal (db, schemas, …) convention; consumers reach
  // them as bossier() client methods, never as hand-threaded standalone calls.
  const internalOnly = [
    'subscribeEvents', 'getLiveState', 'getLiveHeartbeat', 'getLiveHeartbeats',
    'captureHealth', 'isBossierInstalled', 'prune', 'exportRecords',
    'importRecords', 'pgBossDb',
  ] as const;
  for (const name of internalOnly) {
    expect((api as Record<string, unknown>)[name]).toBeUndefined();
  }
});

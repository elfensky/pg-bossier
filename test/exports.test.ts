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
  expect(typeof api.bossier).toBe('function');
  expect(typeof api.install).toBe('function');
  expect(typeof api.uninstall).toBe('function');
  expect(typeof api.subscribeEvents).toBe('function');
  expect(typeof api.getLiveState).toBe('function');
  expect(typeof api.getLiveHeartbeat).toBe('function');
  expect(typeof api.pgBossDb).toBe('function');
});

test('pg-bossier own exports win over pg-boss star re-exports (no shadowing)', () => {
  // subscribeEvents is pg-bossier's, not pg-boss's (pg-boss has no such export);
  // confirms the explicit export is what a consumer gets.
  expect(api.subscribeEvents.name).toBe('subscribeEvents');
});

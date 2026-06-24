import { test, expect, vi } from 'vitest';
import { subscribeEvents } from '../src/events.js';
import { resolveSchemas } from '../src/sql.js';
import type { Pool } from 'pg';

// #37: open() must release the acquired client if setup fails after connect(),
// or a reconnect loop leaks one pooled connection per attempt until the pool
// exhausts. Pure-unit (fake pool/client), no container needed.

const SCHEMAS = resolveSchemas();

test('subscribeEvents releases the client when LISTEN fails — no pool leak', async () => {
  const release = vi.fn();
  const client = {
    on: () => client,
    off: () => client,
    query: () => Promise.reject(new Error('LISTEN failed')),
    release,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;

  await expect(subscribeEvents(pool, SCHEMAS)).rejects.toThrow(/LISTEN failed/);
  // The connection went back to the pool instead of leaking.
  expect(release).toHaveBeenCalledTimes(1);
});

test('subscribeEvents rejects synchronously on an already-aborted signal', async () => {
  const pool = {
    connect: () => Promise.reject(new Error('connect should not be reached')),
  } as unknown as Pool;
  const ac = new AbortController();
  ac.abort();
  await expect(
    subscribeEvents(pool, SCHEMAS, { signal: ac.signal }),
  ).rejects.toThrow(/Aborted/);
});

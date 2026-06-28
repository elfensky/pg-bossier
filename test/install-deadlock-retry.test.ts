import { test, expect } from 'vitest';
import { install } from '../src/install.js';

// #47: ensureInstalled() deadlocked (40P01) on every boot because the trigger
// DDL contends with a live pg-boss on pgboss.job. A real deadlock is too flaky
// to orchestrate, so drive the retry loop through install() with a fake pool
// whose client throws 40P01 on the first COMMIT, then succeeds — proving the
// transient deadlock is retried (not surfaced) and converges.
function fakeClient(deadlocksOnCommit: number) {
  let commits = 0;
  const calls: string[] = [];
  const client = {
    calls,
    query: (text: string) => {
      calls.push(text);
      if (text === 'COMMIT' && commits++ < deadlocksOnCommit) {
        return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      }
      // Backfill probe: return an empty batch to end the keyset loop at once.
      if (/pgboss\.job/.test(text) && /last_id/.test(text)) {
        return Promise.resolve({ rows: [{ last_id: null, scanned: 0, inserted: 0 }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Pool stub
  const pool = { connect: () => Promise.resolve(client) } as any;
  return { pool, client };
}

test('install retries the DDL transaction on a deadlock and converges', async () => {
  const { pool, client } = fakeClient(2); // deadlock twice, succeed on the 3rd
  await expect(install(pool)).resolves.toEqual({ backfilled: 0 });
  expect(client.calls.filter((c) => c === 'BEGIN')).toHaveLength(3);
  expect(client.calls.filter((c) => c === 'ROLLBACK')).toHaveLength(2);
});

test('install gives up after the retry cap and re-throws the deadlock', async () => {
  const { pool } = fakeClient(99); // deadlock every attempt
  await expect(install(pool)).rejects.toMatchObject({ code: '40P01' });
});

test('a non-deadlock error is not retried', async () => {
  const { pool, client } = fakeClient(0);
  client.query = (text: string) => {
    client.calls.push(text);
    if (text === 'COMMIT') {
      return Promise.reject(Object.assign(new Error('boom'), { code: '42P01' }));
    }
    return Promise.resolve({ rows: [] });
  };
  await expect(install(pool)).rejects.toMatchObject({ code: '42P01' });
  expect(client.calls.filter((c) => c === 'BEGIN')).toHaveLength(1);
});

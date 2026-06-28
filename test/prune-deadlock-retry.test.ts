import { test, expect } from 'vitest';
import { prune } from '../src/prune.js';
import { resolveSchemas } from '../src/sql.js';

// #47: prune is fail-loud (returns a count the caller trusts), and its multi-row
// DELETE can deadlock against the live capture trigger on overlapping
// pgbossier.record rows. Drive the retry through prune() with a fake db whose
// single DELETE throws 40P01 a few times, then succeeds — proving the transient
// deadlock is retried, not surfaced.
const schemas = resolveSchemas();

function fakeDb(deadlocks: number) {
  let calls = 0;
  let attempts = 0;
  const db = {
    attempts: () => attempts,
    query: () => {
      attempts++;
      if (calls++ < deadlocks) {
        return Promise.reject(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
      }
      return Promise.resolve({ rows: [{ job_id: 'a' }, { job_id: 'b' }] });
    },
  };
  return db;
}

test('prune retries the DELETE on a deadlock and converges', async () => {
  const db = fakeDb(2); // deadlock twice, succeed on the 3rd
  await expect(prune(db, schemas, { keepLastPerQueue: 0 })).resolves.toEqual({ deleted: 2 });
  expect(db.attempts()).toBe(3);
});

test('prune gives up after the retry cap and re-throws the deadlock', async () => {
  const db = fakeDb(99);
  await expect(prune(db, schemas, { keepLastPerQueue: 0 })).rejects.toMatchObject({ code: '40P01' });
});

test('prune does not retry a non-deadlock error', async () => {
  let attempts = 0;
  const db = {
    query: () => {
      attempts++;
      return Promise.reject(Object.assign(new Error('boom'), { code: '42P01' }));
    },
  };
  await expect(prune(db, schemas, { keepLastPerQueue: 0 })).rejects.toMatchObject({ code: '42P01' });
  expect(attempts).toBe(1);
});

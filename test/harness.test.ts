import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('harness brings up Postgres with the pgboss schema', async () => {
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job'`,
  );
  expect(rows).toHaveLength(1);
});

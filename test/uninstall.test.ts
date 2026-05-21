import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install, uninstall } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

test('uninstall removes the schema, table, function, and the trigger on pgboss.job', async () => {
  await uninstall(h.pool);

  const schema = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(schema.rows).toHaveLength(0);

  const trigger = await h.pool.query(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_capture'`,
  );
  expect(trigger.rows).toHaveLength(0);

  // pgboss.job itself is untouched
  const job = await h.pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'pgboss' AND table_name = 'job'`,
  );
  expect(job.rows).toHaveLength(1);
});

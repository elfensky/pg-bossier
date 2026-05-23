import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install, uninstall } from '../src/install.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('topology: 1:1 (default) — pgbossier + pgboss', async () => {
  await install(h.pool);  // default 'pgbossier' / 'pgboss'
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(1);
  await uninstall(h.pool);
});

test('topology: N:N-distinct — two pg-bossier installs, two pg-boss installs', async () => {
  // Set up alt pg-boss
  await h.pool.query(`CREATE SCHEMA IF NOT EXISTS altpgboss`);
  await h.pool.query(`
    CREATE TABLE IF NOT EXISTS altpgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, retry_count integer NOT NULL DEFAULT 0,
      state text NOT NULL, data jsonb, output jsonb,
      created_on timestamptz, started_on timestamptz, completed_on timestamptz
    );
  `);

  // Install pg-bossier A against pg-boss A
  await install(h.pool, { schema: 'pgbossier_a', pgbossSchema: 'pgboss' });
  // Install pg-bossier B against pg-boss B (alternate)
  await install(h.pool, { schema: 'pgbossier_b', pgbossSchema: 'altpgboss' });

  // Triggers exist on different source tables — verify
  const { rows: triggerA } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_a_capture'`,
  );
  expect(triggerA).toHaveLength(1);

  const { rows: triggerB } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'altpgboss.job'::regclass AND tgname = 'pgbossier_b_capture'`,
  );
  expect(triggerB).toHaveLength(1);

  // Uninstall A — verify B's schema survives
  await uninstall(h.pool, { schema: 'pgbossier_a' });
  const { rows: bSurvives } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier_b'`,
  );
  expect(bSurvives).toHaveLength(1);

  // Cleanup
  await uninstall(h.pool, { schema: 'pgbossier_b' });
  await h.pool.query(`DROP SCHEMA IF EXISTS altpgboss CASCADE`);
});

test('topology: 2:1 (unsupported) — two pg-bossier installs sharing one pg-boss schema', async () => {
  // The spec says this is unsupported. The test pins the observed behavior:
  // both installs succeed because trigger names are now schema-scoped, but
  // both triggers fire on every pg-boss op — duplicate captures.

  await install(h.pool); // 'pgbossier' on 'pgboss'
  await install(h.pool, { schema: 'altbossier' }); // 'altbossier' on default 'pgboss'

  // Both triggers exist on pgboss.job
  const { rows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass
     AND tgname IN ('pgbossier_capture', 'altbossier_capture') ORDER BY tgname`,
  );
  expect(rows.map(r => r.tgname)).toEqual(['altbossier_capture', 'pgbossier_capture']);

  // Send a job — verify BOTH audit tables capture it (the "unsupported" duplication)
  await h.boss.createQueue('topology-2to1');
  const jobId = await h.boss.send('topology-2to1', { x: 1 });

  await new Promise(r => setTimeout(r, 100));

  const { rows: defaultCapture } = await h.pool.query(
    `SELECT 1 FROM pgbossier.record WHERE job_id = $1`,
    [jobId],
  );
  const { rows: altCapture } = await h.pool.query(
    `SELECT 1 FROM altbossier.record WHERE job_id = $1`,
    [jobId],
  );
  // Both audit tables captured the same job — this is the "duplication" the
  // spec documents as the reason for marking 2:1 unsupported.
  expect(defaultCapture).toHaveLength(1);
  expect(altCapture).toHaveLength(1);

  await uninstall(h.pool);
  await uninstall(h.pool, { schema: 'altbossier' });
});

test('topology: install rejects schema:"public" before any SQL', async () => {
  await expect(install(h.pool, { schema: 'public' })).rejects.toThrow(/reserved/);
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

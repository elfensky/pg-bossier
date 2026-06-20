import type { Pool } from 'pg';
import {
  resolveSchemas,
  schemaSql, sequenceSql, recordTableSql, recordIndexesSql,
  captureFunctionSql, captureTriggerSql, backfillSql,
} from './sql.js';

export interface InstallOptions {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

export async function install(
  pool: Pool, options?: InstallOptions,
): Promise<void> {
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    options?.pgbossSchema,
  });

  const client = await pool.connect();
  try {
    // Preflight: confirm the pg-boss source table exists. Fails fast with
    // a clear error before any DDL runs.
    await client.query(`SELECT 1 FROM ${s.pgboss}.job LIMIT 0`);

    // Atomic install: BEGIN/COMMIT around all DDL. Postgres supports DDL
    // in transactions; a mid-install failure rolls back everything, so the
    // schema is never left half-built.
    await client.query('BEGIN');
    try {
      await client.query(schemaSql(s));
      await client.query(sequenceSql(s));
      await client.query(recordTableSql(s));
      for (const idx of recordIndexesSql(s)) await client.query(idx);
      await client.query(captureFunctionSql(s));
      await client.query(captureTriggerSql(s));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* connection may be dead */ });
      throw err;
    }

    // Backfill runs AFTER the DDL commits — deliberately outside the transaction.
    // CREATE/DROP TRIGGER above takes a heavy lock on pgboss.job (DROP TRIGGER:
    // ACCESS EXCLUSIVE; CREATE TRIGGER: SHARE ROW EXCLUSIVE), held until COMMIT.
    // Running the backfill inside that transaction would hold the lock for the
    // whole INSERT...SELECT, blocking every pg-boss queue write (and read) for as
    // long as the backfill runs — freezing a live queue on a large pgboss.job.
    // Committing first releases the lock and makes the trigger live; this
    // INSERT...SELECT then takes only ACCESS SHARE on pgboss.job and never blocks
    // pg-boss. ON CONFLICT DO NOTHING means a row the now-live trigger already
    // captured in the gap is not clobbered, and re-running install() safely
    // completes a backfill that errored here (idempotent).
    await client.query(backfillSql(s));
  } finally {
    client.release();
  }
}

export async function uninstall(
  pool: Pool, options?: Pick<InstallOptions, 'schema'>,
): Promise<void> {
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    'pgboss',
  });
  await pool.query(`DROP SCHEMA IF EXISTS ${s.pgbossier} CASCADE;`);
}

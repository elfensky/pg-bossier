import type { Pool } from 'pg';
import {
  resolveSchemas,
  schemaSql, sequenceSql, recordTableSql, recordIndexesSql,
  recordSeqColumnSql, recordSeqIndexSql,
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
    // in transactions; a mid-install failure rolls back everything.
    await client.query('BEGIN');
    await client.query(schemaSql(s));
    await client.query(sequenceSql(s));
    await client.query(recordTableSql(s));
    await client.query(recordSeqColumnSql(s));
    await client.query(recordSeqIndexSql(s));
    for (const idx of recordIndexesSql(s)) await client.query(idx);
    await client.query(captureFunctionSql(s));
    await client.query(captureTriggerSql(s));
    await client.query(backfillSql(s));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection may be dead */ });
    throw err;
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

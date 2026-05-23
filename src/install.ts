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
  await pool.query(schemaSql(s));
  await pool.query(sequenceSql(s));
  await pool.query(recordTableSql(s));
  await pool.query(recordSeqColumnSql(s));
  await pool.query(recordSeqIndexSql(s));
  for (const idx of recordIndexesSql(s)) await pool.query(idx);
  await pool.query(captureFunctionSql(s));
  await pool.query(captureTriggerSql(s));
  await pool.query(backfillSql(s));
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

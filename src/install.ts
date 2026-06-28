import type { Pool, PoolClient } from 'pg';
import {
  resolveSchemas, type SchemaNames,
  schemaSql, sequenceSql, recordTableSql, alterRecordColumnsSql,
  recordIndexesSql, dropObsoleteIndexesSql,
  captureFunctionSql, captureTriggerSql, backfillChunkSql,
} from './sql.js';

export interface InstallOptions {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
  /**
   * Rows per backfill batch (#11). The install-time backfill copies
   * `pgboss.job` into `pgbossier.record` in keyset-paginated batches of this
   * size — one code path for every install size. Default 10_000; lower it to
   * bound per-statement work / memory when backfilling a very large
   * `pgboss.job` on a constrained box. Must be a positive integer.
   */
  backfillChunkSize?: number;
}

/** Result of {@link install} / {@link migrate}. */
export interface InstallResult {
  /**
   * How many rows the install-time backfill copied from `pgboss.job` into
   * `pgbossier.record` (#11). `0` on a fresh DB with no pre-existing jobs, or on
   * a re-run where every row already exists (`ON CONFLICT DO NOTHING`).
   */
  backfilled: number;
}

const DEFAULT_BACKFILL_CHUNK = 10_000;
/** Min uuid — the keyset cursor's starting point (`id > $1`). */
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

function resolveBackfillChunk(size: number | undefined): number {
  if (size === undefined) return DEFAULT_BACKFILL_CHUNK;
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `pg-bossier: backfillChunkSize must be a positive integer, got ${String(size)}`,
    );
  }
  return size;
}

/**
 * Apply pg-bossier's current schema shape to the database, idempotently and
 * non-destructively. Shared by {@link install} and {@link migrate}.
 *
 * The DDL is additive only: `CREATE ... IF NOT EXISTS` for new objects,
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for columns a prior version's
 * table lacks, `DROP INDEX IF EXISTS` for indexes a prior version created but
 * current pg-bossier doesn't. No `DROP TABLE`, no `DROP SCHEMA`, no `DELETE` —
 * existing `record` rows always survive (issue #28).
 */
async function applySchema(
  client: PoolClient, s: SchemaNames, chunkSize: number,
): Promise<number> {
  // Preflight: confirm the pg-boss source table exists. Fails fast with a
  // clear error before any DDL runs.
  await client.query(`SELECT 1 FROM ${s.pgboss}.job LIMIT 0`);

  // Atomic: BEGIN/COMMIT around all DDL. Postgres supports DDL in transactions;
  // a mid-flight failure rolls back everything, so the schema is never left
  // half-built.
  await client.query('BEGIN');
  try {
    // Serialize concurrent install/migrate across processes/replicas (#39
    // autoMigrate): a transaction-scoped advisory lock keyed by the pgbossier
    // schema name. Without it, two replicas racing to migrate can collide on
    // CREATE/ALTER ... IF NOT EXISTS / CREATE OR REPLACE (Postgres doesn't fully
    // serialize those existence checks). The loser now waits for the winner's
    // COMMIT, then its own IF NOT EXISTS steps see everything present and no-op.
    // Released automatically at COMMIT/ROLLBACK. Distinct schemas → distinct keys.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pgbossier:${s.pgbossier}`]);
    await client.query(schemaSql(s));
    await client.query(sequenceSql(s));
    await client.query(recordTableSql(s));
    // ADD COLUMN IF NOT EXISTS — brings a table from a prior shipped version up
    // to the current column set without rewriting rows. No-op on a fresh table.
    await client.query(alterRecordColumnsSql(s));
    for (const idx of dropObsoleteIndexesSql(s)) await client.query(idx);
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
  // Committing first releases the lock and makes the trigger live; the backfill
  // batches below then take only ACCESS SHARE on pgboss.job and never block
  // pg-boss. ON CONFLICT DO NOTHING means a row the now-live trigger already
  // captured in the gap is not clobbered (and never overwrites an existing
  // chronicle row), and re-running safely completes a backfill that errored
  // here (idempotent).
  //
  // Batched (#11): keyset-paginate pgboss.job by id, copying `chunkSize` rows
  // per statement until a batch returns fewer than `chunkSize` (the last one).
  // One code path for every size — a small install is a single batch, millions
  // are N small batches (bounded per-statement work/WAL, resumable). Each batch
  // is its own implicit transaction (we're outside BEGIN/COMMIT now).
  let lastId = MIN_UUID;
  let backfilled = 0;
  for (;;) {
    const { rows } = await client.query<{ last_id: string | null; scanned: number; inserted: number }>(
      backfillChunkSql(s), [lastId, chunkSize],
    );
    const batch = rows[0];
    if (!batch || batch.scanned === 0) break;
    backfilled += batch.inserted;
    if (batch.last_id === null || batch.scanned < chunkSize) break; // last batch
    lastId = batch.last_id;
  }
  return backfilled;
}

/**
 * Install pg-bossier: create its schema, the `record` chronicle table and
 * indexes, the capture trigger on `pgboss.job`, then backfill from rows still
 * present in `pgboss.job`.
 *
 * Idempotent and non-destructive — safe to re-run, and safe to run against an
 * install from a prior pg-bossier version: it adds any missing columns/indexes
 * in place and preserves every existing `record` row (see {@link migrate},
 * which is the same operation under an upgrade-intent name).
 *
 * Returns `{ backfilled }` — how many pre-existing `pgboss.job` rows the backfill
 * copied into the chronicle (#11).
 */
export async function install(
  pool: Pool, options?: InstallOptions,
): Promise<InstallResult> {
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    options?.pgbossSchema,
  });
  const chunkSize = resolveBackfillChunk(options?.backfillChunkSize);
  const client = await pool.connect();
  try {
    const backfilled = await applySchema(client, s, chunkSize);
    return { backfilled };
  } finally {
    client.release();
  }
}

/**
 * Upgrade an existing pg-bossier install in place, **preserving all captured
 * history**. Use this instead of `uninstall()` + `install()` when moving an
 * already-adopted install to a newer pg-bossier schema (issue #28): the old
 * drop+reinstall convention discarded exactly the forensic records that survive
 * pg-boss's `deletion_seconds` GC — the only reason to run pg-bossier.
 *
 * Mechanically identical to {@link install} (both apply the current shape
 * additively); `migrate` exists to name the upgrade intent at the call site.
 * The realistic 0.x schema changes are all additive (new nullable columns,
 * index add/drop, `CREATE OR REPLACE` of the capture function/trigger), so an
 * in-place migration is sufficient and lossless.
 */
export async function migrate(
  pool: Pool, options?: InstallOptions,
): Promise<InstallResult> {
  return install(pool, options);
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

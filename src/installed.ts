import type { QueryResult, QueryResultRow } from 'pg';
import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';

/**
 * Is this error Postgres `undefined_table` (SQLSTATE `42P01`) — i.e. a read
 * against `pgbossier.record` before `install()`/`migrate()` has run? node-postgres
 * preserves `.code` (and it survives the `boss.getDb()` pass-through on the
 * pg-backed path). The message fallback catches adapters that drop `.code` but
 * keep the original text. An ORM adapter that wraps the error in an opaque shape
 * may not be recognized — then the read re-throws (best-effort fail-soft).
 */
function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  if (e.code === '42P01') return true;
  return typeof e.message === 'string' && /relation .* does not exist/i.test(e.message);
}

// Warn at most once per process so a hot path (e.g. getClaim on an auth route)
// against a missing install doesn't flood the log.
let warned = false;

/**
 * Wrap a {@link BossierDb} so reads degrade **fail-soft** (#40): if a query
 * throws `undefined_table` (pg-bossier not installed yet), resolve to an empty
 * result set instead of letting a raw `relation "pgbossier.record" does not exist`
 * reach the host's request path. Every read method already maps an empty result
 * to its own empty value (`null` / `[]` / zero-filled / `{ rows: [], total: 0 }`),
 * so no per-method change is needed. Symmetric with the fail-open writes.
 *
 * Any **other** error re-throws — a schema-name typo or a real DB fault must not
 * be masked as "no data". Used only for the client's *read* methods; the write
 * methods keep the raw `db` (they have their own fail-open try/catch).
 */
export function softReadDb(db: BossierDb): BossierDb {
  return {
    query: async <R extends QueryResultRow = QueryResultRow>(
      text: string, params?: unknown[],
    ): Promise<QueryResult<R>> => {
      try {
        return await db.query<R>(text, params);
      } catch (err) {
        if (!isUndefinedTable(err)) throw err;
        if (!warned) {
          warned = true;
          console.warn(
            'pgbossier: a read returned empty because the pgbossier schema is not ' +
            'installed — run install()/migrate() or construct bossier({ autoMigrate: true }). ' +
            '(warns once)',
          );
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as unknown as QueryResult<R>;
      }
    },
  };
}

/**
 * True if `pgbossier.record` exists (#40) — a cheap `to_regclass` probe a host can
 * call at startup to fail loudly/clearly instead of cryptically at first read.
 * `false` when the schema/table is absent (not yet installed). Does NOT itself
 * fail-soft: a genuine DB error propagates (you asked an explicit question).
 *
 * Named `isBossierInstalled` (not `isInstalled`) so it never shadows pg-boss's
 * own `isInstalled()` on the facade — both stay reachable through the client.
 */
export async function isBossierInstalled(
  db: BossierDb, schemas: SchemaNames,
): Promise<boolean> {
  const { rows } = await db.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${schemas.pgbossier}.record`],
  );
  return rows[0]?.present ?? false;
}

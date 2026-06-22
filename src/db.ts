import type { PgBoss } from 'pg-boss';
import type { QueryResult, QueryResultRow } from 'pg';

/**
 * The minimal database surface pg-bossier's read/write methods need: a single
 * parameterized `query`. Deliberately a strict subset of pg's own `Pool` /
 * `PoolClient` `query` shape, so a `pg.Pool` satisfies it structurally with no
 * wrapper — and so pg-boss's own DB handle (`boss.getDb()`, an `IDatabase`
 * exposing `executeSql`) can back it via {@link pgBossDb}.
 *
 * This is what makes pg-bossier "bring-your-own connection": its reads/writes
 * run through whatever DB access pg-boss is already configured with (a raw
 * pool, or a Prisma/Knex/Kysely/Drizzle adapter via pg-boss's `db` option), so
 * a consumer never has to hand pg-bossier a separate `pg.Pool` just for it.
 *
 * NOT sufficient for LISTEN/NOTIFY events or the transactional installer — both
 * need a dedicated connection (`pool.connect()`), which an ORM adapter does not
 * expose. Those paths keep taking a real `Pool`.
 */
export interface BossierDb {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string, params?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Back a {@link BossierDb} with a started pg-boss instance's own DB handle
 * (`boss.getDb().executeSql`). `getDb()` is resolved lazily per query so the
 * boss only needs to be started by the time a read/write actually runs.
 */
export function pgBossDb(boss: PgBoss): BossierDb {
  return {
    query: <R extends QueryResultRow = QueryResultRow>(
      text: string, params?: unknown[],
    ): Promise<QueryResult<R>> =>
      boss.getDb().executeSql(text, params) as Promise<QueryResult<R>>,
  };
}

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

/** Postgres SQLSTATE for a detected deadlock. */
const DEADLOCK = '40P01';
/** Deadlock retry attempts (#47) — a transient deadlock converges in 1-2. */
const DEADLOCK_MAX_ATTEMPTS = 5;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True if `err` is a Postgres deadlock (SQLSTATE 40P01). */
export function isDeadlock(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DEADLOCK;
}

/**
 * Run `fn`, retrying on a Postgres deadlock (40P01) with a short randomized
 * backoff (#47). A pg-bossier statement that needs a heavy lock on `pgboss.job`
 * (the install/migrate trigger DDL) or contends with the live capture trigger on
 * `pgbossier.record` (`prune`) can hit a transient deadlock against a running
 * pg-boss — these almost always clear on a retry.
 *
 * `fn` MUST be safely re-runnable: either it owns no transaction (a single
 * autocommit statement, e.g. prune's DELETE) or it rolls back its own
 * transaction before it rejects (install's BEGIN/COMMIT block ROLLBACKs in its
 * catch). Any non-deadlock error, or exhausting `maxAttempts`, re-throws.
 */
export async function withDeadlockRetry<T>(
  fn: () => Promise<T>, maxAttempts = DEADLOCK_MAX_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= maxAttempts) throw err;
      await sleep(25 * attempt + Math.floor(Math.random() * 50)); // backoff + jitter
    }
  }
}

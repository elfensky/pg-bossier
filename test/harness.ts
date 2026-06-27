import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { inject } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import pg from 'pg';

export interface Harness {
  pool: pg.Pool;
  boss: PgBoss;
  /**
   * The Postgres connection string used to create both `pool` and `boss`.
   * Exposed so perf globalSetup can hand it to bench files via vitest's
   * `provide()` (live `pool` / `boss` aren't serializable across workers).
   */
  connectionString: string;
  teardown: () => Promise<void>;
}

// postgres:18-alpine — ~80MB vs ~140MB, a faster pull + slightly faster boot
// than the standard image (#24). pg-boss is well-tested on alpine.
const IMAGE = 'postgres:18-alpine';

/**
 * Connect a fresh pg-boss + pool to a connection string, with the maintenance
 * and cron loops OFF (`supervise`/`schedule: false`) — otherwise they insert
 * jobs mid-test, the capture trigger mirrors them, and `count(*)` assertions
 * flake.
 */
async function connectHarness(
  connectionString: string, extraTeardown: () => Promise<void>,
): Promise<Harness> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
  await boss.start(); // creates the pgboss schema and tables
  const pool = new pg.Pool({ connectionString });
  return {
    pool, boss, connectionString,
    teardown: async () => {
      await pool.end();
      await boss.stop();
      await extraTeardown();
    },
  };
}

/**
 * The default harness for the integration suite (#16). ONE Postgres container is
 * booted once by `test/global-setup.ts` and shared across all worker processes;
 * each call here creates a **fresh database** inside it and connects a pg-boss +
 * pool to that database. Isolation is per-database (default schema names, so test
 * SQL stays unchanged), and the container boot — the slow part — happens once for
 * the whole run instead of once per file. The DB is left for the container's
 * global teardown to drop wholesale (cheaper than per-file DROP DATABASE, which
 * needs all connections closed first).
 */
export async function startHarness(): Promise<Harness> {
  const sharedUrl = inject('pgSharedUrl'); // provided by test/global-setup.ts
  const dbName = `b${randomUUID().replace(/-/g, '')}`; // valid identifier, globally unique
  const admin = new pg.Client({ connectionString: sharedUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(sharedUrl);
  url.pathname = `/${dbName}`;
  // pool.end()/boss.stop() release this DB's connections on teardown; the
  // database itself is dropped wholesale when global-setup stops the container.
  return connectHarness(url.toString(), async () => { /* no per-db drop */ });
}

/**
 * Boot a **dedicated** throwaway container for one harness (no shared
 * container). Used by the perf bench's own globalSetup, which boots and owns its
 * container directly rather than going through the shared one.
 */
export async function startContainerHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(IMAGE).start();
  return connectHarness(container.getConnectionUri(), async () => { await container.stop(); });
}

export interface RecordRow {
  job_id: string;
  queue: string;
  attempt: number;
  state: string;
  data: unknown;
  output: unknown;
  progress: unknown;
  terminal_detail: unknown;
  input_snapshot: unknown;
  priority: number | null;
  retry_limit: number | null;
  singleton_key: string | null;
  claimed_by: string | null;
  created_on: Date | null;
  started_on: Date | null;
  completed_on: Date | null;
  captured_at: Date;
  seq: string;
}

export async function getRecords(pool: pg.Pool, jobId: string): Promise<RecordRow[]> {
  const { rows } = await pool.query<RecordRow>(
    `SELECT * FROM pgbossier.record WHERE job_id = $1 ORDER BY attempt`,
    [jobId],
  );
  return rows;
}

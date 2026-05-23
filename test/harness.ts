import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

export async function startHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:18').start();
  const connectionString = container.getConnectionUri();
  // supervise/schedule off: otherwise pg-boss's maintenance and cron loops insert
  // jobs mid-test, the capture trigger mirrors them, and count(*) assertions flake.
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false });
  await boss.start(); // creates the pgboss schema and tables
  const pool = new pg.Pool({ connectionString });
  return {
    pool,
    boss,
    connectionString,
    teardown: async () => {
      await pool.end();
      await boss.stop();
      await container.stop();
    },
  };
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

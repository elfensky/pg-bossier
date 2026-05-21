import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PgBoss } from 'pg-boss';
import pg from 'pg';

export interface Harness {
  pool: pg.Pool;
  boss: PgBoss;
  teardown: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16').start();
  const connectionString = container.getConnectionUri();
  const boss = new PgBoss(connectionString);
  await boss.start(); // creates the pgboss schema and tables
  const pool = new pg.Pool({ connectionString });
  return {
    pool,
    boss,
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
}

export async function getRecords(pool: pg.Pool, jobId: string): Promise<RecordRow[]> {
  const { rows } = await pool.query<RecordRow>(
    `SELECT * FROM pgbossier.record WHERE job_id = $1 ORDER BY attempt`,
    [jobId],
  );
  return rows;
}

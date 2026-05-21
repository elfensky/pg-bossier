import type { Pool } from 'pg';

export type JobState =
  | 'created' | 'active' | 'retry' | 'completed' | 'cancelled' | 'failed';

interface RecordShared<TInput> {
  jobId: string;
  queue: string;
  attempt: number;
  data: TInput | null;
  progress: unknown;
  inputSnapshot: unknown;
  createdOn: Date | null;
  startedOn: Date | null;
  completedOn: Date | null;
  capturedAt: Date;
}

/** One attempt's row. Discriminated on `state` — `output` differs per state. */
export type JobRecord<TInput = unknown, TOutput = unknown> =
  | (RecordShared<TInput> & { state: 'created' | 'active'; output: null;           terminalDetail: null })
  | (RecordShared<TInput> & { state: 'retry' | 'failed';   output: unknown;        terminalDetail: unknown })
  | (RecordShared<TInput> & { state: 'completed';          output: TOutput | null; terminalDetail: unknown })
  | (RecordShared<TInput> & { state: 'cancelled';          output: unknown;        terminalDetail: unknown });

export interface JobFilter {
  queue?: string;
  queues?: string[];
  states?: JobState[];
  createdAfter?: Date;
  createdBefore?: Date;
  completedAfter?: Date;
  completedBefore?: Date;
}

export interface ListJobsOpts extends JobFilter {
  orderBy?: 'createdOn' | 'completedOn' | 'capturedAt';
  limit?: number;
  offset?: number;
}

interface RawRecordRow {
  job_id: string;
  queue: string;
  attempt: number;
  state: JobState;
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a raw snake_case DB row to a camelCase `JobRecord`. The single `as` cast
 * is the controlled DB boundary: the state-to-output correlation is a runtime
 * invariant TypeScript cannot verify.
 */
function mapRecord<TInput = unknown, TOutput = unknown>(
  r: RawRecordRow,
): JobRecord<TInput, TOutput> {
  return {
    jobId: r.job_id,
    queue: r.queue,
    attempt: r.attempt,
    state: r.state,
    data: r.data,
    output: r.output,
    progress: r.progress,
    terminalDetail: r.terminal_detail,
    inputSnapshot: r.input_snapshot,
    createdOn: r.created_on,
    startedOn: r.started_on,
    completedOn: r.completed_on,
    capturedAt: r.captured_at,
  } as JobRecord<TInput, TOutput>;
}

/** A job's latest attempt, across all queues. `null` if never captured. */
export async function findById<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  jobId: string,
): Promise<JobRecord<TInput, TOutput> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM pgbossier.record
     WHERE job_id = $1
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  return rows[0] ? mapRecord<TInput, TOutput>(rows[0]) : null;
}

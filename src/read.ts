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

/** Every attempt of a job, oldest first. `[]` if unknown. */
export async function getRetryHistory<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  jobId: string,
): Promise<JobRecord<TInput, TOutput>[]> {
  if (!UUID_RE.test(jobId)) return [];
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM pgbossier.record
     WHERE job_id = $1
     ORDER BY attempt ASC`,
    [jobId],
  );
  return rows.map((r) => mapRecord<TInput, TOutput>(r));
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** `WITH` body: the latest-attempt row of every job. */
const RECORD_CURRENT = `
  current AS (
    SELECT DISTINCT ON (job_id) *
    FROM pgbossier.record
    ORDER BY job_id, attempt DESC
  )`;

const ORDER_COLUMNS = {
  createdOn: 'created_on',
  completedOn: 'completed_on',
  capturedAt: 'captured_at',
} as const;

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit must be a positive integer, got ${String(limit)}`);
  }
  return Math.min(limit, MAX_LIMIT);
}

function resolveOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got ${String(offset)}`);
  }
  return offset;
}

/** Turn a JobFilter into a parameterized WHERE clause. Params start at $1. */
function buildWhere(filter: JobFilter): { clause: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const next = (): string => `$${params.length + 1}`;

  if (filter.queue !== undefined) {
    conds.push(`queue = ${next()}`);
    params.push(filter.queue);
  } else if (filter.queues !== undefined) {
    conds.push(`queue = ANY(${next()})`);
    params.push(filter.queues);
  }
  if (filter.states !== undefined) {
    conds.push(`state = ANY(${next()})`);
    params.push(filter.states);
  }
  if (filter.createdAfter !== undefined) {
    conds.push(`created_on >= ${next()}`);
    params.push(filter.createdAfter);
  }
  if (filter.createdBefore !== undefined) {
    conds.push(`created_on < ${next()}`);
    params.push(filter.createdBefore);
  }
  if (filter.completedAfter !== undefined) {
    conds.push(`completed_on >= ${next()}`);
    params.push(filter.completedAfter);
  }
  if (filter.completedBefore !== undefined) {
    conds.push(`completed_on < ${next()}`);
    params.push(filter.completedBefore);
  }
  return { clause: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

/** Filtered, paginated job list over the current view, with an exact total. */
export async function listJobs<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  opts: ListJobsOpts = {},
): Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }> {
  const limit = resolveLimit(opts.limit);
  const offset = resolveOffset(opts.offset);
  const orderCol = ORDER_COLUMNS[opts.orderBy ?? 'createdOn'];
  const { clause, params } = buildWhere(opts);
  const { rows } = await pool.query<RawRecordRow & { total_count: string }>(
    `WITH ${RECORD_CURRENT}
     SELECT *, count(*) OVER () AS total_count
     FROM current
     ${clause}
     ORDER BY ${orderCol} DESC NULLS LAST, job_id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
  return { rows: rows.map((r) => mapRecord<TInput, TOutput>(r)), total };
}

import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import type {
  TerminalDetailCancelled,
  TerminalDetailCompleted,
  TerminalDetailFailed,
} from './terminal-detail.js';

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
  seq: bigint;
}

/**
 * One attempt's row. Discriminated on `state` — both `output` and
 * `terminalDetail` differ per state. The `terminalDetail` branches are written
 * only by `recordTerminalDetail` (see `src/terminal-detail.ts`); the cast in
 * `mapRecord` trusts that single-writer convention.
 *
 * `state: 'retry'` carries `TerminalDetailFailed | null`: the worker may write
 * detail against an attempt that is then DELETE+INSERTed by pg-boss as the
 * next attempt, leaving the prior attempt's chronicle row in `state='retry'`
 * with the failure detail attached.
 */
export type JobRecord<TInput = unknown, TOutput = unknown> =
  | (RecordShared<TInput> & { state: 'created' | 'active'; output: null;           terminalDetail: null })
  | (RecordShared<TInput> & { state: 'retry' | 'failed';   output: unknown;        terminalDetail: TerminalDetailFailed | null })
  | (RecordShared<TInput> & { state: 'completed';          output: TOutput | null; terminalDetail: TerminalDetailCompleted | null })
  | (RecordShared<TInput> & { state: 'cancelled';          output: unknown;        terminalDetail: TerminalDetailCancelled | null });

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
  seq: string;
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
    seq: BigInt(r.seq),
  } as JobRecord<TInput, TOutput>;
}

/** A job's latest attempt, across all queues. `null` if never captured. */
export async function findById<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
): Promise<JobRecord<TInput, TOutput> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM ${schemas.pgbossier}.record
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
  schemas: SchemaNames,
  jobId: string,
): Promise<JobRecord<TInput, TOutput>[]> {
  if (!UUID_RE.test(jobId)) return [];
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM ${schemas.pgbossier}.record
     WHERE job_id = $1
     ORDER BY attempt ASC`,
    [jobId],
  );
  return rows.map((r) => mapRecord<TInput, TOutput>(r));
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** `WITH` body: the latest-attempt row of every job. */
function recordCurrent(schemas: SchemaNames): string {
  return `
  current AS (
    SELECT DISTINCT ON (job_id) *
    FROM ${schemas.pgbossier}.record
    ORDER BY job_id, attempt DESC
  )`;
}

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
  if (filter.queue !== undefined && filter.queues !== undefined) {
    throw new Error('JobFilter: set either `queue` or `queues`, not both');
  }
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

/** The single most-recently-created job in each queue, at its current state. */
export async function latestPerQueue(
  pool: Pool,
  schemas: SchemaNames,
  queues: string[],
  opts: { states?: JobState[] } = {},
): Promise<JobRecord[]> {
  if (queues.length === 0) return [];
  const params: unknown[] = [queues];
  let stateClause = '';
  if (opts.states !== undefined) {
    params.push(opts.states);
    stateClause = `AND state = ANY($${params.length})`;
  }
  const { rows } = await pool.query<RawRecordRow>(
    `WITH ${recordCurrent(schemas)}
     SELECT DISTINCT ON (queue) *
     FROM current
     WHERE queue = ANY($1) ${stateClause}
     ORDER BY queue, created_on DESC NULLS LAST, job_id`,
    params,
  );
  return rows.map((r) => mapRecord(r));
}

const ALL_STATES: readonly JobState[] = [
  'created', 'active', 'retry', 'completed', 'cancelled', 'failed',
];

/** Job counts by current state. Zero-fills all six states. */
export async function countByState(
  pool: Pool,
  schemas: SchemaNames,
  filter: JobFilter = {},
): Promise<Record<JobState, number>> {
  const { clause, params } = buildWhere(filter);
  const { rows } = await pool.query<{ state: JobState; count: number }>(
    `WITH ${recordCurrent(schemas)}
     SELECT state, count(*)::int AS count
     FROM current
     ${clause}
     GROUP BY state`,
    params,
  );
  const result = Object.fromEntries(
    ALL_STATES.map((s) => [s, 0]),
  ) as Record<JobState, number>;
  for (const row of rows) result[row.state] = row.count;
  return result;
}

/** Job counts by queue. */
export async function countByQueue(
  pool: Pool,
  schemas: SchemaNames,
  filter: JobFilter = {},
): Promise<Record<string, number>> {
  const { clause, params } = buildWhere(filter);
  const { rows } = await pool.query<{ queue: string; count: number }>(
    `WITH ${recordCurrent(schemas)}
     SELECT queue, count(*)::int AS count
     FROM current
     ${clause}
     GROUP BY queue`,
    params,
  );
  const result: Record<string, number> = {};
  for (const row of rows) result[row.queue] = row.count;
  return result;
}

const DEFAULT_LONG_RUNNING_SECONDS = 900;

/**
 * Active jobs whose started_on is older than a threshold (default 900s).
 *
 * Queries `pgbossier.record` directly — not the RECORD_CURRENT latest-attempt
 * view the other readers use — so the `record_active_idx` partial index serves
 * it. This is correct because pg-boss moves a failed-with-retries job to
 * `retry` before its next attempt, so a superseded attempt is never frozen at
 * `state = 'active'`; the retried-job test in `read.test.ts` pins that invariant.
 */
export async function listLongRunning(
  pool: Pool,
  schemas: SchemaNames,
  opts: { queue?: string; longerThanSeconds?: number; limit?: number } = {},
): Promise<JobRecord[]> {
  const limit = resolveLimit(opts.limit);
  const seconds = opts.longerThanSeconds ?? DEFAULT_LONG_RUNNING_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `longerThanSeconds must be a non-negative number, got ${String(seconds)}`,
    );
  }
  const params: unknown[] = [seconds];
  let queueClause = '';
  if (opts.queue !== undefined) {
    params.push(opts.queue);
    queueClause = `AND queue = $${params.length}`;
  }
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT * FROM ${schemas.pgbossier}.record
     WHERE state = 'active' ${queueClause}
       AND started_on < now() - make_interval(secs => $1)
     ORDER BY started_on ASC, job_id
     LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  return rows.map((r) => mapRecord(r));
}

export interface GetEventsSinceOpts {
  /** Cap the returned slice. Default: 1000. */
  limit?: number;
}

/**
 * Read rows from `pgbossier.record` whose `seq` is strictly greater than
 * `since`, ordered ascending by `seq`. Pairs with the `seq` value carried
 * in lifecycle event payloads.
 *
 * IMPORTANT: the audit table is a current-state table (one row per
 * `(job_id, attempt)`, upserted in place). So this returns the **latest
 * state** of every attempt whose row was touched after the cursor —
 * NOT the full transition sequence within an attempt.
 */
export async function getEventsSince<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  since: bigint,
  opts: GetEventsSinceOpts = {},
): Promise<JobRecord<TInput, TOutput>[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT job_id, queue, attempt, state, data, output, progress,
            terminal_detail, input_snapshot,
            created_on, started_on, completed_on, captured_at, seq
       FROM ${schemas.pgbossier}.record
      WHERE seq > $1
      ORDER BY seq ASC
      LIMIT $2`,
    [since.toString(), limit],
  );
  return rows.map(mapRecord<TInput, TOutput>);
}

/** Filtered, paginated job list over the current view, with an exact total. */
export async function listJobs<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  opts: ListJobsOpts = {},
): Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }> {
  const limit = resolveLimit(opts.limit);
  const offset = resolveOffset(opts.offset);
  // `?? createdOn` guards a JS caller that bypasses the `orderBy` type:
  // an unmapped value would otherwise interpolate `ORDER BY undefined`.
  const orderCol = ORDER_COLUMNS[opts.orderBy ?? 'createdOn'] ?? ORDER_COLUMNS.createdOn;
  const { clause, params } = buildWhere(opts);
  const { rows } = await pool.query<RawRecordRow & { total_count: string }>(
    `WITH ${recordCurrent(schemas)}
     SELECT *, count(*) OVER () AS total_count
     FROM current
     ${clause}
     ORDER BY ${orderCol} DESC NULLS LAST, job_id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  let total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
  if (rows.length === 0 && offset > 0) {
    // `count(*) OVER ()` only rides along on returned rows; an offset past
    // the end yields none, so count separately to keep `total` exact.
    const counted = await pool.query<{ count: number }>(
      `WITH ${recordCurrent(schemas)}
       SELECT count(*)::int AS count
       FROM current
       ${clause}`,
      params,
    );
    total = counted.rows[0]?.count ?? 0;
  }
  return { rows: rows.map((r) => mapRecord<TInput, TOutput>(r)), total };
}

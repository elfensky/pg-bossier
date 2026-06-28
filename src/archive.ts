import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';
import { mapRecord, type JobRecord, type JobState, type RawRecordRow } from './read.js';

/**
 * Which chronicle rows to export. All bounds are `< ` (strictly before), so the
 * typical archive call is `{ completedBefore: cutoff }`. Omit everything to
 * export the whole table.
 */
export interface ExportFilter {
  queue?: string;
  queues?: string[];
  states?: JobState[];
  createdBefore?: Date;
  completedBefore?: Date;
  capturedBefore?: Date;
}

export interface ExportOptions {
  /** Rows per yielded batch. Default 1000. */
  batchSize?: number;
}

const DEFAULT_BATCH = 1000;

/**
 * Stream chronicle rows out for archiving (#46) — the export half of tiered
 * retention (pairs with {@link prune}). An **async generator** that yields
 * batches of `JobRecord`, keyset-paginated by the monotonic `seq` (an index
 * range scan — stable across a long export even as new rows arrive). The
 * consumer serializes each batch to wherever it wants (file / S3 / another DB);
 * pg-bossier owns no storage destination or format.
 *
 * Round-trip: `JobRecord.seq` is a `bigint` and timestamps are `Date`, so plain
 * `JSON.stringify` will throw on `seq` — convert it (`String(r.seq)`) before
 * serializing. {@link importRecords} accepts `seq` back as a string or number.
 *
 * Reads only; safe to run during normal operation (a read-only `SELECT`).
 */
export async function* exportRecords<TInput = unknown, TOutput = unknown>(
  db: BossierDb,
  schemas: SchemaNames,
  filter: ExportFilter = {},
  opts: ExportOptions = {},
): AsyncGenerator<JobRecord<TInput, TOutput>[]> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`pg-bossier: exportRecords batchSize must be a positive integer, got ${String(batchSize)}`);
  }
  if (filter.queue !== undefined && filter.queues !== undefined) {
    throw new Error('pg-bossier: exportRecords: set either `queue` or `queues`, not both');
  }

  let afterSeq = 0n; // keyset cursor: seq > afterSeq
  for (;;) {
    const params: unknown[] = [afterSeq.toString()];
    const conds = ['seq > $1'];
    const push = (val: unknown): string => { params.push(val); return `$${params.length}`; };
    if (filter.queue !== undefined) conds.push(`queue = ${push(filter.queue)}`);
    if (filter.queues !== undefined) conds.push(`queue = ANY(${push(filter.queues)})`);
    if (filter.states !== undefined) conds.push(`state = ANY(${push(filter.states)})`);
    if (filter.createdBefore !== undefined) conds.push(`created_on < ${push(filter.createdBefore)}`);
    if (filter.completedBefore !== undefined) conds.push(`completed_on < ${push(filter.completedBefore)}`);
    if (filter.capturedBefore !== undefined) conds.push(`captured_at < ${push(filter.capturedBefore)}`);
    const where = conds.join(' AND ');
    const limit = push(batchSize);

    const { rows } = await db.query<RawRecordRow>(
      `SELECT * FROM ${schemas.pgbossier}.record
        WHERE ${where}
        ORDER BY seq ASC
        LIMIT ${limit}`,
      params,
    );
    if (rows.length === 0) return;
    yield rows.map((r) => mapRecord<TInput, TOutput>(r));
    afterSeq = BigInt(rows[rows.length - 1]!.seq);
    if (rows.length < batchSize) return;
  }
}

/** Result of {@link importRecords}. */
export interface ImportResult {
  /** Rows inserted. Rows whose `(job_id, attempt)` already exists are skipped (not counted). */
  imported: number;
}

/**
 * Re-insert previously-exported chronicle rows (#46) — the import half of tiered
 * retention, for reconstructing history during an audit/incident. Idempotent and
 * non-clobbering: `ON CONFLICT (job_id, attempt) DO NOTHING`, so re-importing is
 * safe and a re-imported row never overwrites a live/newer one. Preserves each
 * row's original `seq` (and timestamps) — re-imported historical rows carry old,
 * low `seq`s, below any live `getEventsSince` cursor, so they don't replay to
 * live event consumers.
 *
 * Accepts the `JobRecord` shape {@link exportRecords} yields; `seq` may be a
 * `bigint`, a string, or a number (eased for the JSON round-trip). One bulk
 * `INSERT` via `jsonb_to_recordset`. Not fail-open — an explicit maintenance
 * call, so DB errors propagate. Returns the number of rows inserted.
 */
export async function importRecords(
  db: BossierDb,
  schemas: SchemaNames,
  records: readonly JobRecord[],
): Promise<ImportResult> {
  if (records.length === 0) return { imported: 0 };

  const payload = records.map((r) => ({
    job_id: r.jobId,
    queue: r.queue,
    attempt: r.attempt,
    state: r.state,
    data: r.data,
    output: r.output,
    progress: r.progress,
    terminal_detail: r.terminalDetail,
    input_snapshot: r.inputSnapshot,
    priority: r.priority,
    retry_limit: r.retryLimit,
    singleton_key: r.singletonKey,
    claimed_by: r.claimedBy,
    created_on: r.createdOn,
    started_on: r.startedOn,
    completed_on: r.completedOn,
    captured_at: r.capturedAt,
    seq: String(r.seq), // bigint → text; jsonb_to_recordset casts back to bigint
  }));

  const { rows } = await db.query<{ job_id: string }>(
    `INSERT INTO ${schemas.pgbossier}.record
       (job_id, queue, attempt, state, data, output, progress, terminal_detail,
        input_snapshot, priority, retry_limit, singleton_key, claimed_by,
        created_on, started_on, completed_on, captured_at, seq)
     SELECT job_id, queue, attempt, state, data, output, progress, terminal_detail,
            input_snapshot, priority, retry_limit, singleton_key, claimed_by,
            created_on, started_on, completed_on, captured_at, seq
       FROM jsonb_to_recordset($1::jsonb) AS x(
         job_id uuid, queue text, attempt int, state text, data jsonb, output jsonb,
         progress jsonb, terminal_detail jsonb, input_snapshot jsonb, priority int,
         retry_limit int, singleton_key text, claimed_by text,
         created_on timestamptz, started_on timestamptz, completed_on timestamptz,
         captured_at timestamptz, seq bigint)
     ON CONFLICT (job_id, attempt) DO NOTHING
     RETURNING job_id`,
    [JSON.stringify(payload)],
  );
  return { imported: rows.length };
}

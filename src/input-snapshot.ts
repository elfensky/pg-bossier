import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A job's input snapshot read without an explicit attempt: the most-recent
 *  non-null snapshot and its source attempt. Mirrors `ProgressResult` shape. */
export interface InputSnapshotResult<T = unknown> {
  /** The most-recent non-null `input_snapshot` value for the job. */
  snapshot: T;
  /** The attempt number that snapshot was written on. */
  attempt: number;
}

/**
 * Write a job's input snapshot to a specific `(jobId, attempt)` row in
 * `pgbossier.record`. Sibling writer to `recordPatch({input_snapshot})` with
 * the same JSON acceptance/error behavior — both route through
 * `stringifyOrThrow`. Prefer this method for the worker-recording-what-it-saw
 * use case; `recordPatch` remains the multi-column escape hatch.
 *
 * `attempt` is **required and not server-resolved** by design. Input snapshots
 * are "this exact attempt observed this exact input"; resolving `max(attempt)`
 * could misattribute the snapshot to a newer attempt if the call lands after
 * pg-boss's retry DELETE+INSERT. Workers receive `job.retryCount` on the job
 * object — pass it explicitly.
 *
 * Fail-open per issue #1's audit-write constraint: a runtime DB error, or an
 * UPDATE matching no row, is logged via `console.warn` and swallowed — a
 * failed snapshot write must never fail the consumer's job. The *only* throw
 * path is argument validation (programmer error): `snapshot` must not be
 * `null` / `undefined` and must be JSON-serializable.
 *
 * Note: non-finite numbers (`NaN`, `Infinity`) inside `snapshot` marshal to
 * JSON `null` via `JSON.stringify` — standard JS behavior, not a pg-bossier
 * one. They are stored as the JSON null literal, so `getInputSnapshot` will
 * return the nulled field rather than the number the caller passed.
 */
export async function recordInputSnapshot(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt: number,
  snapshot: unknown,
): Promise<void> {
  if (snapshot === undefined) {
    throw new Error(
      'pg-bossier: input_snapshot validation: snapshot must not be undefined',
    );
  }
  if (snapshot === null) {
    throw new Error(
      'pg-bossier: input_snapshot validation: snapshot must not be null',
    );
  }
  const json = stringifyOrThrow(snapshot, 'input_snapshot');
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schemas.pgbossier}.record
          SET input_snapshot = $3::jsonb
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, attempt, json],
    );
    if (rowCount === 0) {
      console.warn(
        `pgbossier: recordInputSnapshot no row for job ${jobId} attempt ${String(attempt)} — reason: not_found`,
      );
    }
  } catch (err) {
    console.warn(
      `pgbossier: recordInputSnapshot failed for job ${jobId} attempt ${String(attempt)}: ${String(err)} — reason: db_error`,
    );
  }
}

/**
 * Read a job's input snapshot.
 *
 * Dual-mode:
 *  - When `attempt` is provided, returns the snapshot stored on that exact
 *    `(jobId, attempt)` row as `T | null`. `null` if no row matches or the
 *    column is SQL NULL.
 *  - When `attempt` is omitted, returns the most-recent non-null snapshot as
 *    `{snapshot: T, attempt: number} | null`. `null` if no attempt ever wrote
 *    a snapshot. Mirrors `getProgress`'s `ProgressResult` shape.
 *
 * A malformed (non-UUID) `jobId` short-circuits to `null` without a query
 * (matches `src/progress.ts`'s pattern).
 */
export async function getInputSnapshot<T = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number,
): Promise<T | null>;
export async function getInputSnapshot<T = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string,
): Promise<InputSnapshotResult<T> | null>;
export async function getInputSnapshot<T = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
  attempt?: number,
): Promise<T | InputSnapshotResult<T> | null> {
  if (!UUID_RE.test(jobId)) return null;
  if (attempt !== undefined) {
    const { rows } = await pool.query<{ snapshot: unknown }>(
      `SELECT input_snapshot AS snapshot
         FROM ${schemas.pgbossier}.record
        WHERE job_id = $1 AND attempt = $2
        LIMIT 1`,
      [jobId, attempt],
    );
    const row = rows[0];
    if (!row || row.snapshot === null) return null;
    return row.snapshot as T;
  }
  const { rows } = await pool.query<{ snapshot: unknown; attempt: number }>(
    `SELECT input_snapshot AS snapshot, attempt
       FROM ${schemas.pgbossier}.record
      WHERE job_id = $1 AND input_snapshot IS NOT NULL
      ORDER BY attempt DESC
      LIMIT 1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return { snapshot: row.snapshot as T, attempt: row.attempt };
}

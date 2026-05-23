import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';

/** A job's effective progress: the most-recent non-null value and its source attempt. */
export interface ProgressResult<TProgress = unknown> {
  /** The most-recent non-null progress value across the job's attempts. */
  progress: TProgress;
  /** The attempt number that value was written on. */
  attempt: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Write a job's progress to its *current* attempt's `pgbossier.record` row.
 *
 * The attempt is resolved server-side as `max(attempt)` for the job, so a
 * worker needs only `job.id`. Fail-open per issue #1's audit-write constraint:
 * a runtime error, or an UPDATE matching no row, is logged via `console.warn`
 * and swallowed — a failed progress write must never fail the consumer's job.
 * The *only* throw path is argument validation (a programmer error): `progress`
 * must not be `null` / `undefined` and must be JSON-serializable.
 *
 * Note: non-finite numbers (`NaN`, `Infinity`) marshal to JSON `null` via
 * `JSON.stringify` — a standard JS behavior, not a pg-bossier-specific one.
 * They are stored as the JSON null literal, so `getProgress` will return
 * `{ progress: null, attempt }` rather than the number the caller passed.
 */
export async function setProgress(
  pool: Pool, schemas: SchemaNames, jobId: string, progress: unknown,
): Promise<void> {
  if (progress === undefined || progress === null) {
    throw new Error('setProgress: progress must not be null or undefined');
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(progress);
  } catch (err) {
    throw new Error(
      `setProgress: progress is not JSON-serializable: ${String(err)}`,
    );
  }
  if (json === undefined) {
    // JSON.stringify yields undefined for a function or a symbol.
    throw new Error('setProgress: progress is not JSON-serializable');
  }
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schemas.pgbossier}.record
         SET progress = $2::jsonb
       WHERE job_id = $1
         AND attempt = (
           SELECT max(attempt) FROM ${schemas.pgbossier}.record WHERE job_id = $1
         )`,
      [jobId, json],
    );
    if (rowCount === 0) {
      console.warn(
        `pgbossier: setProgress matched no record for job ${jobId} — ` +
        `is pg-bossier installed?`,
      );
    }
  } catch (err) {
    console.warn(`pgbossier: setProgress failed for job ${jobId}: ${String(err)}`);
  }
}

/**
 * Read a job's effective progress — the most-recent non-null `progress` value
 * across all attempts, plus the attempt it came from. `null` if the job is
 * unknown to pg-bossier or no attempt ever wrote progress. A malformed
 * (non-UUID) `jobId` short-circuits to `null` without a query.
 */
export async function getProgress<TProgress = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string,
): Promise<ProgressResult<TProgress> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<{ progress: unknown; attempt: number }>(
    `SELECT progress, attempt FROM ${schemas.pgbossier}.record
     WHERE job_id = $1 AND progress IS NOT NULL
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  const row = rows[0];
  if (!row) return null;
  return { progress: row.progress as TProgress, attempt: row.attempt };
}

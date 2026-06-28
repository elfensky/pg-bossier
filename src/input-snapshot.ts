import type { BossierDb } from './db.js';
import { UUID_RE, type SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

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
 * `pgbossier.record`. The sole writer that *mutates* `input_snapshot` on an
 * existing row (the archive `importRecords` only inserts new rows, `ON CONFLICT
 * DO NOTHING`, so it never overwrites this slot); serializes via
 * `stringifyOrThrow`.
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
  db: BossierDb,
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
    // RETURNING + rows.length, NOT rowCount: pg-boss's executeSql contract (the
    // BYO/ORM path) guarantees only `{ rows }`, so rowCount is undefined there
    // and the no-row warning would never fire (see claim.ts / prune.ts).
    const { rows } = await db.query(
      `UPDATE ${schemas.pgbossier}.record
          SET input_snapshot = $3::jsonb
        WHERE job_id = $1 AND attempt = $2
        RETURNING job_id`,
      [jobId, attempt, json],
    );
    if (rows.length === 0) {
      console.warn(
        `pg-bossier: recordInputSnapshot no row for job ${jobId} attempt ${String(attempt)} — reason: not_found`,
      );
    }
  } catch (err) {
    console.warn(
      `pg-bossier: recordInputSnapshot failed for job ${jobId} attempt ${String(attempt)}: ${String(err)} — reason: db_error`,
    );
  }
}

/**
 * Read the input snapshot stored on one exact `(jobId, attempt)` row as
 * `T | null` — `null` if no row matches or the column is SQL NULL. Use this
 * when you know which attempt you want; use {@link getLatestInputSnapshot} for
 * "the most recent one, whatever attempt it was".
 *
 * A malformed (non-UUID) `jobId` short-circuits to `null` without a query
 * (matches `src/progress.ts`'s pattern).
 */
export async function getInputSnapshot<T = unknown>(
  db: BossierDb, schemas: SchemaNames, jobId: string, attempt: number,
): Promise<T | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await db.query<{ snapshot: unknown }>(
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

/**
 * Read a job's most-recent non-null input snapshot as
 * `{snapshot: T, attempt: number} | null` — `null` if no attempt ever wrote a
 * snapshot. The `attempt` field tells you which attempt it came from. Mirrors
 * `getProgress`'s `ProgressResult` shape. Use {@link getInputSnapshot} when you
 * want a specific attempt instead.
 *
 * A malformed (non-UUID) `jobId` short-circuits to `null` without a query.
 */
export async function getLatestInputSnapshot<T = unknown>(
  db: BossierDb, schemas: SchemaNames, jobId: string,
): Promise<InputSnapshotResult<T> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await db.query<{ snapshot: unknown; attempt: number }>(
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

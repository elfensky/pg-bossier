import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';

/** Bounds for {@link prune}. At least one is required. */
export interface PruneOptions {
  /**
   * Delete fully-done jobs whose completion time (`completed_on`, else
   * `captured_at`) is strictly **before** this instant.
   */
  olderThan?: Date;
  /**
   * Within each queue, **keep** the `keepLastPerQueue` most-recently-completed
   * done jobs; older done jobs become eligible. `0` keeps none.
   */
  keepLastPerQueue?: number;
}

/**
 * A supported retention **primitive** (#42) — delete chronicle rows the consumer
 * no longer wants, so the durability table doesn't grow without bound. The
 * retention *policy* (when/whether to call this) stays entirely consumer-owned;
 * pg-bossier provides only the safe operation, so a host never hand-writes a
 * `DELETE` against the internal schema.
 *
 * **Safety invariants (all enforced in SQL):**
 *  - Only deletes rows of **fully-done** jobs — a job whose *current* (latest)
 *    attempt is terminal (`completed` / `failed` / `cancelled`). A job that is
 *    still in-flight (current attempt `active` / `retry` / `created`) is **never
 *    touched** — all its rows (claim, progress, every attempt) are protected.
 *  - For an eligible done job it deletes **all** its attempt rows (the job's
 *    whole history) — a done job's accumulated rows are exactly what grows the
 *    table. (Note this differs from the issue's literal "only terminal rows":
 *    that would orphan a retried job's non-terminal `retry` rows and never bound
 *    growth. Pruning a done job wholesale is the coherent, growth-bounding choice.)
 *  - **At least one bound is required** — a no-arg call throws rather than wipe
 *    the chronicle. With both bounds, a job must violate **both** (older than the
 *    cutoff **and** beyond the per-queue keep-count) to be deleted — the
 *    conservative intersection.
 *
 * Not fail-open: this is an explicit maintenance call (off the capture hot path),
 * so a DB error propagates to the caller. Validation errors (no bound / bad
 * `keepLastPerQueue`) throw. Runs one parameterized statement through the
 * existing `db` handle — no separate connection, BYO-connection friendly.
 * Returns the number of rows deleted.
 */
export async function prune(
  db: BossierDb, schemas: SchemaNames, opts: PruneOptions = {},
): Promise<{ deleted: number }> {
  const { olderThan, keepLastPerQueue } = opts;
  if (olderThan === undefined && keepLastPerQueue === undefined) {
    throw new Error(
      'pg-bossier: prune requires at least one bound (olderThan or keepLastPerQueue) — ' +
      'refusing to delete the entire chronicle',
    );
  }
  if (
    keepLastPerQueue !== undefined &&
    (!Number.isInteger(keepLastPerQueue) || keepLastPerQueue < 0)
  ) {
    throw new Error(
      `pg-bossier: prune keepLastPerQueue must be a non-negative integer, got ${String(keepLastPerQueue)}`,
    );
  }

  const params: unknown[] = [];
  const conds: string[] = [];
  if (olderThan !== undefined) {
    params.push(olderThan);
    conds.push(`done_at < $${params.length}`);
  }
  if (keepLastPerQueue !== undefined) {
    params.push(keepLastPerQueue);
    conds.push(`rn > $${params.length}`);
  }
  const eligibleWhere = conds.join(' AND '); // intersection of the given bounds

  const t = `${schemas.pgbossier}.record`;
  const { rowCount } = await db.query(
    `WITH current AS (
       SELECT DISTINCT ON (job_id) job_id, queue, state,
              coalesce(completed_on, captured_at) AS done_at
         FROM ${t}
        ORDER BY job_id, attempt DESC
     ),
     done AS (
       SELECT job_id, done_at,
              row_number() OVER (PARTITION BY queue ORDER BY done_at DESC, job_id) AS rn
         FROM current
        WHERE state IN ('completed', 'failed', 'cancelled')
     )
     DELETE FROM ${t} r
       USING done d
      WHERE r.job_id = d.job_id
        AND ${eligibleWhere}`,
    params,
  );
  return { deleted: rowCount ?? 0 };
}

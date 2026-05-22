import type { Pool } from 'pg';

/** The pg-bossier-owned columns the app-hook may write via `recordPatch`. */
export interface RecordPatch {
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}

/**
 * Update the app-hook-owned columns of a record row, keyed by
 * `(jobId, attempt)`. A plain UPDATE, not an upsert — the capture trigger
 * always creates the row first, so the insert path (and its NOT NULL
 * queue/state columns) is never needed.
 *
 * A wrong `jobId`/`attempt` matches no row: the UPDATE is a silent no-op,
 * not an error. Patch values must be valid `jsonb`. The `progress` column
 * is written by Goal 6's `setProgress` (see `src/progress.ts`), which is its
 * sole write path — `recordPatch` deliberately does not touch it.
 */
export async function recordPatch(
  pool: Pool, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE pgbossier.record SET
       terminal_detail = COALESCE($3, terminal_detail),
       input_snapshot  = COALESCE($4, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [
      jobId, attempt,
      patch.terminal_detail ?? null,
      patch.input_snapshot ?? null,
    ],
  );
}

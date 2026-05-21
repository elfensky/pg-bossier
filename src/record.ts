import type { Pool } from 'pg';

/** The three pg-bossier-owned columns the app-hook may write. */
export interface RecordPatch {
  progress?: unknown;
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
 * not an error. Patch values must be valid `jsonb` — objects, arrays,
 * numbers and booleans round-trip, but a bare JS string is rejected by
 * Postgres; raw-string marshalling belongs to the Goal 6 write-path API.
 */
export async function recordPatch(
  pool: Pool, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE pgbossier.record SET
       progress        = COALESCE($3, progress),
       terminal_detail = COALESCE($4, terminal_detail),
       input_snapshot  = COALESCE($5, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [
      jobId, attempt,
      patch.progress ?? null,
      patch.terminal_detail ?? null,
      patch.input_snapshot ?? null,
    ],
  );
}

import type { Pool } from 'pg';

/** The three pg-bossier-owned columns the app-hook may write. */
export interface RecordPatch {
  progress?: unknown;
  terminal_detail?: unknown;
  input_snapshot?: unknown;
}

/**
 * Update the app-hook-owned columns of a record row. A plain UPDATE, not an
 * upsert: the capture trigger always creates the row first, so the app-hook
 * never needs the insert path — and this avoids the NOT NULL queue/state
 * columns. If no row exists yet, the UPDATE affects zero rows (a no-op).
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

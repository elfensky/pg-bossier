import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';

/** The pg-bossier-owned columns the app-hook may write via `recordPatch`. */
export interface RecordPatch {
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
 * sole write path — `recordPatch` deliberately does not touch it. The
 * `terminal_detail` column is written by Goal 2's `recordTerminalDetail`
 * (see `src/terminal-detail.ts`), which is its sole write path —
 * `recordPatch` deliberately does not touch it.
 */
export async function recordPatch(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record SET
       input_snapshot = COALESCE($3, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [
      jobId, attempt,
      patch.input_snapshot ?? null,
    ],
  );
}

import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';
import { stringifyOrThrow } from './json.js';

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
 *
 * `input_snapshot` semantics:
 *   - Omitted from the patch (`{}` or any patch without the `input_snapshot`
 *     key) → no-op; the column is left unchanged.
 *   - Explicit `null` (`{ input_snapshot: null }`) → clears the column with
 *     SQL `NULL` (not JSON `null`).
 *   - Any other value → serialized via `stringifyOrThrow` and written as
 *     `jsonb`. Same acceptance/error behavior as `recordInputSnapshot`.
 */
export async function recordPatch(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  if (!('input_snapshot' in patch)) return;
  if (patch.input_snapshot === null) {
    await pool.query(
      `UPDATE ${schemas.pgbossier}.record
          SET input_snapshot = NULL
        WHERE job_id = $1 AND attempt = $2`,
      [jobId, attempt],
    );
    return;
  }
  const json = stringifyOrThrow(patch.input_snapshot, 'input_snapshot');
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record
        SET input_snapshot = $3::jsonb
      WHERE job_id = $1 AND attempt = $2`,
    [jobId, attempt, json],
  );
}

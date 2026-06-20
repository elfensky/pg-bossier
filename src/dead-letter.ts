import type { Pool } from 'pg';
import type { SchemaNames } from './sql.js';

/** Arguments for {@link recordDeadLetter}. */
export interface RecordDeadLetterArgs {
  /** Job id of the source job that failed and is being dead-lettered. */
  sourceJobId: string;
  /** Job id of the DLQ job that the consumer just enqueued. */
  dlqJobId: string;
}

/**
 * Record a source → DLQ lineage link on the source job's most-recent `failed`
 * chronicle row. Writes `terminal_detail.deadLetteredAs = dlqJobId` via a
 * conflict-aware JSONB merge: the link is only written when no existing
 * `deadLetteredAs` is present, or when the existing value matches `dlqJobId`
 * (idempotent same-id call).
 *
 * Fail-open per issue #1's audit-write constraint. Three quiet paths:
 *  - no failed row for `sourceJobId` → `console.warn` with `reason: not_found`,
 *    no-op (no throw).
 *  - existing `deadLetteredAs` differs from `dlqJobId` → `console.warn` with
 *    `reason: conflict`, no-op. First link wins.
 *  - any DB error → `console.warn` with `reason: db_error`, no-op.
 *
 * The *only* throw path is argument validation (a programmer error): both
 * `sourceJobId` and `dlqJobId` must be non-empty strings.
 *
 * Composes with {@link recordTerminalDetail} at the JSONB key level — both
 * writers `||`-merge into `terminal_detail`, so calling them in either order
 * preserves the other's keys.
 */
export async function recordDeadLetter(
  pool: Pool,
  schemas: SchemaNames,
  args: RecordDeadLetterArgs,
): Promise<void> {
  const { sourceJobId, dlqJobId } = args;

  if (typeof sourceJobId !== 'string' || sourceJobId.length === 0) {
    throw new Error(
      'pg-bossier: recordDeadLetter validation: sourceJobId must be a non-empty string',
    );
  }
  if (typeof dlqJobId !== 'string' || dlqJobId.length === 0) {
    throw new Error(
      'pg-bossier: recordDeadLetter validation: dlqJobId must be a non-empty string',
    );
  }

  try {
    const { rowCount } = await pool.query(
      `
      WITH target AS (
        SELECT job_id, attempt, terminal_detail
        FROM ${schemas.pgbossier}.record
        WHERE job_id = $1 AND state = 'failed'
        ORDER BY attempt DESC
        LIMIT 1
      ), should_write AS (
        SELECT job_id, attempt FROM target
        WHERE terminal_detail IS NULL
           OR NOT (terminal_detail ? 'deadLetteredAs')
           OR terminal_detail->>'deadLetteredAs' = $2
      )
      UPDATE ${schemas.pgbossier}.record r
      SET terminal_detail = COALESCE(r.terminal_detail, '{}'::jsonb)
                          || jsonb_build_object('deadLetteredAs', $2::text)
      FROM should_write w
      WHERE r.job_id = w.job_id AND r.attempt = w.attempt
      `,
      [sourceJobId, dlqJobId],
    );

    if (rowCount === 0) {
      // Either (a) no failed row for sourceJobId, or (b) an existing
      // deadLetteredAs differs from the new one. Distinguish via a follow-up
      // SELECT so the warning carries an actionable reason.
      const { rows } = await pool.query<{ existing: string | null }>(
        `SELECT terminal_detail->>'deadLetteredAs' AS existing
           FROM ${schemas.pgbossier}.record
          WHERE job_id = $1 AND state = 'failed'
          ORDER BY attempt DESC
          LIMIT 1`,
        [sourceJobId],
      );
      const head = rows[0];
      if (!head) {
        console.warn(
          `pgbossier: recordDeadLetter no failed row for source ${sourceJobId} reason: not_found`,
        );
      } else if (head.existing !== null && head.existing !== dlqJobId) {
        console.warn(
          `pgbossier: recordDeadLetter conflicting existing link for source ${sourceJobId}: ` +
          `existing=${head.existing}, new=${dlqJobId} — first link wins reason: conflict`,
        );
      }
      // Otherwise: a rare race where another writer landed the same dlqJobId
      // between the UPDATE and SELECT. No-op without warning is acceptable.
    }
  } catch (err) {
    console.warn(
      `pgbossier: recordDeadLetter failed for source ${sourceJobId}: ${String(err)} reason: db_error`,
    );
  }
}

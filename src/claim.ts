import type { BossierDb } from './db.js';
import { UUID_RE } from './sql.js';
import type { SchemaNames } from './sql.js';

/**
 * Write a job's claim owner — e.g. the id of the worker that pulled it — to its
 * *current* attempt's `pgbossier.record.claimed_by`. The attempt is resolved
 * server-side as `max(attempt)` for the job, so a worker needs only `job.id`.
 *
 * Per-attempt by design: a retry is a new attempt with its own `claimed_by`, so
 * "which worker owned attempt N" is answerable forensically (it survives pg-boss's
 * `deletion_seconds` GC like the rest of the chronicle).
 *
 * Fail-open per issue #1's audit-write constraint: a runtime error, or an UPDATE
 * matching no row, is logged via `console.warn` and swallowed — a failed claim
 * write must never fail the consumer's job. The only throw path is argument
 * validation (a programmer error): `ownerId` must be a non-empty string.
 */
export async function setClaim(
  db: BossierDb, schemas: SchemaNames, jobId: string, ownerId: string,
): Promise<void> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error(
      'pg-bossier: claim validation: ownerId must be a non-empty string',
    );
  }
  // Short-circuit a malformed (non-UUID) id like getClaim does, so a typo logs a
  // clear "malformed job id" rather than a confusing Postgres uuid-cast error.
  if (!UUID_RE.test(jobId)) {
    console.warn(`pgbossier: setClaim got a malformed job id: ${jobId}`);
    return;
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE ${schemas.pgbossier}.record
         SET claimed_by = $2
       WHERE job_id = $1
         AND attempt = (
           SELECT max(attempt) FROM ${schemas.pgbossier}.record WHERE job_id = $1
         )`,
      [jobId, ownerId],
    );
    if (rowCount === 0) {
      console.warn(
        `pgbossier: setClaim matched no record for job ${jobId} — ` +
        `is pg-bossier installed?`,
      );
    }
  } catch (err) {
    console.warn(`pgbossier: setClaim failed for job ${jobId}: ${String(err)}`);
  }
}

/**
 * Read a job's claim owner — the `claimed_by` of its *current* (highest)
 * attempt, matching the attempt {@link setClaim} writes to. `null` if the
 * current attempt was never claimed, or the job is unknown to pg-bossier. A
 * malformed (non-UUID) `jobId` short-circuits to `null` without a query.
 *
 * Current-attempt-scoped on purpose: it answers "who owns this job *now*", so an
 * owner-equality authz check can't be satisfied by a stale owner carried over
 * from a prior (failed/retried) attempt. Per-attempt ownership history stays
 * queryable via the chronicle (`getRetryHistory`).
 */
export async function getClaim(
  db: BossierDb, schemas: SchemaNames, jobId: string,
): Promise<string | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await db.query<{ claimed_by: string | null }>(
    `SELECT claimed_by FROM ${schemas.pgbossier}.record
     WHERE job_id = $1
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  return rows[0]?.claimed_by ?? null;
}

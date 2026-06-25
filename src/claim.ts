import type { BossierDb } from './db.js';
import { UUID_RE } from './sql.js';
import type { SchemaNames } from './sql.js';

/**
 * Claim a job's *current* attempt for `ownerId` — compare-and-set (#41a).
 * Writes `ownerId` to `pgbossier.record.claimed_by` of the job's current attempt
 * (`max(attempt)`, resolved server-side) **only if that attempt is unclaimed or
 * already owned by `ownerId`**, and returns whether the claim is held by
 * `ownerId` afterwards (`true` = won/owns it, `false` = lost to another owner,
 * unknown job, or not installed).
 *
 * This lets a pull-worker treat the marker as authoritative without depending on
 * pg-boss's `fetch()` `FOR UPDATE SKIP LOCKED` to serialize claimants: two
 * workers racing to claim the same attempt — exactly one gets `true`. Idempotent
 * for the owner: re-claiming an attempt you already hold returns `true` (the
 * `claimed_by = $2` arm), not a spurious `false`.
 *
 * Per-attempt by design: a retry is a new attempt with its own `claimed_by`, so
 * "which worker owned attempt N" is answerable forensically (it survives pg-boss's
 * `deletion_seconds` GC like the rest of the chronicle).
 *
 * Fail-open per issue #1's audit-write constraint: a runtime error is logged via
 * `console.warn` and swallowed (returns `false`) — a failed claim write must
 * never fail the consumer's job. A `false` from a no-matching-row UPDATE is a
 * normal CAS outcome (lost / unknown / not installed), not warned — check
 * `isInstalled()` (#40) to distinguish "not installed" up front. The only throw
 * path is argument validation: `ownerId` must be a non-empty string.
 */
export async function setClaim(
  db: BossierDb, schemas: SchemaNames, jobId: string, ownerId: string,
): Promise<boolean> {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error(
      'pg-bossier: claim validation: ownerId must be a non-empty string',
    );
  }
  // Short-circuit a malformed (non-UUID) id like getClaim does, so a typo logs a
  // clear "malformed job id" rather than a confusing Postgres uuid-cast error.
  if (!UUID_RE.test(jobId)) {
    console.warn(`pgbossier: setClaim got a malformed job id: ${jobId}`);
    return false;
  }
  try {
    const { rowCount } = await db.query(
      `UPDATE ${schemas.pgbossier}.record
         SET claimed_by = $2
       WHERE job_id = $1
         AND attempt = (
           SELECT max(attempt) FROM ${schemas.pgbossier}.record WHERE job_id = $1
         )
         AND (claimed_by IS NULL OR claimed_by = $2)`,
      [jobId, ownerId],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    console.warn(`pgbossier: setClaim failed for job ${jobId}: ${String(err)}`);
    return false;
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

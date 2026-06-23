import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';

/**
 * A snapshot of capture health — for detecting silent drift, since capture is
 * fail-open (a failing trigger `RAISE WARNING`s into the Postgres log and leaves
 * a hole in `record`, with no app-level signal). See issue #31.
 *
 * Observability only: nothing here changes capture behaviour, which stays
 * fail-open per issue #1's audit-write constraint.
 */
export interface CaptureHealth {
  /** `seq` of the most recently captured row; `null` when `record` is empty. */
  lastCapturedSeq: bigint | null;
  /**
   * `captured_at` of the most recently captured row; `null` when empty. Alarm on
   * staleness: a busy queue with a `lastCapturedAt` far in the past suggests the
   * trigger stopped firing (dropped, disabled, or erroring).
   */
  lastCapturedAt: Date | null;
  /**
   * How many live `pgboss.job` rows were sampled for the coverage check
   * (bounded by `sampleLimit`). `0` means pg-boss currently holds no jobs.
   */
  checked: number;
  /**
   * Of the sampled live jobs, how many have NO matching `record` row — i.e.
   * capture gaps. Should be `0`. A non-zero value means capture dropped rows
   * (or the sampled jobs predate `install()`).
   */
  missing: number;
}

const DEFAULT_SAMPLE_LIMIT = 1000;

/**
 * Read a {@link CaptureHealth} snapshot: chronicle freshness (`lastCapturedSeq`
 * / `lastCapturedAt`) plus a bounded coverage check (how many of the most-recent
 * live `pgboss.job` rows are missing from `record`).
 *
 * The coverage check is bounded to the `sampleLimit` (default 1000) most-recent
 * live jobs so it stays cheap on a large queue — it samples, it does not scan
 * the whole table. Pass a larger `sampleLimit` for a wider (more expensive)
 * check. Reads `pgboss.job` (Transitional tier, like the backfill).
 *
 * ponytail: bounded sample, not an exact full-table audit — raise `sampleLimit`
 * if a deployment needs exhaustive coverage.
 */
export async function captureHealth(
  db: BossierDb,
  schemas: SchemaNames,
  opts: { sampleLimit?: number } = {},
): Promise<CaptureHealth> {
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  if (!Number.isInteger(sampleLimit) || sampleLimit <= 0) {
    throw new Error(
      `sampleLimit must be a positive integer, got ${String(sampleLimit)}`,
    );
  }

  const freshness = await db.query<{ seq: string | null; at: Date | null }>(
    `SELECT max(seq) AS seq, max(captured_at) AS at FROM ${schemas.pgbossier}.record`,
  );
  const coverage = await db.query<{ checked: number; missing: number }>(
    `WITH sample AS (
       SELECT id FROM ${schemas.pgboss}.job
       ORDER BY created_on DESC NULLS LAST
       LIMIT $1
     )
     SELECT count(*)::int                                 AS checked,
            count(*) FILTER (WHERE r.job_id IS NULL)::int AS missing
       FROM sample s
       LEFT JOIN ${schemas.pgbossier}.record r ON r.job_id = s.id`,
    [sampleLimit],
  );

  const f = freshness.rows[0];
  const c = coverage.rows[0];
  return {
    lastCapturedSeq: f?.seq != null ? BigInt(f.seq) : null,
    lastCapturedAt: f?.at ?? null,
    checked: c?.checked ?? 0,
    missing: c?.missing ?? 0,
  };
}

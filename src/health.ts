import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';
import { isBossierInstalled } from './installed.js';

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
   * `null` when the coverage check was skipped via `{ coverage: false }` —
   * distinguishable from a genuine `0` (empty queue).
   */
  checked: number | null;
  /**
   * Of the sampled live jobs, how many have NO matching `record` row — i.e.
   * capture gaps. Should be `0`. A non-zero value means capture dropped rows
   * (or the sampled jobs predate `install()`). `null` when the coverage check
   * was skipped via `{ coverage: false }`.
   */
  missing: number | null;
}

const DEFAULT_SAMPLE_LIMIT = 1000;

/**
 * Read a {@link CaptureHealth} snapshot: chronicle freshness (`lastCapturedSeq`
 * / `lastCapturedAt`) plus a bounded coverage check (how many of the most-recent
 * live `pgboss.job` rows are missing from `record`).
 *
 * The coverage check looks at the `sampleLimit` (default 1000) most-recent live
 * jobs. **Not an O(1) probe:** finding the most-recent N means an
 * `ORDER BY created_on DESC LIMIT` over `pgboss.job`, which on a large
 * partitioned table reads/sorts proportional to the live-job count (no index
 * pg-bossier controls). `sampleLimit` bounds the *result* (the join + the
 * `missing` count), not the scan. So **call this periodically (cron / an admin
 * health job), not on a hot per-request path.** The freshness half
 * (`lastCapturedSeq`/`lastCapturedAt`) is cheap (indexed `record.seq`); the
 * coverage half is the expensive one. Reads `pgboss.job` (Transitional tier,
 * like the backfill).
 *
 * ponytail: most-recent-N sample, not an exact full-table audit — raise
 * `sampleLimit` for wider coverage at proportionally more cost.
 *
 * Pass `{ coverage: false }` for a **freshness-only** snapshot (#43): it runs
 * only the cheap, indexed freshness query and skips the expensive coverage
 * `ORDER BY` over `pgboss.job` entirely — cheap enough for frequent periodic
 * polling. `checked` / `missing` come back `null` in that mode (distinct from a
 * genuine `0`).
 */
export async function captureHealth(
  db: BossierDb,
  schemas: SchemaNames,
  opts: { sampleLimit?: number; coverage?: boolean } = {},
): Promise<CaptureHealth> {
  const coverageEnabled = opts.coverage ?? true;
  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  // Only validate sampleLimit when it's actually used (coverage on).
  if (coverageEnabled && (!Number.isInteger(sampleLimit) || sampleLimit <= 0)) {
    throw new Error(
      `pg-bossier: sampleLimit must be a positive integer, got ${String(sampleLimit)}`,
    );
  }

  // Distinguish "not installed" from "installed but empty": without this probe a
  // missing schema would 42P01 on every query and (via the read fail-soft path)
  // report a falsely-healthy 0/0. captureHealth is wired to the RAW db (not the
  // fail-soft readDb), so this probe — and the queries below — see the true state.
  if (!(await isBossierInstalled(db, schemas))) {
    return { lastCapturedSeq: null, lastCapturedAt: null, checked: null, missing: null };
  }

  const freshness = await db.query<{ seq: string | null; at: Date | null }>(
    `SELECT max(seq) AS seq, max(captured_at) AS at FROM ${schemas.pgbossier}.record`,
  );
  const f = freshness.rows[0];

  // Freshness-only mode: skip the coverage ORDER BY (the expensive half). Return
  // checked/missing = null so a skipped check is distinguishable from a real 0.
  if (!coverageEnabled) {
    return {
      lastCapturedSeq: f?.seq != null ? BigInt(f.seq) : null,
      lastCapturedAt: f?.at ?? null,
      checked: null,
      missing: null,
    };
  }

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

  const c = coverage.rows[0];
  return {
    lastCapturedSeq: f?.seq != null ? BigInt(f.seq) : null,
    lastCapturedAt: f?.at ?? null,
    checked: c?.checked ?? 0,
    missing: c?.missing ?? 0,
  };
}

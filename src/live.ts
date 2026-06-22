import type { PgBoss, JobWithMetadata } from 'pg-boss';
import type { BossierDb } from './db.js';
import type { SchemaNames } from './sql.js';
import { findById, type JobState } from './read.js';

/**
 * A job's current LIVE runtime state, as pg-boss sees it right now — distinct
 * from the durable chronicle. Carries explicit provenance so a missing live row
 * is never mistaken for "completed".
 */
export interface LiveState<T = unknown> {
  /** True if pg-boss still has a live `pgboss.job` row for this job (in-flight). */
  livePresent: boolean;
  /** When this live read happened. */
  liveReadAt: Date;
  /**
   * The durable record's current state — disambiguates a missing live row.
   * When `livePresent` is false: `completed` / `failed` / `cancelled` means the
   * job is genuinely done; `active` / `retry` / `created` means it's in a brief
   * retry DELETE+INSERT gap (do NOT render "not found"). `null` only when
   * pg-bossier never captured the job.
   */
  recordState: JobState | null;
  /** pg-boss's live metadata (heartbeat, expiry, started_on, …), or `null` when no live row exists. */
  job: JobWithMetadata<T> | null;
}

/**
 * Read a job's current LIVE runtime state from pg-boss (via `findJobs`) — NOT
 * the durable chronicle. **Explicitly non-forensic:** it answers "what does
 * pg-boss say about this job *right now*?", not "what happened?". Live fields
 * (heartbeat, expiry, …) vanish the moment pg-boss deletes the row on
 * completion/TTL; use {@link LiveState.recordState} to tell "done" from a
 * mid-retry gap.
 *
 * The queue name comes from the durable record, so the underlying
 * `findJobs(queue, { id })` is scoped to that queue's partition (pg-boss 12
 * partitions `pgboss.job` by queue) — no cross-partition scan.
 *
 * Returns `null` only when the job is unknown to pg-bossier (never captured, or
 * a malformed id). Works without a `pool` (BYO connection): reads go through the
 * resolved `db`, and `findJobs` is pg-boss's own public API.
 */
export async function getLiveState<T = unknown>(
  boss: PgBoss, db: BossierDb, schemas: SchemaNames, jobId: string,
): Promise<LiveState<T> | null> {
  const record = await findById(db, schemas, jobId);
  if (!record) return null; // unknown to pg-bossier (no live row can exist without a captured INSERT)
  const liveReadAt = new Date();
  const jobs = await boss.findJobs<T>(record.queue, { id: jobId });
  const job = jobs[0] ?? null;
  return { livePresent: job !== null, liveReadAt, recordState: record.state, job };
}

/**
 * Convenience over {@link getLiveState}: the job's live heartbeat timestamp, or
 * `null` when no live row exists (job done / TTL-deleted / unknown). For
 * "is this in-flight worker still checking in?" liveness checks.
 *
 * NOT forensic — "when did a now-dead job last beat?" is unanswerable here (the
 * live row is gone). That would need a separate opt-in capture mechanism.
 */
export async function getLiveHeartbeat(
  boss: PgBoss, db: BossierDb, schemas: SchemaNames, jobId: string,
): Promise<Date | null> {
  const live = await getLiveState(boss, db, schemas, jobId);
  return live?.job?.heartbeatOn ?? null;
}

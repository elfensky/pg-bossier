import type { PgBoss, JobWithMetadata } from 'pg-boss';
import type { BossierDb } from './db.js';
import { UUID_RE, type SchemaNames } from './sql.js';
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
 * **A captured `record` is a prerequisite.** Because the queue is resolved from
 * the chronicle, this returns `null` whenever pg-bossier has no record for the
 * job — **even if a live `pgboss.job` row exists right now**. Two real cases
 * (issue #35): a job enqueued *before* `install()` (it has a live row but was
 * never captured), and a fail-open capture gap. So `null` means "unknown to
 * pg-bossier", which is not the same as "no live row". (Also `null` for a
 * malformed id.) Works without a `pool` (BYO connection): reads go through the
 * resolved `db`, and `findJobs` is pg-boss's own public API.
 */
export async function getLiveState<T = unknown>(
  boss: PgBoss, db: BossierDb, schemas: SchemaNames, jobId: string,
): Promise<LiveState<T> | null> {
  const record = await findById(db, schemas, jobId);
  // Unknown to pg-bossier. The queue partition is resolved from the record, so
  // without one we can't scope the live read — null even if a live row exists
  // (a pre-install or fail-open-gap job). See the doc comment / issue #35.
  if (!record) return null;
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

/**
 * Batched live heartbeat read — one query for many jobs, to avoid an N+1 loop of
 * per-row {@link getLiveHeartbeat} on a dashboard (issue #34). Returns a `Map`
 * keyed by **every** requested id: a live heartbeat `Date`, or `null` when the
 * job has no live `pgboss.job` row (done / TTL-deleted / never enqueued) or a
 * live row with no heartbeat yet. A malformed id maps to `null`.
 *
 * Like {@link getLiveHeartbeat} this is LIVE and **non-forensic**. It reads
 * `pgboss.job` directly (Transitional tier) because pg-boss's `findJobs` takes a
 * single id — there is no public batched job-read. No record lookup is needed:
 * heartbeat is keyed by id.
 *
 * ponytail: `id = ANY(...)` has no partition key, so it scans every queue
 * partition of `pgboss.job` — fine for a dashboard page of ids, not for tens of
 * thousands. Read per-queue with `getLiveState` if a hot path needs pruning.
 */
export async function getLiveHeartbeats(
  db: BossierDb, schemas: SchemaNames, jobIds: string[],
): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>();
  for (const id of jobIds) result.set(id, null); // default: no live heartbeat
  const valid = jobIds.filter((id) => UUID_RE.test(id));
  if (valid.length === 0) return result;
  const { rows } = await db.query<{ id: string; heartbeat_on: Date | null }>(
    `SELECT id, heartbeat_on FROM ${schemas.pgboss}.job WHERE id = ANY($1::uuid[])`,
    [valid],
  );
  for (const r of rows) result.set(r.id, r.heartbeat_on);
  return result;
}

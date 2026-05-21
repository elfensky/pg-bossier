import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
} from './read.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
}

export interface BossierClient {
  /** The underlying pg-boss instance — its queue ops are used unchanged. */
  boss: PgBoss;
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
  /** A job's latest attempt, across all queues. `null` if never captured. */
  findById: <TInput = unknown, TOutput = unknown>(
    jobId: string,
  ) => Promise<JobRecord<TInput, TOutput> | null>;
  /** Every attempt of a job, oldest first. */
  getRetryHistory: <TInput = unknown, TOutput = unknown>(
    jobId: string,
  ) => Promise<JobRecord<TInput, TOutput>[]>;
  /** Filtered, paginated job list with an exact total. */
  listJobs: <TInput = unknown, TOutput = unknown>(
    opts?: ListJobsOpts,
  ) => Promise<{ rows: JobRecord<TInput, TOutput>[]; total: number }>;
  /** The most recent job in each queue, at its current state. */
  latestPerQueue: (
    queues: string[],
    opts?: { states?: JobState[] },
  ) => Promise<JobRecord[]>;
  /** Job counts by current state (all six keys present). */
  countByState: (filter?: JobFilter) => Promise<Record<JobState, number>>;
  /** Job counts by queue. */
  countByQueue: (filter?: JobFilter) => Promise<Record<string, number>>;
  /** Active jobs running longer than a threshold. */
  listLongRunning: (
    opts?: { queue?: string; longerThanSeconds?: number; limit?: number },
  ) => Promise<JobRecord[]>;
}

/**
 * The pg-bossier client: the pg-boss instance for queue ops, `recordPatch` for
 * the app-hook columns, and the Goal 5 operational read methods. All reads run
 * on the supplied `pool`.
 */
export function bossier(options: BossierOptions): BossierClient {
  const { boss, pool } = options;
  return {
    boss,
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, jobId, attempt, patch),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(pool, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(pool, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(pool, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(pool, queues, opts),
    countByState: (filter) => countByState(pool, filter),
    countByQueue: (filter) => countByQueue(pool, filter),
    listLongRunning: (opts) => listLongRunning(pool, opts),
  };
}

import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';
import { recordTerminalDetail, type TerminalDetail } from './terminal-detail.js';
import { recordDeadLetter, type RecordDeadLetterArgs } from './dead-letter.js';
import { setProgress, getProgress, type ProgressResult } from './progress.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning, getEventsSince,
  findDeadLetterSource, findDeadLetterTarget,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
  type GetEventsSinceOpts,
} from './read.js';
import { subscribe, type BossierEvents, type SubscribeOptions } from './events.js';
import { resolveSchemas, type SchemaNames } from './sql.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

/**
 * pg-bossier's own methods — the surface added on top of pg-boss's API:
 * `recordPatch` for the app-hook-owned columns, the Goal 5 operational read
 * methods, and the Goal 6 progress methods (`setProgress` / `getProgress`).
 * All run on the `pool` passed to `bossier()`.
 */
export interface BossierMethods {
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
  /**
   * Write a worker-classified terminal detail to a chronicle row. The sole
   * writer of `pgbossier.record.terminal_detail`. State-bound: a `'failed'`
   * payload matches rows in `state='failed'` or `state='retry'`; `'completed'`
   * and `'cancelled'` payloads each only match their own state.
   */
  recordTerminalDetail: (
    jobId: string, attempt: number, payload: TerminalDetail,
  ) => Promise<void>;
  /**
   * Record a source → DLQ lineage link on the source job's most-recent
   * `failed` chronicle row. Writes `terminal_detail.deadLetteredAs = dlqJobId`
   * via a conflict-aware JSONB merge. Fail-open: missing source row,
   * conflicting prior link, or DB errors all warn and no-op.
   */
  recordDeadLetter: (args: RecordDeadLetterArgs) => Promise<void>;
  /**
   * Reverse lineage lookup: given a DLQ job's id, find the source attempt that
   * linked to it. `null` when no source row carries that link.
   */
  findDeadLetterSource: (
    dlqJobId: string,
  ) => Promise<{ jobId: string; attempt: number; queue: string } | null>;
  /**
   * Forward lineage lookup: given a source job's id, find the DLQ job it was
   * dead-lettered to. `null` when no failed attempt carries that link.
   */
  findDeadLetterTarget: (
    sourceJobId: string,
  ) => Promise<{ dlqJobId: string; attempt: number } | null>;
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
  /** Write a job's progress to its current attempt. */
  setProgress: (jobId: string, progress: unknown) => Promise<void>;
  /** A job's effective progress — most-recent non-null, with its source attempt. */
  getProgress: <TProgress = unknown>(
    jobId: string,
  ) => Promise<ProgressResult<TProgress> | null>;
  /** Open a subscription to job-lifecycle events. */
  subscribe: (opts?: SubscribeOptions) => Promise<BossierEvents>;
  /** Read pgbossier.record rows with seq > since, ordered ascending. */
  getEventsSince: <TInput = unknown, TOutput = unknown>(
    since: bigint, opts?: GetEventsSinceOpts,
  ) => Promise<JobRecord<TInput, TOutput>[]>;
}

/**
 * The unified pg-bossier client: every pg-boss method (forwarded to the
 * wrapped instance) plus pg-bossier's own `BossierMethods`, on one flat
 * surface. Returned by `bossier()`.
 */
export type Bossier = PgBoss & BossierMethods;

/**
 * Wrap a started pg-boss instance into a single client that exposes pg-boss's
 * whole API alongside pg-bossier's methods.
 *
 * The client is a `Proxy` over `boss`: a `BossierMethods` call resolves to
 * pg-bossier's implementation; every other property is forwarded to `boss`.
 * Forwarded functions are bound to `boss` — pg-boss 12 uses `#private` fields,
 * which throw if a method runs with `this` set to the proxy rather than the
 * instance.
 */
export function bossier(options: BossierOptions): Bossier {
  const { boss, pool } = options;
  const s: SchemaNames = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });

  const methods: BossierMethods = {
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, s, jobId, attempt, patch),
    recordTerminalDetail: (jobId, attempt, payload) =>
      recordTerminalDetail(pool, s, jobId, attempt, payload),
    recordDeadLetter: (args) => recordDeadLetter(pool, s, args),
    findDeadLetterSource: (dlqJobId) => findDeadLetterSource(pool, s, dlqJobId),
    findDeadLetterTarget: (sourceJobId) => findDeadLetterTarget(pool, s, sourceJobId),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(pool, s, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(pool, s, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(pool, s, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(pool, s, queues, opts),
    countByState: (filter) => countByState(pool, s, filter),
    countByQueue: (filter) => countByQueue(pool, s, filter),
    listLongRunning: (opts) => listLongRunning(pool, s, opts),
    setProgress: (jobId, progress) => setProgress(pool, s, jobId, progress),
    getProgress: <TProgress = unknown>(jobId: string) =>
      getProgress<TProgress>(pool, s, jobId),
    subscribe: (opts) => subscribe(pool, s, opts),
    getEventsSince: <TInput = unknown, TOutput = unknown>(
      since: bigint, opts?: GetEventsSinceOpts,
    ) => getEventsSince<TInput, TOutput>(pool, s, since, opts),
  };
  const methodNames = new Set(Object.keys(methods));

  return new Proxy(boss, {
    get(target, prop) {
      if (typeof prop === 'string' && methodNames.has(prop)) {
        return methods[prop as keyof BossierMethods];
      }
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member === 'function') {
        // A bound method that returns `this` (e.g. EventEmitter `on` / `once`)
        // returns the raw instance, not the proxy — chaining is unaffected
        // because both resolve the same object.
        const fn = member as (...args: unknown[]) => unknown;
        return fn.bind(target);
      }
      return member;
    },
  }) as Bossier;
}

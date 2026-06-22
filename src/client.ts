import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordTerminalDetail, type TerminalDetail } from './terminal-detail.js';
import { recordDeadLetter, type RecordDeadLetterArgs } from './dead-letter.js';
import { setProgress, getProgress, type ProgressResult } from './progress.js';
import {
  recordInputSnapshot, getInputSnapshot, type InputSnapshotResult,
} from './input-snapshot.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning, getEventsSince,
  findDeadLetterSource, findDeadLetterTarget,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
} from './read.js';
import { subscribeEvents, type BossierEvents, type SubscribeOptions } from './events.js';
import { resolveSchemas, type SchemaNames } from './sql.js';
import { pgBossDb, type BossierDb } from './db.js';

export interface BossierOptions {
  boss: PgBoss;
  /**
   * A pg `Pool`. **Optional.** When omitted, pg-bossier's read/write methods
   * run through pg-boss's own DB handle (`boss.getDb()`) — so a consumer using
   * pg-boss with a Prisma/Knex/Kysely/Drizzle adapter never has to hand
   * pg-bossier a separate connection. A `pool` (or `db`) is still **required
   * for `subscribeEvents`** (LISTEN/NOTIFY needs a dedicated pg connection that
   * ORM adapters don't expose).
   */
  pool?: Pool;
  /**
   * An explicit query surface for pg-bossier's reads/writes, overriding the
   * default (`pool`, else `boss.getDb()`). Rarely needed — pass your own pg-boss
   * adapter (`fromPrisma`/`fromKnex`/…) here only if it differs from the one
   * `boss` was constructed with.
   */
  db?: BossierDb;
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

/**
 * pg-bossier's own methods — the surface added on top of pg-boss's API:
 * the Goal 2/4/6 write methods (`recordTerminalDetail` / `recordInputSnapshot`
 * / `setProgress`), the Goal 5 operational read methods, and the Goal 7 event
 * methods. All run on the `pool` passed to `bossier()`.
 */
export interface BossierMethods {
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
  /**
   * The newest job in each queue, at its current state. `orderBy` chooses the
   * timestamp: `'createdOn'` (default) or `'completedOn'` (last finished run).
   */
  latestPerQueue: (
    queues: string[],
    opts?: { states?: JobState[]; orderBy?: 'createdOn' | 'completedOn' },
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
  /**
   * Write a job's input snapshot to a specific `(jobId, attempt)` row. The sole
   * writer of `pgbossier.record.input_snapshot`. Fail-open: a missing row or DB
   * error warns and no-ops; only argument validation (undefined / null /
   * non-JSON snapshot) throws.
   */
  recordInputSnapshot: (
    jobId: string, attempt: number, snapshot: unknown,
  ) => Promise<void>;
  /**
   * Read a job's input snapshot. With `attempt`, returns the snapshot on
   * that exact row as `T | null`. Without `attempt`, returns the most-recent
   * non-null snapshot as `{ snapshot, attempt } | null`.
   */
  getInputSnapshot: {
    <T = unknown>(jobId: string, attempt: number): Promise<T | null>;
    <T = unknown>(jobId: string): Promise<InputSnapshotResult<T> | null>;
  };
  /**
   * Open a subscription to job-lifecycle events. Named `subscribeEvents` (not
   * `subscribe`) so it never shadows pg-boss's own pub/sub `subscribe(event,
   * name)` — that method stays reachable through the proxy. See the
   * collision-guard test in `test/client.test.ts`.
   *
   * Requires the client to have been built with a `pool` (LISTEN/NOTIFY needs a
   * dedicated pg connection); throws a clear error otherwise.
   */
  subscribeEvents: (opts?: SubscribeOptions) => Promise<BossierEvents>;
  /** Read pgbossier.record rows with seq > since, ordered ascending. */
  getEventsSince: <TInput = unknown, TOutput = unknown>(
    since: bigint, limit?: number,
  ) => Promise<JobRecord<TInput, TOutput>[]>;
}

/**
 * The unified pg-bossier client: every pg-boss method (forwarded to the
 * wrapped instance) plus pg-bossier's own `BossierMethods`, on one flat
 * surface. Returned by `bossier()`.
 */
export type Bossier = PgBoss & BossierMethods;

/**
 * The names of pg-bossier's own methods — the single source of truth for both
 * the Proxy's routing set and the collision-guard test (`test/client.test.ts`).
 * `satisfies` checks every entry is a real `BossierMethods` key. Because the
 * Proxy routes *only* these names, any method missing here is non-functional
 * and fails its own test — so a method can't be quietly dropped from the list
 * to dodge the collision guard, which is exactly how the `subscribe` shadow
 * once hid (it was omitted from a hand-kept list to keep the guard green).
 */
export const BOSSIER_METHOD_NAMES = [
  'recordTerminalDetail',
  'recordDeadLetter', 'findDeadLetterSource', 'findDeadLetterTarget',
  'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
  'setProgress', 'getProgress',
  'recordInputSnapshot', 'getInputSnapshot',
  'subscribeEvents', 'getEventsSince',
] as const satisfies readonly (keyof BossierMethods)[];

/** `subscribeEvents` needs a real pg connection an ORM adapter can't provide. */
const SUBSCRIBE_EVENTS_NEEDS_POOL =
  'pgbossier: subscribeEvents requires a `pool` — LISTEN/NOTIFY needs a ' +
  'dedicated pg connection that ORM adapters do not expose. Construct the ' +
  'client as bossier({ boss, pool }).';

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
  // Reads/writes go through `db`: an explicit adapter, else the caller's pool,
  // else pg-boss's own DB handle (so no separate pool is required). LISTEN/
  // NOTIFY (`subscribeEvents`) still needs a real `pool` — see requirePool.
  const db: BossierDb = options.db ?? pool ?? pgBossDb(boss);
  const s: SchemaNames = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });

  const methods: BossierMethods = {
    recordTerminalDetail: (jobId, attempt, payload) =>
      recordTerminalDetail(db, s, jobId, attempt, payload),
    recordDeadLetter: (args) => recordDeadLetter(db, s, args),
    findDeadLetterSource: (dlqJobId) => findDeadLetterSource(db, s, dlqJobId),
    findDeadLetterTarget: (sourceJobId) => findDeadLetterTarget(db, s, sourceJobId),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(db, s, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(db, s, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(db, s, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(db, s, queues, opts),
    countByState: (filter) => countByState(db, s, filter),
    countByQueue: (filter) => countByQueue(db, s, filter),
    listLongRunning: (opts) => listLongRunning(db, s, opts),
    setProgress: (jobId, progress) => setProgress(db, s, jobId, progress),
    getProgress: <TProgress = unknown>(jobId: string) =>
      getProgress<TProgress>(db, s, jobId),
    recordInputSnapshot: (jobId, attempt, snapshot) =>
      recordInputSnapshot(db, s, jobId, attempt, snapshot),
    // Overloaded: dispatch at the call site to land on each of the underlying
    // free function's two public overloads. `attempt === undefined` → the
    // wrapped-result overload; otherwise → the `T | null` overload.
    getInputSnapshot: <T = unknown>(jobId: string, attempt?: number) =>
      attempt === undefined
        ? getInputSnapshot<T>(db, s, jobId)
        : getInputSnapshot<T>(db, s, jobId, attempt),
    subscribeEvents: (opts) =>
      pool === undefined
        ? Promise.reject(new Error(SUBSCRIBE_EVENTS_NEEDS_POOL))
        : subscribeEvents(pool, s, opts),
    getEventsSince: <TInput = unknown, TOutput = unknown>(
      since: bigint, limit?: number,
    ) => getEventsSince<TInput, TOutput>(db, s, since, limit),
  };
  const methodNames = new Set<string>(BOSSIER_METHOD_NAMES);

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

import type { PgBoss, SendOptions } from 'pg-boss';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { recordTerminalDetail, type TerminalDetail } from './terminal-detail.js';
import { recordDeadLetter, type RecordDeadLetterArgs } from './dead-letter.js';
import { setProgress, getProgress, type ProgressResult } from './progress.js';
import { setClaim, getClaim } from './claim.js';
import {
  recordInputSnapshot, getInputSnapshot, type InputSnapshotResult,
} from './input-snapshot.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning, getEventsSince,
  findDeadLetterSource, findDeadLetterTarget,
  type JobRecord, type JobState, type CountFilter, type ListJobsOpts,
} from './read.js';
import { subscribeEvents, type BossierEvents, type SubscribeOptions } from './events.js';
import { getLiveState, getLiveHeartbeat, getLiveHeartbeats, type LiveState } from './live.js';
import { captureHealth, type CaptureHealth } from './health.js';
import { resolveSchemas, type SchemaNames } from './sql.js';
import { pgBossDb, type BossierDb } from './db.js';

/** The field {@link BossierMethods.sendTracked} stamps the self-identifying id into. */
const DEAD_LETTER_ID_FIELD = '_originalJobId';

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
   * `boss.send` that pins the job id AND stamps the same id into
   * `data._originalJobId` in one call, so the dead-letter lineage contract can
   * never half-drift (the silent failure mode of hand-threading them — issue
   * #29). Returns the job id pg-boss assigned (the pinned id), or `null` if a
   * singleton policy deduped the send.
   *
   * The DLQ handler still calls {@link recordDeadLetter} (only it knows both the
   * source and DLQ ids), reading the source id back from
   * `job.data._originalJobId`. Pass an explicit `{ id }` to pin a known id;
   * otherwise a UUID is generated.
   *
   * `sendTracked` **owns** `data._originalJobId`: any value you pass under that
   * key is overwritten with the pinned id (the breadcrumb must equal the job's
   * real id for lineage to resolve). To control the id, set `{ id }` — not the
   * data key.
   */
  sendTracked: (
    queue: string, data: object, options?: SendOptions,
  ) => Promise<string | null>;
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
  /**
   * Job counts by current state (all six keys present). **All-time by default:**
   * counts the chronicle, which retains jobs pg-boss has deleted, so the result
   * is a forensic superset of live queue depth that grows unbounded. Pass
   * `{ live: true }` for a live `pgboss.job` count, or `createdAfter` /
   * `completedAfter` for a recent window. See issue #27.
   */
  countByState: (filter?: CountFilter) => Promise<Record<JobState, number>>;
  /**
   * Job counts by queue. All-time chronicle count by default (includes deleted
   * jobs); pass `{ live: true }` for live `pgboss.job` queue depth. See issue #27.
   */
  countByQueue: (filter?: CountFilter) => Promise<Record<string, number>>;
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
   * Write a job's claim owner (e.g. the worker that pulled it) to its current
   * attempt's `claimed_by`. Per-attempt, so a retry's owner is recorded
   * separately. Useful when an external pull-worker must prove ownership of an
   * active job (the consumer reads it back via {@link getClaim} to authorize
   * progress/complete/fail). Fail-open; throws only if `ownerId` isn't a
   * non-empty string.
   */
  setClaim: (jobId: string, ownerId: string) => Promise<void>;
  /**
   * Read a job's claim owner — the `claimed_by` of its current (latest)
   * attempt, matching where {@link BossierMethods.setClaim} writes. `null` if
   * the current attempt was never claimed, or the job is unknown. Scoped to the
   * current attempt so a stale owner from a prior retried attempt can't satisfy
   * an owner-equality authz check.
   */
  getClaim: (jobId: string) => Promise<string | null>;
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
  /**
   * A job's current LIVE runtime state from pg-boss (heartbeat, expiry, …) with
   * provenance (`livePresent` / `liveReadAt` / `recordState`). Non-forensic —
   * "what pg-boss says now", not history. `null` if the job is unknown.
   */
  getLiveState: <T = unknown>(jobId: string) => Promise<LiveState<T> | null>;
  /** A job's live heartbeat timestamp from pg-boss, or `null` if no live row exists. */
  getLiveHeartbeat: (jobId: string) => Promise<Date | null>;
  /**
   * Batched live heartbeat read — one query for many jobs, to avoid an N+1 loop
   * of per-row {@link getLiveHeartbeat} on a dashboard (issue #34). Returns a
   * `Map` keyed by every requested id (`Date`, or `null` for no live row /
   * malformed id). LIVE and non-forensic, like {@link getLiveHeartbeat}.
   */
  getLiveHeartbeats: (jobIds: string[]) => Promise<Map<string, Date | null>>;
  /**
   * A capture-health snapshot: chronicle freshness (`lastCapturedSeq` /
   * `lastCapturedAt`) plus a bounded coverage check (`checked` / `missing`) for
   * detecting silent fail-open capture drift. Observability only — capture stays
   * fail-open. See issue #31.
   *
   * Pass `{ coverage: false }` for a cheap **freshness-only** snapshot (#43) that
   * skips the expensive coverage scan over `pgboss.job` — suitable for frequent
   * polling; `checked` / `missing` come back `null`.
   */
  captureHealth: (
    opts?: { sampleLimit?: number; coverage?: boolean },
  ) => Promise<CaptureHealth>;
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
  'sendTracked',
  'recordTerminalDetail',
  'recordDeadLetter', 'findDeadLetterSource', 'findDeadLetterTarget',
  'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
  'setProgress', 'getProgress',
  'setClaim', 'getClaim',
  'recordInputSnapshot', 'getInputSnapshot',
  'subscribeEvents', 'getEventsSince',
  'getLiveState', 'getLiveHeartbeat', 'getLiveHeartbeats',
  'captureHealth',
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
    sendTracked: (queue, data, options) => {
      const id = options?.id ?? randomUUID();
      // One call pins the id and stamps the breadcrumb, so the two halves of the
      // lineage contract can never disagree. boss.send returns the pinned id
      // (or null on a singleton dedup).
      return boss.send(
        queue,
        { ...data, [DEAD_LETTER_ID_FIELD]: id },
        { ...options, id },
      );
    },
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
    setClaim: (jobId, ownerId) => setClaim(db, s, jobId, ownerId),
    getClaim: (jobId) => getClaim(db, s, jobId),
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
    getLiveState: <T = unknown>(jobId: string) => getLiveState<T>(boss, db, s, jobId),
    getLiveHeartbeat: (jobId) => getLiveHeartbeat(boss, db, s, jobId),
    getLiveHeartbeats: (jobIds) => getLiveHeartbeats(db, s, jobIds),
    captureHealth: (opts) => captureHealth(db, s, opts),
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

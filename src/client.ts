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
import { softReadDb, isBossierInstalled } from './installed.js';
import { migrate } from './install.js';
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
  /**
   * Provision pg-bossier's schema at startup (#39). When `true`, `bossier()`
   * eagerly runs the idempotent, additive, transactional {@link migrate} once —
   * mirroring how pg-boss migrates itself at `boss.start()` — so a fresh env or
   * a forgotten `migrate` after a dep bump can't leave the now-load-bearing
   * chronicle un-provisioned. The DDL is `IF NOT EXISTS` / `CREATE OR REPLACE`
   * inside `BEGIN/COMMIT`, so concurrent instances racing to migrate is a safe
   * no-op for the losers.
   *
   * **Requires a real `pool`** (the transactional installer needs
   * `pool.connect()` — a BYO `db`/ORM adapter can't run `BEGIN/COMMIT` on a
   * dedicated session); `bossier()` throws synchronously if `autoMigrate: true`
   * without one. The constructor stays sync — the migration runs in the
   * background; `await client.ensureInstalled()` for a hard barrier before the
   * first job. Default `false` (keep the explicit `install()`/`migrate()` /
   * CLI path).
   */
  autoMigrate?: boolean;
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
   * Claim a job's current attempt for `ownerId` — compare-and-set (#41a).
   * Writes `claimed_by` only if the current attempt is unclaimed or already owned
   * by `ownerId`, and resolves to whether `ownerId` holds the claim afterwards:
   * `true` = won/owns it, `false` = lost to another owner (or unknown job / not
   * installed). Idempotent for the owner. Lets a pull-worker treat the marker as
   * authoritative (two racers → exactly one `true`) without relying on pg-boss's
   * `fetch()` to serialize claimants. Per-attempt, so a retry's owner is recorded
   * separately. Fail-open; throws only if `ownerId` isn't a non-empty string.
   */
  setClaim: (jobId: string, ownerId: string) => Promise<boolean>;
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
  /**
   * Is pg-bossier installed? A cheap `to_regclass` probe (#40) — call it at
   * startup to fail loudly/clearly instead of cryptically at first read. `false`
   * when the schema/table is absent (not yet `install()`-ed / `migrate()`-d).
   * The client's *read* methods are fail-soft against a missing install (return
   * empty + warn once), symmetric with the fail-open writes — this is the
   * explicit probe to gate on.
   *
   * Named `isBossierInstalled` (not `isInstalled`) so it doesn't shadow pg-boss's
   * own `isInstalled()` — that one (pg-boss's schema) stays reachable through the
   * client.
   */
  isBossierInstalled: () => Promise<boolean>;
  /**
   * Ensure pg-bossier's schema is installed, running the idempotent {@link migrate}
   * **once** and resolving when it has (#39). Safe to call (and `await`) any
   * number of times — concurrent calls share the one in-flight migration; a
   * successful migration is cached; a *failed* one is not, so a later call
   * retries (e.g. after a transient startup DB blip). With `autoMigrate: true`
   * this already runs in the background at construction — `await ensureInstalled()`
   * to block until the schema is ready before enqueuing/working the first job.
   *
   * **Requires a real `pool`** (transactional installer); rejects with a clear
   * error otherwise. This is the only schema-write method on the client — reads
   * stay fail-soft and writes fail-open regardless.
   */
  ensureInstalled: () => Promise<void>;
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
  'isBossierInstalled', 'ensureInstalled',
] as const satisfies readonly (keyof BossierMethods)[];

/** `subscribeEvents` needs a real pg connection an ORM adapter can't provide. */
const SUBSCRIBE_EVENTS_NEEDS_POOL =
  'pgbossier: subscribeEvents requires a `pool` — LISTEN/NOTIFY needs a ' +
  'dedicated pg connection that ORM adapters do not expose. Construct the ' +
  'client as bossier({ boss, pool }).';

/** `autoMigrate`/`ensureInstalled` need a real pg connection the transactional installer can use. */
const AUTO_MIGRATE_NEEDS_POOL =
  'pgbossier: autoMigrate/ensureInstalled requires a `pool` — the transactional ' +
  'installer needs pool.connect() for BEGIN/COMMIT, which a BYO db/ORM adapter ' +
  'does not expose. Construct the client as bossier({ boss, pool }), or run ' +
  'install()/migrate() out of band.';

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
  // Reads route through a fail-soft wrapper: a query against an uninstalled
  // pgbossier schema degrades to empty instead of 500ing the host (#40). Writes
  // keep the raw `db` (they have their own fail-open try/catch).
  const readDb: BossierDb = softReadDb(db);
  const s: SchemaNames = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });

  // #39: opt-in startup provisioning. ensureInstalled() runs migrate() once via
  // a cached promise; a *failed* migration clears the cache so a later call can
  // retry (transient startup DB blip). Needs a real pool — the transactional
  // installer uses pool.connect().
  let ensurePromise: Promise<void> | undefined;
  const ensureInstalled = (): Promise<void> => {
    if (pool === undefined) return Promise.reject(new Error(AUTO_MIGRATE_NEEDS_POOL));
    ensurePromise ??= migrate(pool, {
      schema: options.schema, pgbossSchema: options.pgbossSchema,
    }).catch((err: unknown) => {
      ensurePromise = undefined; // failed → allow a retry on the next call
      throw err;
    });
    return ensurePromise;
  };
  if (options.autoMigrate === true) {
    // Fail fast: autoMigrate without a pool is a programmer error.
    if (pool === undefined) throw new Error(AUTO_MIGRATE_NEEDS_POOL);
    // Kick the migration off now; the constructor stays sync. Swallow the
    // rejection here so it isn't unhandled — an awaiter of ensureInstalled()
    // still sees it (same cached promise), and reads are fail-soft meanwhile.
    void ensureInstalled().catch((err: unknown) => {
      console.warn(
        `pgbossier: autoMigrate failed at startup: ${String(err)}. Reads stay ` +
        `fail-soft; await ensureInstalled() to observe/retry.`,
      );
    });
  }

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
    findDeadLetterSource: (dlqJobId) => findDeadLetterSource(readDb, s, dlqJobId),
    findDeadLetterTarget: (sourceJobId) => findDeadLetterTarget(readDb, s, sourceJobId),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(readDb, s, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(readDb, s, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(readDb, s, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(readDb, s, queues, opts),
    countByState: (filter) => countByState(readDb, s, filter),
    countByQueue: (filter) => countByQueue(readDb, s, filter),
    listLongRunning: (opts) => listLongRunning(readDb, s, opts),
    setProgress: (jobId, progress) => setProgress(db, s, jobId, progress),
    getProgress: <TProgress = unknown>(jobId: string) =>
      getProgress<TProgress>(readDb, s, jobId),
    setClaim: (jobId, ownerId) => setClaim(db, s, jobId, ownerId),
    getClaim: (jobId) => getClaim(readDb, s, jobId),
    isBossierInstalled: () => isBossierInstalled(db, s),
    ensureInstalled,
    recordInputSnapshot: (jobId, attempt, snapshot) =>
      recordInputSnapshot(db, s, jobId, attempt, snapshot),
    // Overloaded: dispatch at the call site to land on each of the underlying
    // free function's two public overloads. `attempt === undefined` → the
    // wrapped-result overload; otherwise → the `T | null` overload.
    getInputSnapshot: <T = unknown>(jobId: string, attempt?: number) =>
      attempt === undefined
        ? getInputSnapshot<T>(readDb, s, jobId)
        : getInputSnapshot<T>(readDb, s, jobId, attempt),
    subscribeEvents: (opts) =>
      pool === undefined
        ? Promise.reject(new Error(SUBSCRIBE_EVENTS_NEEDS_POOL))
        : subscribeEvents(pool, s, opts),
    getEventsSince: <TInput = unknown, TOutput = unknown>(
      since: bigint, limit?: number,
    ) => getEventsSince<TInput, TOutput>(readDb, s, since, limit),
    getLiveState: <T = unknown>(jobId: string) => getLiveState<T>(boss, readDb, s, jobId),
    getLiveHeartbeat: (jobId) => getLiveHeartbeat(boss, readDb, s, jobId),
    getLiveHeartbeats: (jobIds) => getLiveHeartbeats(readDb, s, jobIds),
    captureHealth: (opts) => captureHealth(readDb, s, opts),
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

import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import type { SchemaNames } from '../../src/sql.js';
import type { Bossier } from '../../src/client.js';
import type { JobState } from '../../src/read.js';

// ──────────────────────────────────────────────────────────────────────────
// Seeded PRNG — mulberry32. Reproduces the job PLAN SET, not the execution
// interleaving (see spec "Reproducibility — and its honest boundary").
// ──────────────────────────────────────────────────────────────────────────
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number; // inclusive both ends
  pick<T>(arr: readonly T[]): T;
  chance(p: number): boolean;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  return {
    next: r,
    int,
    pick: <T>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new RangeError('pick: empty array');
      return arr[int(0, arr.length - 1)]!;
    },
    chance: (p: number): boolean => r() < p,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Workload planner. The seed fixes the plan set; outcomes are derived so the
// per-job oracle is exact (see spec "Core idea: an oracle, with bounded
// exactness").
// ──────────────────────────────────────────────────────────────────────────
export type Pattern = 'push' | 'pull';
export type Outcome = 'complete' | 'retryThenComplete' | 'exhaust' | 'cancel';
export type TerminalState = 'completed' | 'failed' | 'cancelled';

export interface QueueDef {
  name: string;
  pattern: Pattern;
}

export interface PlannedJob {
  key: string;
  queue: string;
  pattern: Pattern;
  retryLimit: number;
  priority: number;
  singletonKey: string;
  outcome: Outcome;
  /** Attempts (0-based count) that fail before the terminal attempt. */
  plannedFails: number;
  /** 0, or a small positive delay for the sendAfter (scheduled) shape. */
  delaySeconds: number;
  expectedAttempts: number;
  expectedTerminalState: TerminalState;
  /** Final state of each attempt row, oldest-first; length === expectedAttempts. */
  expectedAttemptStates: JobState[];
}

function expectedFor(
  outcome: Outcome,
  retryLimit: number,
  plannedFails: number,
): Pick<PlannedJob, 'expectedAttempts' | 'expectedTerminalState' | 'expectedAttemptStates'> {
  switch (outcome) {
    case 'complete':
      return { expectedAttempts: 1, expectedTerminalState: 'completed', expectedAttemptStates: ['completed'] };
    case 'cancel':
      return { expectedAttempts: 1, expectedTerminalState: 'cancelled', expectedAttemptStates: ['cancelled'] };
    case 'retryThenComplete':
      return {
        expectedAttempts: plannedFails + 1,
        expectedTerminalState: 'completed',
        expectedAttemptStates: [...Array<JobState>(plannedFails).fill('retry'), 'completed'],
      };
    case 'exhaust':
      return {
        expectedAttempts: retryLimit + 1,
        expectedTerminalState: 'failed',
        expectedAttemptStates: [...Array<JobState>(retryLimit).fill('retry'), 'failed'],
      };
  }
}

export function planWorkload(rng: Rng, opts: { n: number; queues: readonly QueueDef[] }): PlannedJob[] {
  const OUTCOMES: Outcome[] = ['complete', 'retryThenComplete', 'exhaust', 'cancel'];
  const jobs: PlannedJob[] = [];
  for (let i = 0; i < opts.n; i++) {
    const queue = rng.pick(opts.queues);
    const retryLimit = rng.int(0, 3);
    let outcome = rng.pick(OUTCOMES);
    // retryThenComplete needs at least one retry available.
    if (outcome === 'retryThenComplete' && retryLimit === 0) outcome = 'complete';

    let plannedFails: number;
    if (outcome === 'retryThenComplete') plannedFails = rng.int(1, retryLimit);
    else if (outcome === 'exhaust') plannedFails = retryLimit + 1;
    else plannedFails = 0;

    // Only the plain-complete shape may be delayed (keeps the scheduled path
    // free of retry/cancel interactions). Short delay → no wall-clock CI cost.
    const delaySeconds = outcome === 'complete' && rng.chance(0.15) ? 1 : 0;

    jobs.push({
      key: `j${i}`,
      queue: queue.name,
      pattern: queue.pattern,
      retryLimit,
      priority: rng.int(0, 5),
      singletonKey: `sk-${i}`, // unique → no dedup in the randomized body
      outcome,
      plannedFails,
      delaySeconds,
      ...expectedFor(outcome, retryLimit, plannedFails),
    });
  }
  return jobs;
}

// ──────────────────────────────────────────────────────────────────────────
// Drivers apply the plan to the job they RECEIVE, keyed on attempt index — the
// debate's linchpin (spec Decision 2). `attemptIndex` is the count of prior
// handler/fetch invocations for that job id, NOT an assumed identity.
// ──────────────────────────────────────────────────────────────────────────
export function decideAction(plan: PlannedJob, attemptIndex: number): 'fail' | 'complete' {
  return attemptIndex < plan.plannedFails ? 'fail' : 'complete';
}

// Transient Postgres / connection errors that a driver op should retry rather
// than treat as a changed outcome (spec Decision 3).
const TRANSIENT_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
  '57014', // query_canceled
  '57P01', // admin_shutdown (pg_terminate_backend)
  '08000', '08001', '08003', '08004', '08006', '08007', // connection exceptions (08xxx)
  '53300', // too_many_connections
]);

export function isTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string'
    && /terminat|reset by peer|ECONNRESET|connection (closed|ended|refused|terminated)/i.test(msg);
}

// ──────────────────────────────────────────────────────────────────────────
// Oracle comparison core (pure). Per-job-id facts are exact; the integration
// layer feeds DB rows in. Cross-job ordering/timestamps are NEVER compared
// (spec Decision 4).
// ──────────────────────────────────────────────────────────────────────────
export interface PerAttempt {
  attempt: number;
  state: JobState;
  priority: number | null;
  retryLimit: number | null;
  singletonKey: string | null;
  dataJson: string;
}

export function diffChronicle(rows: PerAttempt[], plan: PlannedJob): string[] {
  const errs: string[] = [];
  if (rows.length !== plan.expectedAttempts) {
    errs.push(`attempts: expected ${plan.expectedAttempts}, got ${rows.length}`);
  }
  for (let i = 0; i < plan.expectedAttemptStates.length; i++) {
    const want = plan.expectedAttemptStates[i];
    const got = rows[i]?.state;
    if (got !== want) errs.push(`attempt[${i}] state: expected ${want}, got ${got ?? 'MISSING'}`);
  }
  const first = rows[0];
  if (first) {
    const wantData = JSON.stringify({ key: plan.key });
    if (first.dataJson !== wantData) errs.push(`data: expected ${wantData}, got ${first.dataJson}`);
    if (first.priority !== plan.priority) errs.push(`priority: expected ${plan.priority}, got ${first.priority}`);
    if (first.retryLimit !== plan.retryLimit) errs.push(`retryLimit: expected ${plan.retryLimit}, got ${first.retryLimit}`);
    if (first.singletonKey !== plan.singletonKey) errs.push(`singletonKey: expected ${plan.singletonKey}, got ${first.singletonKey}`);
  }
  return errs;
}

export function findGlobalViolations(rows: { jobId: string; attempt: number; seq: bigint }[]): string[] {
  const errs: string[] = [];
  const pk = new Set<string>();
  let dupPk = 0;
  for (const r of rows) {
    const k = `${r.jobId}#${r.attempt}`;
    if (pk.has(k)) dupPk++;
    pk.add(k);
  }
  if (dupPk > 0) errs.push(`dup PK: ${dupPk} duplicate (job_id, attempt) row(s)`);

  const seqSet = new Set(rows.map((r) => r.seq.toString()));
  if (seqSet.size !== rows.length) {
    errs.push(`seq not distinct: ${rows.length - seqSet.size} collision(s)`);
  }
  return errs;
}

export interface RunInfo {
  seed: number;
  n: number;
  workers: number;
  phase: string;
}

export function fingerprint(info: RunInfo, jobId: string, plan: PlannedJob, errs: string[]): string {
  return [
    `BATTLE FAILURE [phase=${info.phase}]`,
    `  seed=${info.seed} n=${info.n} workers=${info.workers}`,
    `  jobId=${jobId} key=${plan.key} queue=${plan.queue} pattern=${plan.pattern}`,
    `  outcome=${plan.outcome} retryLimit=${plan.retryLimit} plannedFails=${plan.plannedFails} delaySeconds=${plan.delaySeconds}`,
    `  replay: BATTLE_SEED=${info.seed} BATTLE_ONLY_JOB=${jobId} npx vitest run test/battle/battle.test.ts`,
    ...errs.map((e) => `  ✗ ${e}`),
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────────
// IO layer. Drivers act on the job they RECEIVE; transient errors retry with
// read-back reconciliation.
// ──────────────────────────────────────────────────────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientError(err)) throw err;
      lastErr = err;
      await sleep(50 * (i + 1));
    }
  }
  throw lastErr;
}

export async function createQueues(boss: PgBoss, queues: readonly QueueDef[]): Promise<void> {
  for (const q of queues) await boss.createQueue(q.name);
}

export async function sendWorkload(boss: PgBoss, jobs: readonly PlannedJob[]): Promise<Map<string, PlannedJob>> {
  const byId = new Map<string, PlannedJob>();
  for (const job of jobs) {
    const opts: PgBoss.SendOptions = {
      retryLimit: job.retryLimit,
      retryDelay: 0, // retries are immediately re-fetchable → fast, deterministic
      priority: job.priority,
      singletonKey: job.singletonKey,
    };
    const id = job.delaySeconds > 0
      ? await boss.sendAfter(job.queue, { key: job.key }, opts, job.delaySeconds)
      : await boss.send(job.queue, { key: job.key }, opts);
    if (!id) throw new Error(`battle: send returned null for ${job.key} (unexpected singletonKey collision)`);
    byId.set(id, job);
  }
  return byId;
}

export async function cancelPlanned(boss: PgBoss, byId: Map<string, PlannedJob>): Promise<void> {
  // Cancel from 'created' before any worker/driver runs → deterministic
  // created→cancelled, no race (spec Drivers / Phase A).
  for (const [id, job] of byId) {
    if (job.outcome === 'cancel') await boss.cancel(job.queue, id);
  }
}

export function makePushHandler(
  byId: Map<string, PlannedJob>,
  attemptsSeen: Map<string, number>,
): (jobs: PgBoss.Job[]) => Promise<{ ok: true }> {
  // batchSize defaults to 1, so `jobs` holds one job per call; throwing fails
  // exactly that job (auto-retry if retries remain), returning auto-completes it.
  return async (jobs: PgBoss.Job[]): Promise<{ ok: true }> => {
    for (const job of jobs) {
      const plan = byId.get(job.id);
      if (!plan) continue; // not part of our workload
      const idx = attemptsSeen.get(job.id) ?? 0;
      attemptsSeen.set(job.id, idx + 1);
      if (decideAction(plan, idx) === 'fail') {
        throw new Error(`battle: planned fail ${plan.key} attempt ${idx}`);
      }
    }
    return { ok: true };
  };
}

async function alreadyAdvanced(pool: Pool, schemas: SchemaNames, jobId: string): Promise<boolean> {
  // Read-back reconciliation: an ambiguous commit (ack lost after Postgres
  // committed) shows the job already off 'active'. Treat as applied (Decision 3).
  const { rows } = await pool.query<{ state: string }>(
    `SELECT state FROM ${schemas.pgboss}.job WHERE id = $1`, [jobId],
  );
  return rows.length === 0 || rows[0]!.state !== 'active';
}

export async function runPullDriver(
  boss: PgBoss,
  pool: Pool,
  schemas: SchemaNames,
  queue: string,
  byId: Map<string, PlannedJob>,
  attemptsSeen: Map<string, number>,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const batch = await withRetry(() => boss.fetch(queue, { batchSize: 10 }));
    if (!batch || batch.length === 0) { await sleep(50); continue; }
    for (const job of batch) {
      const plan = byId.get(job.id);
      if (!plan) { await boss.complete(queue, job.id); continue; }
      const idx = attemptsSeen.get(job.id) ?? 0;
      attemptsSeen.set(job.id, idx + 1);
      const act = decideAction(plan, idx);
      try {
        if (act === 'fail') await boss.fail(queue, job.id, { err: `planned ${idx}` });
        else await boss.complete(queue, job.id, { ok: true });
      } catch (err) {
        if (!isTransientError(err)) throw err;
        if (await alreadyAdvanced(pool, schemas, job.id)) continue;
        await withRetry(() => (act === 'fail'
          ? boss.fail(queue, job.id, { err: `planned ${idx}` })
          : boss.complete(queue, job.id, { ok: true })));
      }
    }
  }
}

export async function waitForDrain(
  pool: Pool, schemas: SchemaNames, queues: readonly string[], deadlineMs: number,
): Promise<void> {
  const start = Date.now();
  let stable = 0;
  while (Date.now() - start < deadlineMs) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${schemas.pgbossier}.record
       WHERE queue = ANY($1) AND state IN ('created', 'active')`,
      [queues],
    );
    if (rows[0]!.n === '0') {
      if (++stable >= 3) return; // stable across 3 polls → drained
    } else {
      stable = 0;
    }
    await sleep(100);
  }
  throw new Error(`battle: workload did not drain within ${deadlineMs}ms`);
}

export async function collectAllRows(
  pool: Pool, schemas: SchemaNames, queues: readonly string[],
): Promise<{ jobId: string; attempt: number; seq: bigint }[]> {
  const { rows } = await pool.query<{ job_id: string; attempt: number; seq: string }>(
    `SELECT job_id, attempt, seq FROM ${schemas.pgbossier}.record WHERE queue = ANY($1)`,
    [queues],
  );
  return rows.map((r) => ({ jobId: r.job_id, attempt: r.attempt, seq: BigInt(r.seq) }));
}

export async function assertWorkload(
  client: Bossier,
  pool: Pool,
  schemas: SchemaNames,
  byId: Map<string, PlannedJob>,
  queues: readonly string[],
  info: RunInfo,
): Promise<void> {
  const only = process.env['BATTLE_ONLY_JOB'];
  const failures: string[] = [];

  for (const [id, plan] of byId) {
    if (only && only !== id) continue;
    const hist = await client.getRetryHistory(id);
    const rows: PerAttempt[] = hist.map((h) => ({
      attempt: h.attempt,
      state: h.state,
      priority: h.priority,
      retryLimit: h.retryLimit,
      singletonKey: h.singletonKey,
      dataJson: JSON.stringify(h.data),
    }));
    const errs = diffChronicle(rows, plan);
    if (errs.length) failures.push(fingerprint(info, id, plan, errs));
  }

  const globalErrs = findGlobalViolations(await collectAllRows(pool, schemas, queues));
  if (globalErrs.length) {
    failures.push(`BATTLE GLOBAL INVARIANT [phase=${info.phase}] seed=${info.seed}\n`
      + globalErrs.map((e) => `  ✗ ${e}`).join('\n'));
  }

  if (failures.length) throw new Error(`\n${failures.join('\n\n')}`);
}

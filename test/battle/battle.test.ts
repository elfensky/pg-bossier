import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../harness.js';
import { install } from '../../src/install.js';
import { bossier, type Bossier } from '../../src/client.js';
import { resolveSchemas } from '../../src/sql.js';
import * as battle from './engine.js';

const SCHEMAS = resolveSchemas();

const SEED = process.env['BATTLE_SEED'] === 'random'
  ? Math.floor(Math.random() * 2 ** 31)
  : Number(process.env['BATTLE_SEED'] ?? 0xc0ffee);
// Scale knob. Default 200 is the CI gate size. Raising BATTLE_N past ~2,500 hits
// two ceilings: sendWorkload sends serially (setup slows), and assertEventsCatchUp's
// getEventsSince read caps at 10,000 rows (≈2,500 jobs × up to 4 attempts) — beyond
// that the catch-up stream truncates and the events check can spuriously report
// missing terminals. For larger soak runs, batch the sends and page getEventsSince.
const N = Number(process.env['BATTLE_N'] ?? 200);
const WORKERS = 5;
const QUEUES: battle.QueueDef[] = [
  { name: 'battle-push-1', pattern: 'push' },
  { name: 'battle-push-2', pattern: 'push' },
  { name: 'battle-push-3', pattern: 'push' },
  { name: 'battle-pull-1', pattern: 'pull' },
  { name: 'battle-pull-2', pattern: 'pull' },
];
const QNAMES = QUEUES.map((q) => q.name);

// Shared across the A/B/C sweep below.
let byId: Map<string, battle.PlannedJob>;

let h: Harness;
let client: Bossier;

beforeAll(async () => {
  h = await startHarness();
  await install(h.pool);
  client = bossier({ boss: h.boss, pool: h.pool });
  console.log(`[battle] seed=${SEED} n=${N} workers=${WORKERS}`);
}, 180_000);

afterAll(async () => { await h.teardown(); });

test('Phase A — concurrency storm: per-job chronicle is faithful', async () => {
  const jobs = battle.planWorkload(battle.makeRng(SEED), { n: N, queues: QUEUES });
  await battle.createQueues(h.boss, QUEUES);
  byId = await battle.sendWorkload(h.boss, jobs);
  await battle.cancelPlanned(h.boss, byId);

  const attemptsSeen = new Map<string, number>();
  for (const q of QUEUES.filter((q) => q.pattern === 'push')) {
    await h.boss.work(q.name, { pollingIntervalSeconds: 0.5, localConcurrency: WORKERS },
      battle.makePushHandler(byId, attemptsSeen));
  }
  const ac = new AbortController();
  const pullers = QUEUES.filter((q) => q.pattern === 'pull')
    .map((q) => battle.runPullDriver(h.boss, h.pool, SCHEMAS, q.name, byId, attemptsSeen, ac.signal));

  await battle.waitForDrain(h.pool, SCHEMAS, QNAMES, 90_000);
  ac.abort();
  await Promise.allSettled(pullers);
  for (const q of QUEUES.filter((q) => q.pattern === 'push')) await h.boss.offWork(q.name);

  await battle.assertWorkload(client, h.pool, SCHEMAS, byId, QNAMES,
    { seed: SEED, n: N, workers: WORKERS, phase: 'A' });
  await battle.assertEventsCatchUp(client, byId);
}, 180_000);

test('Phase B — forensic survival after pgboss.job rows are deleted', async () => {
  expect(byId.size).toBeGreaterThan(0); // depends on Phase A having run
  // Sample up to 20 completed jobs from the workload.
  const sample = [...byId.entries()]
    .filter(([, p]) => p.expectedTerminalState === 'completed')
    .slice(0, 20)
    .map(([id]) => id);
  expect(sample.length).toBeGreaterThan(0);

  const deleted = await battle.forensicDelete(h.pool, SCHEMAS, sample);
  expect(deleted).toBe(sample.length);

  for (const id of sample) {
    const job = await client.findById(id);
    expect(job, `findById(${id}) after delete`).not.toBeNull();
    const plan = byId.get(id)!;
    const hist = await client.getRetryHistory(id);
    expect(hist).toHaveLength(plan.expectedAttempts);
    expect(hist.at(-1)!.state).toBe('completed');
    expect(hist[0]!.data).toEqual({ key: plan.key });
  }
}, 60_000);

test('Phase C — fail-open: pg-boss ops never block while the audit path is broken', async () => {
  const q = 'battle-failopen';
  await h.boss.createQueue(q);

  // During the outage, drive a batch end-to-end and assert NOTHING throws.
  const outageIds = await battle.withAuditOutage(h.pool, SCHEMAS, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = await h.boss.send(q, { key: `outage-${i}` });
      ids.push(id!);
    }
    // Drive every job to completion DURING the outage. send/fetch/complete all
    // fire the (renamed-away) capture trigger and must not throw — that is the
    // fail-open contract. Bounded so a stall can't hang the test.
    let drained = 0;
    for (let guard = 0; drained < ids.length && guard < 200; guard++) {
      const batch = await h.boss.fetch(q, { batchSize: 20 });
      if (!batch || batch.length === 0) { await new Promise((r) => setTimeout(r, 50)); continue; }
      for (const j of batch) { await h.boss.complete(q, j.id, { ok: true }); drained++; }
    }
    expect(drained).toBe(ids.length);
    return ids;
  });
  expect(outageIds).toHaveLength(15);

  // After restore, a fresh job gets a complete, faithful chronicle (recovery).
  const freshId = await h.boss.send(q, { key: 'after-restore' });
  const got = await h.boss.fetch(q);
  expect(got && got.length).toBeTruthy();
  await h.boss.complete(q, freshId!, { ok: true });

  const hist = await client.getRetryHistory(freshId!);
  expect(hist.at(-1)!.state).toBe('completed');
  expect(hist[0]!.data).toEqual({ key: 'after-restore' });
}, 60_000);

const FULL = process.env['BATTLE_CHAOS_FULL'] === '1';

test.runIf(FULL)('Phase D — connection kill: chronicle stays consistent + recovers', { retry: 2 }, async () => {
  const QD: battle.QueueDef[] = [{ name: 'battle-killA', pattern: 'pull' }, { name: 'battle-killB', pattern: 'push' }];
  const QDN = QD.map((q) => q.name);
  const jobs = battle.planWorkload(battle.makeRng(SEED + 1), { n: 60, queues: QD });
  await battle.createQueues(h.boss, QD);
  const local = await battle.sendWorkload(h.boss, jobs);
  await battle.cancelPlanned(h.boss, local);

  const attemptsSeen = new Map<string, number>();
  await h.boss.work('battle-killB', { pollingIntervalSeconds: 0.5, localConcurrency: WORKERS },
    battle.makePushHandler(local, attemptsSeen));
  const ac = new AbortController();
  const puller = battle.runPullDriver(h.boss, h.pool, SCHEMAS, 'battle-killA', local, attemptsSeen, ac.signal);

  // Kill backends a few times mid-storm.
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 400));
    await battle.killBackends(h.pool).catch(() => 0); // the kill may sever its own ack
  }

  // Best-effort settle — outcomes are NOT asserted under kill (Decision 6).
  await battle.waitForDrain(h.pool, SCHEMAS, QDN, 90_000).catch(() => { /* contract-only below */ });
  ac.abort();
  await Promise.allSettled([puller]);
  await h.boss.offWork('battle-killB');

  // Contract: no chronicle corruption (no dup PK / non-distinct seq).
  const violations = battle.findGlobalViolations(await battle.collectAllRows(h.pool, SCHEMAS, QDN));
  expect(violations, violations.join('; ')).toEqual([]);

  // Recovery: a fresh job after the storm is captured normally.
  const rq = 'battle-kill-recover';
  await h.boss.createQueue(rq);
  const rid = await h.boss.send(rq, { key: 'recovered' });
  await h.boss.fetch(rq);
  await h.boss.complete(rq, rid!, { ok: true });
  const hist = await client.getRetryHistory(rid!);
  expect(hist.at(-1)!.state).toBe('completed');
}, 180_000);

test('mini — singleton dedup collapses same-key sends to one job', async () => {
  const q = 'battle-singleton';
  // 'short' policy: unique index on (name, singletonKey) in 'created' state —
  // guarantees the second send with the same key is deduped (returns null).
  await h.boss.createQueue(q, { policy: 'short' });
  const id1 = await h.boss.send(q, {}, { singletonKey: 'dup' });
  const id2 = await h.boss.send(q, {}, { singletonKey: 'dup' });
  expect(id1).toBeTruthy();
  expect(id2).toBeNull(); // deduped
  expect(await client.getRetryHistory(id1!)).toHaveLength(1);
}, 60_000);

test('mini — dead-letter lineage round-trips via recordDeadLetter', async () => {
  const src = 'battle-dlq-src';
  const dlq = 'battle-dlq-dead';
  await h.boss.createQueue(dlq);
  await h.boss.createQueue(src, { deadLetter: dlq });

  const srcId = await h.boss.send(src, { key: 'dlq' }, { retryLimit: 0 });
  await h.boss.fetch(src);
  await h.boss.fail(src, srcId!, { err: 'boom' });
  await new Promise((r) => setTimeout(r, 300)); // let pg-boss enqueue the DLQ job

  const { rows } = await h.pool.query<{ id: string }>(
    `SELECT id FROM ${SCHEMAS.pgboss}.job WHERE name = $1 ORDER BY created_on DESC LIMIT 1`, [dlq],
  );
  expect(rows).toHaveLength(1);
  const dlqId = rows[0]!.id;

  await client.recordDeadLetter({ sourceJobId: srcId!, dlqJobId: dlqId });
  expect(await client.findDeadLetterTarget(srcId!)).toMatchObject({ dlqJobId: dlqId });
  expect(await client.findDeadLetterSource(dlqId)).toMatchObject({ jobId: srcId! });
}, 60_000);

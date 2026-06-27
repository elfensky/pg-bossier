// High-VOLUME lifecycle storm — pushes 10k–1M REAL jobs through pg-boss
// (create → fetch → complete/fail/retry/cancel) in a single concurrent pass, to
// surface backlog / memory / lock-contention problems the bounded battle+soak
// path (capped ~2000/iteration by its serial send + per-job oracle) can't.
//
// Modelled on the perf bench: scale via BATTLE_STORM_N (default 0 = skipped, so
// the regular suite pays nothing — like soak.test.ts). The battle-storm.yml
// workflow runs a sane default on PRs and a big 1M on demand before a release.
//
//   BATTLE_STORM_N=10000 npm run test:storm     # local
//
// Knobs: BATTLE_STORM_WORKERS (concurrent pull drivers, default 8),
// BATTLE_STORM_BATCH (fetch batch size, default 100), BATTLE_SEED.
//
// What makes it scale where battle can't: bulk create (boss.insert, chunked),
// the planned outcome encoded IN each job's data (no in-memory per-job map), and
// a single aggregate SQL oracle instead of one query per job (see engine.ts
// bulkSendWorkload / runStormDriver / assertStormSql).
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../harness.js';
import { install } from '../../src/install.js';
import { bossier, type Bossier } from '../../src/client.js';
import { resolveSchemas } from '../../src/sql.js';
import * as battle from './engine.js';

const SCHEMAS = resolveSchemas();

const N = Number(process.env['BATTLE_STORM_N'] ?? 0);
const WORKERS = Number(process.env['BATTLE_STORM_WORKERS'] ?? 8);
const BATCH = Number(process.env['BATTLE_STORM_BATCH'] ?? 100);
const SEED = process.env['BATTLE_SEED'] === 'random'
  ? Math.floor(Math.random() * 2 ** 31)
  : Number(process.env['BATTLE_SEED'] ?? 0xc0ffee);

const QUEUES: battle.QueueDef[] = [
  { name: 'storm-1', pattern: 'pull' },
  { name: 'storm-2', pattern: 'pull' },
  { name: 'storm-3', pattern: 'pull' },
  { name: 'storm-4', pattern: 'pull' },
];

// Scale the time budgets with N. Calibrated from a local 10k run (~5s test
// time, ~2k jobs/s end-to-end): 1M extrapolates to ~10-20 min. These are
// generous ceilings that stay under battle-storm.yml's 75-min workflow cap
// (1M → drain 50 min, test 66 min).
const DRAIN_MS = Math.max(120_000, N * 3);
const TEST_MS = Math.max(300_000, N * 4);

let h: Harness | undefined;
let client: Bossier | undefined;

beforeAll(async () => {
  if (N <= 0) return; // skipped run → don't boot a container
  h = await startHarness();
  await install(h.pool);
  client = bossier({ boss: h.boss, pool: h.pool });
  console.log(`[storm] seed=${SEED} n=${N} workers=${WORKERS} batch=${BATCH}`);
}, 180_000);

afterAll(async () => { if (h) await h.teardown(); });

test.runIf(N > 0)('storm — N jobs through the full lifecycle, verified by one SQL oracle', async () => {
  if (!h || !client) throw new Error('storm: harness not initialized');
  const H = h;
  const C = client;
  const qnames = QUEUES.map((q) => q.name);

  await battle.createQueues(H.boss, QUEUES);

  // 1. PLAN + BULK CREATE (+ cancel the cancel-outcome jobs from 'created').
  const t0 = Date.now();
  const plan = battle.planWorkload(battle.makeRng(SEED), { n: N, queues: QUEUES });
  const created = await battle.bulkSendWorkload(H.boss, plan, { chunk: 1000 });
  expect(created.total).toBe(N);
  const tCreate = Date.now();
  console.log(`[storm] created ${created.total} (cancelled ${created.cancelled}) in ${((tCreate - t0) / 1000).toFixed(1)}s`);

  // 2. DRAIN with a pool of concurrent pull drivers (spread across queues).
  const ac = new AbortController();
  const perQueue = Math.max(1, Math.floor(WORKERS / QUEUES.length));
  const drivers: Promise<number>[] = [];
  for (const q of QUEUES) {
    for (let w = 0; w < perQueue; w++) {
      drivers.push(battle.runStormDriver(H.boss, H.pool, SCHEMAS, q.name, ac.signal, { batchSize: BATCH }));
    }
  }
  await battle.waitForDrain(H.pool, SCHEMAS, qnames, DRAIN_MS);
  ac.abort();
  const handled = (await Promise.all(drivers)).reduce((a, b) => a + b, 0);
  const tDrain = Date.now();
  const secs = (tDrain - tCreate) / 1000;
  console.log(`[storm] drained: ${handled} fetch-ops in ${secs.toFixed(1)}s (~${Math.round(handled / secs)}/s)`);

  // 3. AGGREGATE SQL ORACLE — verifies the whole storm in a few set queries.
  const oracle = await battle.assertStormSql(H.pool, SCHEMAS, qnames, N);
  console.log(`[storm] oracle OK: ${JSON.stringify(oracle)}`);
  expect(oracle.total).toBe(N);
  expect(oracle.attemptRows).toBeGreaterThanOrEqual(N); // retries preserved extra rows

  // 4. FORENSIC SURVIVAL at scale: delete some completed jobs' live rows; the
  //    chronicle still answers (Goal 1). Bounded sample — this stays per-job.
  if (created.sampleCompleted.length > 0) {
    await battle.forensicDelete(H.pool, SCHEMAS, created.sampleCompleted);
    for (const id of created.sampleCompleted) {
      const job = await C.findById(id);
      expect(job, `findById(${id}) after forensic delete`).not.toBeNull();
      expect(job!.state).toBe('completed');
    }
  }

  console.log(`[storm] DONE n=${N} seed=${SEED} total=${((Date.now() - t0) / 1000).toFixed(1)}s — 0 failures`);
}, TEST_MS);

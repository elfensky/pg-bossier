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

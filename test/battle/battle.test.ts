import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../harness.js';
import { install } from '../../src/install.js';
import { bossier, type Bossier } from '../../src/client.js';
import { resolveSchemas } from '../../src/sql.js';
import * as battle from './engine.js';

const SCHEMAS = resolveSchemas();

let h: Harness;
let client: Bossier;

beforeAll(async () => {
  h = await startHarness();
  await install(h.pool);
  client = bossier({ boss: h.boss, pool: h.pool });
}, 180_000);

afterAll(async () => { await h.teardown(); });

test('Phase A smoke — 10 complete-only push jobs are faithfully chronicled', async () => {
  const QUEUES: battle.QueueDef[] = [{ name: 'battle-smoke', pattern: 'push' }];
  const jobs = battle.planWorkload(battle.makeRng(1), { n: 10, queues: QUEUES })
    // force the smoke set to plain completes for a trivial first cut
    .map((j) => ({ ...j, outcome: 'complete' as const, plannedFails: 0, delaySeconds: 0,
      expectedAttempts: 1, expectedTerminalState: 'completed' as const, expectedAttemptStates: ['completed' as const] }));

  await battle.createQueues(h.boss, QUEUES);
  const byId = await battle.sendWorkload(h.boss, jobs);

  const attemptsSeen = new Map<string, number>();
  // pg-boss 12 uses localConcurrency (not teamSize/teamConcurrency from older versions)
  await h.boss.work('battle-smoke', { pollingIntervalSeconds: 0.5, localConcurrency: 5 },
    battle.makePushHandler(byId, attemptsSeen));

  await battle.waitForDrain(h.pool, SCHEMAS, ['battle-smoke'], 60_000);
  await h.boss.offWork('battle-smoke');

  await battle.assertWorkload(client, h.pool, SCHEMAS, byId, ['battle-smoke'],
    { seed: 1, n: 10, workers: 5, phase: 'A-smoke' });
  expect(byId.size).toBe(10);
}, 120_000);

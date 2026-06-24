// Long-running soak: repeat the battle engine's bounded storms (+ periodic
// audit-outage recovery) for a wall-clock budget, asserting recovery and no
// chronicle corruption every iteration. OPT-IN — set BATTLE_SOAK_MINUTES>0 (run
// via `npm run test:soak`); at 0 the harness no-ops so the default suite pays
// nothing.
//
// Why a loop, not a bigger N: getEventsSince hard-caps at 10k rows (src/read.ts)
// and the per-job oracle queries one job at a time, so a single 1M-job pass
// would need a batch-send + SQL-side-oracle rewrite. The loop accumulates the
// same cumulative volume in bounded chunks with zero engine changes.
//
// Why no connection-kill here: killBackends (battle Phase D) severs pg-boss's
// own worker sockets, which emit *unhandled* pg 'error' events — uncaught
// exceptions that fail an unattended run regardless of assertions (that's why
// Phase D is gated behind BATTLE_CHAOS_FULL + retry:2). The soak instead drives
// the two *clean* recovery paths: audit-outage fail-open and forensic-delete
// survival.
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from '../harness.js';
import { install } from '../../src/install.js';
import { bossier, type Bossier } from '../../src/client.js';
import { resolveSchemas } from '../../src/sql.js';
import * as battle from './engine.js';

const SCHEMAS = resolveSchemas();

const MINUTES = Number(process.env['BATTLE_SOAK_MINUTES'] ?? 0);
const N = Number(process.env['BATTLE_N'] ?? 200); // per-iteration; keep <=2000 (engine ceiling)
const WORKERS = 5;
const SEED = process.env['BATTLE_SEED'] === 'random'
  ? Math.floor(Math.random() * 2 ** 31)
  : Number(process.env['BATTLE_SEED'] ?? 0xc0ffee);
// Inject an audit-outage recovery round every Nth iteration. 0 disables it.
const OUTAGE_EVERY = Number(process.env['BATTLE_SOAK_OUTAGE_EVERY'] ?? 4);

const QUEUES: battle.QueueDef[] = [
  { name: 'soak-push-1', pattern: 'push' },
  { name: 'soak-push-2', pattern: 'push' },
  { name: 'soak-pull-1', pattern: 'pull' },
  { name: 'soak-pull-2', pattern: 'pull' },
];

let h: Harness | undefined;
let client: Bossier | undefined;

beforeAll(async () => {
  if (MINUTES <= 0) return; // skipped run → don't boot a container
  h = await startHarness();
  await install(h.pool);
  client = bossier({ boss: h.boss, pool: h.pool });
  console.log(`[soak] seed=${SEED} n=${N} minutes=${MINUTES} outageEvery=${OUTAGE_EVERY}`);
}, 180_000);

afterAll(async () => { if (h) await h.teardown(); });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.runIf(MINUTES > 0)('soak — sustained storms recover with no chronicle corruption', async () => {
  if (!h || !client) throw new Error('soak: harness not initialized');
  const H = h;
  const C = client;

  // One Phase-A-style storm into fresh, tag-scoped queues (so every per-iteration
  // scan stays bounded as the chronicle grows), then assert the per-job oracle,
  // then a Phase-B forensic-survival check: delete some completed jobs' live rows
  // and confirm the chronicle still answers.
  async function stormAndSurvive(seed: number, tag: string): Promise<void> {
    const queues: battle.QueueDef[] = QUEUES.map((q) => ({ name: `${q.name}-${tag}`, pattern: q.pattern }));
    const qnames = queues.map((q) => q.name);
    await battle.createQueues(H.boss, queues);
    const jobs = battle.planWorkload(battle.makeRng(seed), { n: N, queues });
    const byId = await battle.sendWorkload(H.boss, jobs);
    await battle.cancelPlanned(H.boss, byId);

    const attemptsSeen = new Map<string, number>();
    for (const q of queues.filter((q) => q.pattern === 'push')) {
      await H.boss.work(q.name, { pollingIntervalSeconds: 0.5, localConcurrency: WORKERS },
        battle.makePushHandler(byId, attemptsSeen));
    }
    const ac = new AbortController();
    const pullers = queues.filter((q) => q.pattern === 'pull')
      .map((q) => battle.runPullDriver(H.boss, H.pool, SCHEMAS, q.name, byId, attemptsSeen, ac.signal));

    await battle.waitForDrain(H.pool, SCHEMAS, qnames, 90_000);
    ac.abort();
    await Promise.allSettled(pullers);
    for (const q of queues.filter((q) => q.pattern === 'push')) await H.boss.offWork(q.name);

    await battle.assertWorkload(C, H.pool, SCHEMAS, byId, qnames,
      { seed, n: N, workers: WORKERS, phase: `soak-clean#${tag}` });

    // Forensic survival: the chronicle outlives pg-boss's own row deletion.
    const sample = [...byId.entries()]
      .filter(([, p]) => p.expectedTerminalState === 'completed')
      .slice(0, 10)
      .map(([id]) => id);
    if (sample.length > 0) {
      await battle.forensicDelete(H.pool, SCHEMAS, sample);
      for (const id of sample) {
        const job = await C.findById(id);
        expect(job, `findById(${id}) after forensic delete`).not.toBeNull();
        const hist = await C.getRetryHistory(id);
        expect(hist.at(-1)!.state).toBe('completed');
      }
    }
  }

  // Phase-C-style fail-open: drive a batch end-to-end while the audit table is
  // renamed away. Nothing must throw, and a fresh job after restore gets a
  // faithful chronicle (recovery).
  async function failOpenRound(tag: string): Promise<void> {
    const q = `soak-failopen-${tag}`;
    await H.boss.createQueue(q);
    const outageIds = await battle.withAuditOutage(H.pool, SCHEMAS, async () => {
      const ids: string[] = [];
      for (let i = 0; i < 15; i++) {
        const id = await H.boss.send(q, { key: `outage-${i}` });
        ids.push(id!);
      }
      let drained = 0;
      for (let guard = 0; drained < ids.length && guard < 200; guard++) {
        const batch = await H.boss.fetch(q, { batchSize: 20 });
        if (!batch || batch.length === 0) { await sleep(50); continue; }
        for (const j of batch) { await H.boss.complete(q, j.id, { ok: true }); drained++; }
      }
      expect(drained).toBe(ids.length);
      return ids;
    });
    expect(outageIds).toHaveLength(15);

    const freshId = await H.boss.send(q, { key: 'after-restore' });
    await H.boss.fetch(q);
    await H.boss.complete(q, freshId!, { ok: true });
    const hist = await C.getRetryHistory(freshId!);
    expect(hist.at(-1)!.state).toBe('completed');
  }

  const start = Date.now();
  const deadline = start + MINUTES * 60_000;
  let iter = 0;
  let jobs = 0;
  while (Date.now() < deadline) {
    iter += 1;
    const tag = `i${iter}`;
    await stormAndSurvive(SEED + iter, tag);
    jobs += N;
    if (OUTAGE_EVERY > 0 && iter % OUTAGE_EVERY === 0) await failOpenRound(tag);
    const mins = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(`[soak] iter=${iter} OK | ~${jobs} jobs sent | ${mins}m/${MINUTES}m`);
  }

  // Finale: the event-seq cursor is still strictly ascending under sustained
  // churn. ponytail: getEventsSince hard-caps at 10k rows (src/read.ts), so this
  // covers the first 10k transitions; per-iteration assertWorkload already proves
  // seq is distinct for every batch end-to-end.
  const evs = await C.getEventsSince(0n, 10_000);
  for (let i = 1; i < evs.length; i++) {
    expect(evs[i]!.seq > evs[i - 1]!.seq, `seq not ascending at index ${i}`).toBe(true);
  }

  expect(iter).toBeGreaterThan(0);
  console.log(`[soak] DONE seed=${SEED} iters=${iter} ~${jobs} jobs over ${MINUTES}m — 0 failures`);
}, (MINUTES * 60 + 300) * 1000);

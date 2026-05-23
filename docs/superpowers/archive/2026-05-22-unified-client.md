# Unified Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bossier({ boss, pool })` return one client that exposes pg-boss's whole API and pg-bossier's own methods on a single flat surface.

**Architecture:** `bossier()` returns a `Proxy` over the pg-boss instance. pg-bossier's eight methods resolve to its own implementations; every other property forwards to pg-boss, with functions bound to the real instance (pg-boss 12 uses `#private` fields, which throw if a method runs with `this` set to the proxy). The result is typed `PgBoss & BossierMethods`. There is no `.boss` escape hatch.

**Tech Stack:** TypeScript (`strict`, `noUncheckedIndexedAccess`, NodeNext ESM), `vitest` + `@testcontainers/postgresql` (real Postgres + pg-boss, no mocks), pg-boss 12, `pg` 8.

**Source:** design spec `docs/superpowers/specs/2026-05-22-unified-client-design.md`.

---

## Branching

Per CLAUDE.md's feature workflow, do this on a feature branch in a worktree, `--no-ff`-merged into `develop` — it is a multi-file, breaking change to the public client API worth isolating.

- Worktree: `git worktree add .worktrees/feature-unified-client -b feature/unified-client develop`
- `cd .worktrees/feature-unified-client && npm install`
- Do all tasks below in that worktree.
- When done: from a `develop` checkout, `git merge --no-ff feature/unified-client`, push, then `git worktree remove` + `git branch -d`.

The version stays `0.0.0` — no bump on a feature merge.

---

## Task 1: Record the decision on the tracking issues

The unified-client decision is recorded on **existing** issues, not a new one — it refines issue #1's API-shape principle and the write-feature sub-issues #3 / #5 / #7. Do this before Task 2 (CLAUDE.md: a foundational decision is tracked before code is written).

The updates are posted as issue **comments** — safe and additive, matching the repo's dated "Implementation update — <date>" convention.

**Not affected:** #6 (Goal 5) is closed — its read methods simply resolve on the unified client, no update needed. #4 and #8–#16 do not reference the client shape.

> **Posting to GitHub is outward-facing.** The user runs these commands, or explicitly confirms before an agent does.

**Files:** none (GitHub issues, not repo files).

- [ ] **Step 1: Comment on #1 — the charter**

```bash
gh issue comment 1 --repo elfensky/pg-bossier --body "$(cat <<'EOF'
**Implementation progress — 2026-05-22 — Unified client**

The `bossier({ boss, pool })` client is being reshaped into a **single unified surface**: `bossier()` returns a `Proxy` over the pg-boss instance that exposes every pg-boss method (forwarded) alongside pg-bossier's own methods, flat — replacing the `{ boss, ...methods }` shape where queue ops went through `client.boss.*`. There is no `.boss` escape hatch.

This adopts option **(c)** of the API-shape principle ("wrapping client that intercepts pg-boss calls") as the **base client architecture**. Two consequences for the principle:

- Option (b) — "sibling methods on a separate pg-bossier client" — is now "sibling methods on the unified client"; there is no separate client. The phrase "a separate pg-bossier client" in the Constraints section should read "the unified pg-bossier client" — a charter-text fix to apply on the next edit of this issue.
- Option (a) — "overload a pg-boss method" — now concretely means *intercepting that method in the wrapping proxy*. Annotated on #3, #5, #7.

Design spec: `docs/superpowers/specs/2026-05-22-unified-client-design.md`. Plan: `docs/superpowers/plans/2026-05-22-unified-client.md`.
EOF
)"
```

- [ ] **Step 2: Comment on #3 — Goal 2 (terminal-state detail)**

```bash
gh issue comment 3 --repo elfensky/pg-bossier --body "$(cat <<'EOF'
**Implementation update — 2026-05-22 — Unified client.** The `bossier` client is being reshaped into a single unified surface — a `Proxy` wrapping the pg-boss instance (design: `docs/superpowers/specs/2026-05-22-unified-client-design.md`). This refines the worker-signaling options above: there is no separate `boss` vs `bossier` object; both are methods on the one client.

- Option (a) "overload `boss.fail`" → **intercept `fail` in the wrapping proxy** (the proxy returns a pg-bossier wrapper for `fail` instead of forwarding it), surfaced as `client.fail`.
- Option (b) → a sibling method `client.recordTerminalDetail` on that same client.

The (a)-vs-(b) trade-off itself is unchanged.
EOF
)"
```

- [ ] **Step 3: Comment on #5 — Goal 4 (input-snapshot)**

```bash
gh issue comment 5 --repo elfensky/pg-bossier --body "$(cat <<'EOF'
**Implementation update — 2026-05-22 — Unified client.** The `bossier` client is being reshaped into a single unified surface — a `Proxy` wrapping the pg-boss instance (design: `docs/superpowers/specs/2026-05-22-unified-client-design.md`). This refines the population-API options above: there is no separate `boss` vs `bossier` object; both are methods on the one client.

- Option (a) "overload `boss.send`" → **intercept `send` in the wrapping proxy**, surfaced as `client.send`.
- Option (b) → a sibling method `client.recordInputSnapshot` on that same client.

The (a)-vs-(b) trade-off itself is unchanged.
EOF
)"
```

- [ ] **Step 4: Comment on #7 — Goal 6 (persistent progress)**

```bash
gh issue comment 7 --repo elfensky/pg-bossier --body "$(cat <<'EOF'
**Implementation update — 2026-05-22 — Unified client.** The `bossier` client is being reshaped into a single unified surface — a `Proxy` wrapping the pg-boss instance (design: `docs/superpowers/specs/2026-05-22-unified-client-design.md`). This refines the write-API options above: there is no separate `boss` vs `bossier` object; both are methods on the one client.

- Option (a) "overload `boss.touch`" → **intercept `touch` in the wrapping proxy**, surfaced as `client.touch`.
- Option (b) → a sibling method `client.setProgress` on that same client.

The (a)-vs-(b) trade-off itself is unchanged.
EOF
)"
```

- [ ] **Step 5: Apply the charter-text fix to #1's body**

The API-shape principle in #1's Constraints section reads option (b) as "new sibling methods on a separate pg-bossier client (e.g., `bossier.setProgress(id, ...)`)". After the unified client there is no separate client. Edit #1's body so that phrase reads "new sibling methods on the unified pg-bossier client". This is a one-phrase edit to the ratified charter — best done by the charter owner directly in the GitHub UI; the Step 1 comment records the need either way.

No commit — these are GitHub issues, not repo files.

---

## Task 2: Implement the unified client

**Files:**
- Modify: `src/client.ts` (full rewrite — content below)
- Modify: `src/index.ts` (full rewrite — content below)
- Test: `test/client.test.ts` (full rewrite — content below)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `test/client.test.ts` with:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { PgBoss } from 'pg-boss';
import { startHarness, getRecords, type Harness } from './harness.js';
import { install } from '../src/install.js';
import { bossier } from '../src/client.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); await install(h.pool); });
afterAll(async () => { await h.teardown(); });

/** The eight methods pg-bossier adds on top of pg-boss's API. */
const BOSSIER_METHOD_NAMES = [
  'recordPatch', 'findById', 'getRetryHistory', 'listJobs',
  'latestPerQueue', 'countByState', 'countByQueue', 'listLongRunning',
] as const;

test('recordPatch writes app-hook columns without clobbering trigger columns', async () => {
  const queue = 'client-q';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 1 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 5 } });

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.progress).toEqual({ done: 5 });
  expect(rows[0]!.state).toBe('created');
  expect(rows[0]!.data).toEqual({ in: 1 });
});

test('forwarded pg-boss queue ops run through the unified client', async () => {
  const queue = 'client-forward';
  const client = bossier({ boss: h.boss, pool: h.pool });

  // createQueue/send/fetch/complete are pg-boss methods, called on the
  // bossier client. If proxy method-binding were wrong, these would throw
  // "Cannot read private member" — pg-boss 12 uses #private fields.
  await client.createQueue(queue);
  const jobId = await client.send(queue, { forwarded: true });
  expect(jobId).toBeTruthy();

  const [job] = await client.fetch(queue);
  expect(job!.id).toBe(jobId);
  await client.complete(queue, jobId!);

  // the capture trigger still recorded every transition
  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('completed');
});

test('the unified client is still a PgBoss instance', () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  expect(client instanceof PgBoss).toBe(true);
});

test('forwarded EventEmitter methods bind to the underlying instance', () => {
  const client = bossier({ boss: h.boss, pool: h.pool });
  const before = h.boss.listenerCount('error');
  const listener = (): void => undefined;
  client.on('error', listener);
  // the listener landed on the real instance, where pg-boss emits from
  expect(h.boss.listenerCount('error')).toBe(before + 1);
  h.boss.removeListener('error', listener);
});

test('app-hook columns survive a later capture-trigger re-fire', async () => {
  const queue = 'client-survive';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { in: 2 });

  const client = bossier({ boss: h.boss, pool: h.pool });
  await client.recordPatch(jobId!, 0, { progress: { done: 7 } });

  await h.boss.fetch(queue); // created -> active, re-fires the trigger

  const rows = await getRecords(h.pool, jobId!);
  expect(rows[0]!.state).toBe('active');
  expect(rows[0]!.progress).toEqual({ done: 7 });
});

test('the client exposes the read methods bound to its pool', async () => {
  const queue = 'client-read';
  await h.boss.createQueue(queue);
  const jobId = await h.boss.send(queue, { via: 'client' });

  const client = bossier({ boss: h.boss, pool: h.pool });
  const job = await client.findById(jobId!);
  expect(job!.jobId).toBe(jobId);

  const listed = await client.listJobs({ queue });
  expect(listed.total).toBe(1);

  const history = await client.getRetryHistory(jobId!);
  expect(history.map((r) => r.attempt)).toEqual([0]);

  const latest = await client.latestPerQueue([queue]);
  expect(latest[0]!.jobId).toBe(jobId);

  const byState = await client.countByState({ queue });
  expect(byState.created).toBe(1);

  const byQueue = await client.countByQueue({ queue });
  expect(byQueue[queue]).toBe(1);

  const longRunning = await client.listLongRunning({ queue, longerThanSeconds: 0 });
  expect(longRunning).toEqual([]);
});

test('pg-bossier method names do not collide with pg-boss method names', () => {
  const pgBossMethods = new Set(Object.getOwnPropertyNames(PgBoss.prototype));
  for (const name of BOSSIER_METHOD_NAMES) {
    expect(pgBossMethods.has(name)).toBe(false);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL. Against the current `src/client.ts` the client is a plain object, so `client.send`/`client.createQueue` are `undefined` (`TypeError: client.send is not a function`), `client instanceof PgBoss` is `false`, and `client.on` is `undefined`. (The `recordPatch` and read-method tests and the collision test may already pass — that is fine.)

- [ ] **Step 3: Rewrite `src/client.ts`**

Replace the entire contents of `src/client.ts` with:

```ts
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
} from './read.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
}

/**
 * pg-bossier's own methods — the surface added on top of pg-boss's API:
 * `recordPatch` for the app-hook-owned columns, and the Goal 5 operational
 * read methods. All reads run on the `pool` passed to `bossier()`.
 */
export interface BossierMethods {
  /** Write the app-hook-owned columns of a record row. */
  recordPatch: (jobId: string, attempt: number, patch: RecordPatch) => Promise<void>;
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

  const methods: BossierMethods = {
    recordPatch: (jobId, attempt, patch) => recordPatch(pool, jobId, attempt, patch),
    findById: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      findById<TInput, TOutput>(pool, jobId),
    getRetryHistory: <TInput = unknown, TOutput = unknown>(jobId: string) =>
      getRetryHistory<TInput, TOutput>(pool, jobId),
    listJobs: <TInput = unknown, TOutput = unknown>(opts?: ListJobsOpts) =>
      listJobs<TInput, TOutput>(pool, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(pool, queues, opts),
    countByState: (filter) => countByState(pool, filter),
    countByQueue: (filter) => countByQueue(pool, filter),
    listLongRunning: (opts) => listLongRunning(pool, opts),
  };
  const methodNames = new Set(Object.keys(methods));

  return new Proxy(boss, {
    get(target, prop) {
      if (typeof prop === 'string' && methodNames.has(prop)) {
        return methods[prop as keyof BossierMethods];
      }
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member === 'function') {
        const fn = member as (...args: unknown[]) => unknown;
        return fn.bind(target);
      }
      return member;
    },
  }) as Bossier;
}
```

- [ ] **Step 4: Rewrite `src/index.ts`**

Replace the entire contents of `src/index.ts` with:

```ts
export { install, uninstall } from './install.js';
export { bossier } from './client.js';
export type { Bossier, BossierMethods, BossierOptions } from './client.js';
export type { RecordPatch } from './record.js';
export type { JobRecord, JobState, JobFilter, ListJobsOpts } from './read.js';
```

(The change: the removed `BossierClient` type is replaced by `Bossier` and `BossierMethods`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/client.test.ts`
Expected: PASS — all eight tests green.

- [ ] **Step 6: Run lint and build**

Run: `npm run lint && npm run build`
Expected: both pass with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/client.ts src/index.ts test/client.test.ts
git commit -m "feat: make bossier() return a single pg-boss-wrapping client

bossier() now returns a Proxy over the pg-boss instance — every pg-boss
method forwarded (bound to the instance, since pg-boss 12 uses #private
fields), pg-bossier's eight methods flat alongside. Removes the .boss
escape hatch; BossierClient is replaced by the Bossier / BossierMethods
types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Update README and CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Update the README Usage example**

In `README.md`, replace this block:

```
// 3. Wrap it. `client.boss` is the same pg-boss instance; from here on, every
//    job state transition is mirrored into `pgbossier.record` and kept forever.
const client = bossier({ boss, pool });

await client.boss.createQueue('email');
await client.boss.send('email', { to: 'user@example.com' });
```

with:

```
// 3. Wrap it. `client` is one surface — every pg-boss method plus pg-bossier's
//    own; from here on, each job state transition is mirrored into
//    `pgbossier.record` and kept forever.
const client = bossier({ boss, pool });

await client.createQueue('email');
await client.send('email', { to: 'user@example.com' });
```

- [ ] **Step 2: Reword the "How it works" intro**

In `README.md`, replace this line:

```
pg-bossier never sits between your application and pg-boss — you keep calling pg-boss exactly as before. The history is captured inside PostgreSQL itself:
```

with:

```
pg-bossier gives you a single client that wraps pg-boss: you call queue operations on it just as you would on pg-boss, and pg-bossier's own methods sit right alongside them. The job history is captured separately, inside PostgreSQL — by a database trigger, not by the client:
```

- [ ] **Step 3: Replace the "How it works" mermaid diagram**

In `README.md`, replace the entire diagram body (the lines from `flowchart TD` through the last `Client -.->` line, inside the ` ```mermaid ` fence):

```
flowchart TD
    subgraph app["Your application process"]
        Code["Your code"]
        Boss["pg-boss"]
        Client["bossier client"]
    end

    subgraph db["PostgreSQL"]
        Job[("pgboss.job<br/>job rows — deleted on<br/>retention and on retry")]
        Trigger{{"pgbossier<br/>capture trigger"}}
        Record[("pgbossier.record<br/>append-only history<br/>kept forever")]
    end

    Code -->|"queue and work jobs"| Boss
    Boss -->|"create · update state · delete"| Job
    Job -->|"every create and state change"| Trigger
    Trigger -->|"mirror the row — one per attempt"| Record
    Record -->|"look up · list · count"| Client
    Client -->|"typed job history"| Code
    Code -.->|"your own job data"| Client
    Client -.->|"progress · detail · input snapshot"| Record
```

with:

```
flowchart TD
    subgraph app["Your application process"]
        Code["Your code"]
        Client["bossier client<br/>one unified surface"]
        Boss["pg-boss"]
    end

    subgraph db["PostgreSQL"]
        Job[("pgboss.job<br/>job rows — deleted on<br/>retention and on retry")]
        Trigger{{"pgbossier<br/>capture trigger"}}
        Record[("pgbossier.record<br/>append-only history<br/>kept forever")]
    end

    Code -->|"queue ops and history calls"| Client
    Client -->|"queue ops forwarded"| Boss
    Boss -->|"create · update state · delete"| Job
    Job -->|"every create and state change"| Trigger
    Trigger -->|"mirror the row — one per attempt"| Record
    Record -->|"look up · list · count"| Client
    Client -.->|"progress · detail · input snapshot"| Record
```

- [ ] **Step 4: Update "How it works" numbered item 1**

In `README.md`, replace this line:

```
1. **Your app runs jobs through pg-boss as usual.** pg-bossier changes nothing about how you queue or work jobs.
```

with:

```
1. **Your app runs jobs through the `bossier` client.** It forwards every pg-boss queue operation to pg-boss unchanged — pg-bossier extends pg-boss's API, it never replaces it.
```

- [ ] **Step 5: Update the CHANGELOG**

The `bossier` client and its types were never released — they sit in `## [Unreleased]`. Per Keep a Changelog, a change to a not-yet-released entry is made by **editing that entry**, not by adding a separate `Changed` line (which would describe changing something nobody has seen). In `CHANGELOG.md`, replace these two consecutive lines:

```
- `bossier({ boss, pool })` client exposing the underlying pg-boss instance plus `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns (`progress`, `terminal_detail`, `input_snapshot`).
- Public API from `src/index.ts`: `install`, `uninstall`, `bossier`, and the `BossierClient` / `BossierOptions` / `RecordPatch` types.
```

with:

```
- `bossier({ boss, pool })` client — one unified surface that wraps the pg-boss instance: every pg-boss method is forwarded to it, and pg-bossier's own methods sit alongside, including `recordPatch(jobId, attempt, patch)` for the pg-bossier-owned columns (`progress`, `terminal_detail`, `input_snapshot`).
- Public API from `src/index.ts`: `install`, `uninstall`, `bossier`, and the `Bossier` / `BossierMethods` / `BossierOptions` / `RecordPatch` types.
```

- [ ] **Step 6: Verify the build is unaffected**

Run: `npm run build`
Expected: PASS (documentation-only changes; this confirms nothing was broken).

- [ ] **Step 7: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: update README and CHANGELOG for the unified client

README usage and the How it works section (prose + diagram) now show
the single bossier client; the unreleased CHANGELOG entry describes the
wrapping client and the renamed Bossier / BossierMethods types.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `npm run lint && npm run build && npm test` from the worktree. Expected: all pass (lint clean, `tsc` emits, the full integration suite green).
- [ ] Merge per the Branching section: `git merge --no-ff feature/unified-client` from `develop`, push, clean up the worktree and branch.

---

## Self-review (completed during planning)

- **Spec coverage:** entry-point/return shape → Task 2 Steps 3–4; proxy mechanism + binding → Task 2 Step 3; flat methods + collision guard → Task 2 (test Step 1, the collision test); edge cases (private fields, events, `instanceof`) → Task 2 test cases; "what changes elsewhere" (`client.ts`, `index.ts`, README, `client.test.ts`, CHANGELOG) → Tasks 2 & 3; the process note → Task 1 (updates issues #1/#3/#5/#7); testing section → Task 2 Step 1. All spec sections map to a task.
- **Placeholders:** none — every file/edit gives complete content.
- **Type consistency:** `Bossier`, `BossierMethods`, `BossierOptions`, `bossier` used identically across `client.ts`, `index.ts`, and the spec; the eight method names match between `BossierMethods`, the `methods` object, and the test's `BOSSIER_METHOD_NAMES`.

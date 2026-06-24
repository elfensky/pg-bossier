# Adopting pg-bossier in descent-app (v0.3.1)

> **Updated 2026-06-23 (post-reposition, on `develop` — newer than `v0.1.0`).** Three changes affect this guide: (1) the lifecycle subscription is now **`subscribeEvents()`** (renamed from `subscribe` so it no longer shadows pg-boss's pub/sub `subscribe`); (2) the residual raw `heartbeat_on` lookup is **no longer needed** — `client.getLiveState(jobId)` / `getLiveHeartbeat(jobId)` read it (and live expiry/state) via a typed method; (3) `bossier()`'s `pool` is now **optional** (reads/writes route through pg-boss's own connection), though `subscribeEvents` and `install` still need one. See CLAUDE.md § "General-purpose reposition".

This is the step-by-step for the descent-app validation trial — the gate before pg-bossier's first npm publish. pg-bossier is a **queue-mechanics** layer on top of pg-boss (permanent history, retry/progress/failure detail, events). It is **not** a domain audit store — descent-app's own audit-trail table owns provenance ("which job + inputs → which result", user actions, etc.).

## 1. Install (git URL — not on npm yet)

```bash
npm install 'git+https://github.com/elfensky/pg-bossier.git#v0.3.1'
```

`prepare` builds `dist/` on install — so this git-URL install needs install
scripts allowed (fails under `npm ci --ignore-scripts` / allow-scripts gating;
see the README install caveat). Peers: `pg-boss ^12.18.2`, `pg ^8`.

## 2. Run the one-time migration

Once, against the same database pg-boss uses (it creates the `pgbossier` schema + the capture trigger on `pgboss.job`):

```ts
import { install } from 'pg-bossier';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await install(pool); // idempotent; safe to re-run
```

On a large existing `pgboss.job`, `install()` backfills history **without** blocking the live queue (the trigger DDL commits before the backfill runs). Symmetric removal is `DROP SCHEMA pgbossier CASCADE` + uninstall the package.

> **Upgrading an existing install (preserve history).** The `priority` / `retry_limit` / `singleton_key` capture in step 4 is in `v0.3.0`. **Already adopted an earlier version?** Run `migrate(pool)` (v0.3.0) — the non-destructive in-place upgrade ([#28](https://github.com/elfensky/pg-bossier/issues/28)): it adds the new columns via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` while **preserving all captured history**. Do **not** use the old `uninstall()` + `install()` drop+reinstall — that discards exactly the records that outlived pg-boss's `deletion_seconds` GC. The backfill (run by both `migrate` and `install`) repopulates config for every job still in `pgboss.job`.

> **Prisma users:** `prisma db pull` with `multiSchema` will introspect `pgbossier` and a later `migrate` could drop its tables. Keep `pgbossier` out of Prisma's managed schemas. See the README "Prisma coexistence" note.

## 3. Wrap the client

```ts
import { bossier } from 'pg-bossier';
const client = bossier({ boss, pool }); // a Proxy over your pg-boss instance + pg-bossier methods
```

Every pg-boss method still works on `client`; pg-bossier's reads/writes sit alongside.

## 4. Swap the raw queries

The verified mapping of descent-app's `src/lib/jobs/queries.js` → pg-bossier methods is in **[`descent-app-fit.md`](descent-app-fit.md)**. Summary:

- **8 read functions** drop their raw SQL (use `findById` / `listJobs` / `latestPerQueue` / `countByState` / `countByQueue`, plus descent-app's existing `normalizeJob` as a pure-JS shape adapter on top of `JobRecord`).
- **Now captured (v0.3.0+):** `priority` / `retry_limit` / `singleton_key` come back on `JobRecord` as `priority` / `retryLimit` / `singletonKey`, so `getJobById` / `getRecentJobs` / `getJobsPaginated` no longer need a residual raw read for them.
- **Live runtime state** — `heartbeat_on` and live state/expiry are read via the typed `getLiveState(jobId)` / `getLiveHeartbeat(jobId)` (and `getLiveHeartbeats(ids)` for a batched dashboard page), so they no longer need raw `pgboss.job` SQL. These are deliberately **non-forensic** (the live row vanishes when pg-boss deletes the job).
- **Stays raw by design (short list):** the two `pgboss.job.output` writers (`updateJobOutput` / `mergeJobOutput` — live queue-op writes pg-bossier won't replace), and `expire_seconds` (uncaptured, not rendered today) — **only if** the detail view renders it.

## 5. Two gotchas to get right

- **Dead-letter lineage needs the job's *real* id.** The source job's id must be its actual `pgboss.job` id (so the chronicle keys on it) AND ride in `data` (so the DLQ copy can recover it). Use **`sendTracked`** (v0.3.0) — it pins both in one call so they can't drift:
  ```ts
  const sourceId = await client.sendTracked('q', { ... }); // sets data._originalJobId = the pinned id
  // DLQ handler: client.recordDeadLetter({ sourceJobId: job.data._originalJobId, dlqJobId: job.id })
  ```
  (The manual equivalent is `boss.send('q', { _originalJobId: sourceId, ... }, { id: sourceId })`. Omit the `{ id }` half and `recordDeadLetter` silently no-ops with `reason: 'not_found'` — which is exactly what `sendTracked` prevents.)
- **Progress resume is pg-bossier-side.** Don't rely on `pgboss.job.output` surviving a retry (it doesn't). Write progress with `setProgress(job.id, pos)`, and at the **top** of the handler resume via `getProgress(job.id)`.

## 6. What to report back

The trial's measure (success criterion #1): how far does the raw-SQL count against `pgboss.*` actually drop, and does the short list above hold? Anything that *forces* raw SQL beyond the short list is a finding → file it against [#26](https://github.com/elfensky/pg-bossier/issues/26) (deferrals) so we decide whether pg-bossier should grow to cover it.

---

## Copy-paste prompt for a Claude session in descent-app

> Adopt **pg-bossier v0.3.1** to remove descent-app's raw SQL against `pgboss.*` (tracking issue #343).
>
> 1. Install it: `npm install 'git+https://github.com/elfensky/pg-bossier.git#v0.3.1'` (the git-URL install needs install scripts allowed — it builds `dist/` via `prepare`). Peers are `pg-boss ^12.18.2` and `pg ^8` (already present).
> 2. Add a one-time migration step that runs `install(pool)` from `pg-bossier` against `DATABASE_URL` (idempotent; creates the `pgbossier` schema + a capture trigger on `pgboss.job`). Keep `pgbossier` **out** of Prisma's managed schemas so `prisma migrate` can't drop it.
> 3. Read pg-bossier's `docs/descent-app-fit.md` scorecard (in its package, or at github.com/elfensky/pg-bossier). It maps each function in `src/lib/jobs/queries.js` to a pg-bossier method. Refactor `queries.js` to call `bossier({ boss, pool })`'s methods instead of raw SQL, keeping descent-app's `normalizeJob` as a shape adapter over the returned `JobRecord`.
> 4. **Leave raw, by design:** `updateJobOutput` / `mergeJobOutput` (they write the live `pgboss.job.output` — a pg-boss queue op pg-bossier won't replace), and any query that renders `heartbeat_on` / `expire_seconds` (still uncaptured — read live from `pgboss.job`). Note: `priority` / `retry_limit` / `singleton_key` **are** captured (v0.3.0+) and available on `JobRecord` as `priority` / `retryLimit` / `singletonKey` — don't keep raw reads for those.
> 5. **Two contracts to honor:** (a) for dead-letter lineage, enqueue source jobs with `const sourceId = await client.sendTracked('q', {...})` (pins the id and stamps `data._originalJobId` in one call), then in the DLQ handler call `client.recordDeadLetter({ sourceJobId: job.data._originalJobId, dlqJobId: job.id })`. (b) For resumable jobs, write progress with `client.setProgress(job.id, pos)` and resume at the top of the handler via `client.getProgress(job.id)` — do **not** rely on `pgboss.job.output` surviving a retry.
> 6. Run descent-app's tests + a real worker against a real Postgres. Report back: the raw-SQL count before vs after, whether the "stays raw" short list held, and anything that forced raw SQL beyond it (those are findings for pg-bossier).
>
> Do **not** ask pg-bossier to store domain/provenance data — descent-app's own audit-trail table owns that. pg-bossier is queue-mechanics only.

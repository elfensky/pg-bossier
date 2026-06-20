# Adopting pg-bossier in descent-app (v0.1.0 trial)

This is the step-by-step for the descent-app validation trial — the gate before pg-bossier's first npm publish. pg-bossier is a **queue-mechanics** layer on top of pg-boss (permanent history, retry/progress/failure detail, events). It is **not** a domain audit store — descent-app's own audit-trail table owns provenance ("which job + inputs → which result", user actions, etc.).

## 1. Install (git URL — not on npm yet)

```bash
npm install 'git+https://github.com/elfensky/pg-bossier.git#v0.1.0'
```

`prepare` builds `dist/` on install. Peers: `pg-boss ^12.18.2`, `pg ^8`.

## 2. Run the one-time migration

Once, against the same database pg-boss uses (it creates the `pgbossier` schema + the capture trigger on `pgboss.job`):

```ts
import { install } from 'pg-bossier';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await install(pool); // idempotent; safe to re-run
```

On a large existing `pgboss.job`, `install()` backfills history **without** blocking the live queue (the trigger DDL commits before the backfill runs). Symmetric removal is `DROP SCHEMA pgbossier CASCADE` + uninstall the package.

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
- **Stays raw by design (short list):** the two `pgboss.job.output` writers (`updateJobOutput` / `mergeJobOutput` — live queue-op writes pg-bossier won't replace), and a small residual lookup for the 5 uncaptured metadata columns (`priority`, `retry_limit`, `singleton_key`, `heartbeat_on`, `expire_seconds`) **only if** the admin UI renders them.

## 5. Two gotchas to get right

- **Dead-letter lineage needs the job's *real* id.** Set the source job's id explicitly so the chronicle keys on it, and carry it in `data` so the DLQ copy can recover it:
  ```ts
  const sourceId = crypto.randomUUID();
  await boss.send('q', { _originalJobId: sourceId, ... }, { id: sourceId });
  // DLQ handler: client.recordDeadLetter({ sourceJobId: job.data._originalJobId, dlqJobId: job.id })
  ```
  Without `{ id: sourceId }`, `recordDeadLetter` silently no-ops (`reason: 'not_found'`).
- **Progress resume is pg-bossier-side.** Don't rely on `pgboss.job.output` surviving a retry (it doesn't). Write progress with `setProgress(job.id, pos)`, and at the **top** of the handler resume via `getProgress(job.id)`.

## 6. What to report back

The trial's measure (success criterion #1): how far does the raw-SQL count against `pgboss.*` actually drop, and does the short list above hold? Anything that *forces* raw SQL beyond the short list is a finding → file it against [#26](https://github.com/elfensky/pg-bossier/issues/26) (deferrals) so we decide whether pg-bossier should grow to cover it.

---

## Copy-paste prompt for a Claude session in descent-app

> Adopt **pg-bossier v0.1.0** to remove descent-app's raw SQL against `pgboss.*` (tracking issue #343).
>
> 1. Install it: `npm install 'git+https://github.com/elfensky/pg-bossier.git#v0.1.0'`. Peers are `pg-boss ^12.18.2` and `pg ^8` (already present).
> 2. Add a one-time migration step that runs `install(pool)` from `pg-bossier` against `DATABASE_URL` (idempotent; creates the `pgbossier` schema + a capture trigger on `pgboss.job`). Keep `pgbossier` **out** of Prisma's managed schemas so `prisma migrate` can't drop it.
> 3. Read pg-bossier's `docs/descent-app-fit.md` scorecard (in its package, or at github.com/elfensky/pg-bossier). It maps each function in `src/lib/jobs/queries.js` to a pg-bossier method. Refactor `queries.js` to call `bossier({ boss, pool })`'s methods instead of raw SQL, keeping descent-app's `normalizeJob` as a shape adapter over the returned `JobRecord`.
> 4. **Leave raw, by design:** `updateJobOutput` / `mergeJobOutput` (they write the live `pgboss.job.output` — a pg-boss queue op pg-bossier won't replace), and any query that renders `priority` / `retry_limit` / `singleton_key` / `heartbeat_on` / `expire_seconds` (pg-bossier doesn't capture those — read them live from `pgboss.job`).
> 5. **Two contracts to honor:** (a) for dead-letter lineage, send source jobs with an explicit `{ id: sourceId }` *and* `_originalJobId: sourceId` in data, then in the DLQ handler call `client.recordDeadLetter({ sourceJobId: job.data._originalJobId, dlqJobId: job.id })`. (b) For resumable jobs, write progress with `client.setProgress(job.id, pos)` and resume at the top of the handler via `client.getProgress(job.id)` — do **not** rely on `pgboss.job.output` surviving a retry.
> 6. Run descent-app's tests + a real worker against a real Postgres. Report back: the raw-SQL count before vs after, whether the "stays raw" short list held, and anything that forced raw SQL beyond it (those are findings for pg-bossier).
>
> Do **not** ask pg-bossier to store domain/provenance data — descent-app's own audit-trail table owns that. pg-bossier is queue-mechanics only.

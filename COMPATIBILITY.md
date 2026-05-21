# pg-boss compatibility

pg-bossier layers on top of [pg-boss](https://github.com/timgit/pg-boss) without forking it or patching its source. "Stay close to pg-boss" is only enforceable if we name *which* pg-boss surfaces we depend on, and how stable each one is. This document is that classification — the tier half of [issue #1](https://github.com/elfensky/pg-bossier/issues/1)'s Goal 8.

Every pg-bossier change that touches a pg-boss surface must place that surface in one of the three tiers below. A surface that fits neither Stable nor Transitional is Forbidden — no exceptions inside an implementation PR.

## The tiers

| Tier | Meaning |
| --- | --- |
| **Stable** | pg-boss's documented public JS API. We depend on it and treat it as a contract; upstream breakage here is a major-version event for pg-boss, and by extension for pg-bossier. |
| **Transitional** | Surfaces below the public API — chiefly the shape of the `pgboss.job` table. We depend on these, but re-verify them against each supported pg-boss version. Updating a binding on a pg-boss minor bump is *not* itself a pg-bossier breaking change. |
| **Forbidden** | pg-boss internals — private SQL, helper modules, undocumented events, anything under `node_modules/pg-boss/src/`. Never depended on. Needing one is the signal to find a public-API path, or to question the requirement. |

## What v0.1.0 depends on

pg-boss is pinned as a peer dependency at `^12.18.2`.

### Stable

- **The `PgBoss` class.** `src/client.ts` imports it as a type only; the substrate's runtime makes no pg-boss method calls of its own.
- **pg-boss's public queue API, as exercised by the integration suite:** `new PgBoss()`, `start`, `stop`, `createQueue`, `send`, `fetch`, `complete`, `fail`, `cancel`, `touch`. These are the methods consumers already call; pg-bossier composes with them and never overrides them.

### Transitional

- **The `pgboss.job` table.** The capture trigger and the install-time backfill read these columns: `id`, `name`, `retry_count`, `state`, `data`, `output`, `created_on`, `started_on`, `completed_on`.
- **A row trigger on `pgboss.job`.** `install()` attaches `pgbossier_capture` — `AFTER INSERT OR UPDATE OF state ... FOR EACH ROW` — to a pg-boss-owned table. This relies on pg-boss 12's `pgboss.job` being a partitioned table whose parent row trigger propagates to its per-queue partitions. That is a structural fact of pg-boss 12, not a documented API — hence Transitional.

pg-boss 12 has **no `pgboss.archive` table**; finished job rows are deleted in place by `deletion_seconds`. pg-bossier therefore reads only the live `pgboss.job` — and its whole reason to exist is to preserve what that deletion discards.

### Forbidden

- `node_modules/pg-boss/src/*` modules — never imported.
- pg-boss internal tables (schema-version bookkeeping, maintenance state) — never read.
- Undocumented pg-boss events and private SQL — never depended on.

v0.1.0 reaches into none of these.

## Still open (issue [#9](https://github.com/elfensky/pg-bossier/issues/9))

This document classifies the surfaces. Two related decisions are tracked in #9 and are **not** settled here:

- **The CI version matrix** — which set of pg-boss versions CI runs the suite against (latest + N-1 + N-2 minors, or another window).
- **Update cadence** — whether this document is revised on every PR that touches a pg-boss surface, or on a separate audit cadence.

As later goals land they will add surfaces — `work` and the ORM transaction adapters to Stable, more `pgboss.job` columns to Transitional. Extend the tables above in the same change.

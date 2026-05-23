# pg-boss compatibility

pg-bossier layers on top of [pg-boss](https://github.com/timgit/pg-boss) without forking it or patching its source. "Stay close to pg-boss" is only enforceable if we name *which* pg-boss surfaces we depend on, and how stable each one is. This document is that classification — the tier half of [issue #1](https://github.com/elfensky/pg-bossier/issues/1)'s Goal 8.

Every pg-bossier change that touches a pg-boss surface must place that surface in one of the three tiers below. A surface that fits neither Stable nor Transitional is Forbidden — no exceptions inside an implementation PR.

## The tiers

| Tier | Meaning |
| --- | --- |
| **Stable** | pg-boss's documented public JS API. We depend on it and treat it as a contract; upstream breakage here is a major-version event for pg-boss, and by extension for pg-bossier. |
| **Transitional** | Surfaces below the public API — chiefly the shape of the `pgboss.job` table. We depend on these, but re-verify them against each supported pg-boss version. Updating a binding on a pg-boss minor bump is *not* itself a pg-bossier breaking change. |
| **Forbidden** | pg-boss internals — private SQL, helper modules, undocumented events, anything under `node_modules/pg-boss/src/`. Never depended on. Needing one is the signal to find a public-API path, or to question the requirement. |

## What pg-bossier depends on today

pg-boss is pinned as a peer dependency at `^12.18.2`.

### Stable

- **The `PgBoss` class.** `src/client.ts` imports it as a type only. `bossier()`'s public return type is `Bossier` = `PgBoss & BossierMethods`.
- **The `PgBoss` instance, wrapped by the unified client.** `bossier()` returns a `Proxy` over the pg-boss instance the consumer constructs. The proxy forwards pg-boss's **entire public method surface** to that instance — each method bound to it, because pg-boss 12 defines methods that read `#private` fields and would throw if `this` were the proxy. pg-bossier initiates no pg-boss calls of its own; it forwards the consumer's. This relies on `PgBoss` being an ordinary class instance — public methods reachable via `Reflect.get` and bindable, `instanceof PgBoss` intact through the proxy. A pg-boss change to that shape is a major-version concern, hence Stable.
- **pg-boss's public queue API and EventEmitter surface.** `new PgBoss()`, `start`, `stop`, `createQueue`, `send`, `fetch`, `complete`, `fail`, `cancel`, `touch`, and `on` / `once` / `off` are the methods consumers call and the integration suite exercises. pg-bossier composes with them and never overrides them — a CI test asserts pg-bossier's own method names never collide with `PgBoss.prototype`.

### Transitional

- **The `pgboss.job` table.** The capture trigger and the install-time backfill read these columns: `id`, `name`, `retry_count`, `state`, `data`, `output`, `created_on`, `started_on`, `completed_on`.
- **A row trigger on `pgboss.job`.** `install()` attaches `pgbossier_capture` — `AFTER INSERT OR UPDATE OF state ... FOR EACH ROW` — to a pg-boss-owned table. This relies on pg-boss 12's `pgboss.job` being a partitioned table whose parent row trigger propagates to its per-queue partitions. That is a structural fact of pg-boss 12, not a documented API — hence Transitional.

pg-boss 12 has **no `pgboss.archive` table**; finished job rows are deleted in place by `deletion_seconds`. pg-bossier therefore reads only the live `pgboss.job` — and its whole reason to exist is to preserve what that deletion discards.

### Forbidden

- `node_modules/pg-boss/src/*` modules — never imported.
- pg-boss internal tables (schema-version bookkeeping, maintenance state) — never read.
- Undocumented pg-boss events and private SQL — never depended on.

pg-bossier reaches into none of these.

## How this doc gets updated

This document is a ledger of real pg-boss surfaces pg-bossier currently
uses — not a prediction of future ones. When a PR adds a new pg-boss
method, column, or structural assumption, the same PR extends the table
above with that surface and its tier. This norm is a code-review
expectation, not enforced automation; it will sometimes be missed. The
floor/latest tripwire below is the safety net for when it is.

As later goals land they will add surfaces — `work` and the ORM
transaction adapters to Stable, more `pgboss.job` columns to
Transitional. Extend the tables above in the same change.

## Version support — no matrix today, self-firing tripwire

pg-bossier's CI runs against a single pg-boss version: whatever `npm ci`
resolves to inside the peer-dep range declared in `package.json`. Today
the floor and the latest published pg-boss are the same version, so a
matrix would be a degenerate one-entry list.

What CI-against-latest catches: hard schema breaks — a column we read
disappears, or changes type in a way the trigger cannot compile against
— detectable by the existing integration suite. What it does NOT catch:
silent semantic drift. A column kept as an alias on rename. A
type/nullability shift the trigger still compiles against. pg-boss
adding or reordering its own triggers on `pgboss.job`. Upgrade-path
bugs that only manifest moving from an older minor to a newer one.
Those classes of bug are caught by cross-version correctness assertions
against `pgbossier.record`, not by matrix presence alone (see [follow-up
issue #19](https://github.com/elfensky/pg-bossier/issues/19)).

The tripwire: a CI step compares the latest published pg-boss version
against the peer-dep floor declared in `package.json`. When they
diverge, the step surfaces a warning that links back to this section.
The trigger to add a floor+latest version matrix is **floor and latest
diverging**, contingent on the correctness assertions above existing
first. The matrix is the runtime; the assertions are the safety. A
matrix without assertions broadens the set of versions we can silently
be wrong on.

No time-bound support SLA. The "~2 weeks" estimate in issue #1 was an
internal complexity gate, not a commitment to consumers. "Supported"
means "the existing CI passes against the version pg-boss publishes
into the peer-dep range." When the floor and latest diverge,
"supported" extends to include the correctness assertions naming what
semantic behavior is verified across versions.

## Unsupported topologies (Goal 7)

Postgres `LISTEN/NOTIFY` — pg-bossier's lifecycle event transport — has hard topology constraints. The subscriber's connection must reach the primary through a non-multiplexed session.

### PgBouncer in transaction-pool mode — unsupported

In transaction-pool mode, PgBouncer reuses backends between transactions. `LISTEN` registers on a specific backend; when the proxy hands the next transaction to a different backend, the LISTEN is invisible to it. The subscriber sees no errors and no events — a silent failure.

Three viable consumer options:

1. Route the subscriber connection through PgBouncer in **session-pool** mode.
2. Use a separate Postgres connection (no PgBouncer) for the subscriber.
3. Connect directly to Postgres for `subscribe()`.

Detect silently-broken subscribers via the `'connected'` event — register a listener and alert if no `'connected'` arrives within N seconds of `subscribe()` returning.

### Standby / read-replica connections — unsupported

`NOTIFY` is not replicated to streaming or logical replicas. A subscriber connected to a standby reads no events. After a primary failover, a subscriber connected by IP/DNS to the old primary (now a standby) will reconnect "cleanly" but receive nothing.

**Recommended:** use `target_session_attrs=read-write` in the connection string (libpq ≥ 14 / pg ≥ 8.5) so the driver discovers the writable primary on every (re)connection.

### `pg_notify` inside the capture trigger

The capture trigger's `pg_notify` is enqueued and delivered on transaction commit. A pg-boss op that rolls back produces neither an audit row nor an event (both share the trigger savepoint).

**Silent-gap edge case.** If `pg_notify` itself ever fails inside the trigger's `EXCEPTION WHEN OTHERS` block (vanishingly rare with the ~150-byte bounded payload), the implicit savepoint rolls back the audit row write too. The pg-boss op still succeeds. No JS `'error'` fires because no notification was delivered.

### Channel name

**Channel name.** The default NOTIFY channel is `pgbossier_job`. If you
pass a non-default `schema` option to `bossier()`, the channel becomes
`${schema}_job`. The trigger name follows the same pattern:
`${schema}_capture`. This prevents collisions when multiple pg-bossier
installs share a database.

## Install constraints (Goal 9)

### `--ignore-scripts` blocks the build step

`npm install` from a git URL relies on the `prepare` lifecycle script
running `tsc` to produce `dist/`. Consumers running `npm ci
--ignore-scripts` (common in security-conscious CI environments) on a
git URL install will get an un-built package.

Workarounds:
- Use a published npm tarball (`npm install pg-bossier@x.y.z`) — the
  tarball contains pre-built `dist/`, no `prepare` re-run needed.
- Use a local pack (`npm pack` then `npm install
  pg-bossier-x.y.z.tgz`) — same as above.

### Engines

pg-bossier requires Node ≥ 18.3 (for `util.parseArgs`, stabilized in
that release). The CLI is the only piece that uses `parseArgs`; the
JS API works on Node ≥ 18.0.

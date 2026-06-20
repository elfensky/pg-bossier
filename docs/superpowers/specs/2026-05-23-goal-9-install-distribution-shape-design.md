# Goal 9 — Install / distribution shape: design

**Date:** 2026-05-23 (v1) · 2026-05-23 (v2)
**Sub-issue:** [#10](https://github.com/elfensky/pg-bossier/issues/10)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design **v2** — pre-implementation. Incorporates findings from
the 2026-05-23 4-way adversarial review (Codex / Gemini / Sonnet / Opus);
synthesis + raw critiques live in
[`docs/superpowers/debates/2026-05-23-goal-9-spec-adversarial-review/`](../debates/2026-05-23-goal-9-spec-adversarial-review/).
v1 was committed as `b5410b9`. Builds on the storage substrate (PR #15),
Goal 7's `seq`-column upgrade precedent, and the existing programmatic
`install(pool)` / `uninstall(pool)`.

---

## Revisions

- **v2 (2026-05-23)** — Adversarial-review pass. Material changes:
  - **`assertSchemaName` hardened.** Reject `public` (data-loss footgun — `uninstall` would `DROP SCHEMA public CASCADE`), `information_schema`, any `pg_`-prefixed name (Postgres reserves these), identifiers > 63 bytes (NAMEDATALEN), and Postgres reserved keywords (which fail with bare-interpolated SQL).
  - **Trigger name parameterized** to `${s.pgbossier}_capture` in `captureTriggerSql`. Without this, install B silently drops install A's trigger via `DROP TRIGGER IF EXISTS pgbossier_capture`.
  - **`install()` wrapped in a transaction** + preflight check for `${pgbossSchema}.job` existence. Either-everything-or-nothing semantics; no partial-install state to clean up.
  - **CLI control flow fixed.** `strict: true` in `parseArgs` (so typos throw clearly); capture exit code in a variable; `pool.end()` in `finally`; `process.exit(code)` *after* the `finally` returns. The v1 sketch had three discrete bugs.
  - **CLI prints destination connection info** (`host:port database schema=… pgbossSchema=…`) before any SQL runs. Mitigates `DATABASE_URL` fallback footgun.
  - **CLI connection timeout** (`connectionTimeoutMillis: 10_000`) so bad credentials fail in seconds, not minutes.
  - **New "Supported topologies" section.** Enumerates 1:1 (default, primary), N:N-distinct (supported), 2:1 (unsupported — duplicate captures), 1:N (unsupported — single source). The v1 spec implied unrestricted multi-instance support; v2 names the constraints.
  - **Prisma coexistence escalated to a ⚠️ callout.** `prisma db pull` with `multiSchema` introspects all schemas including pgbossier — consumers MUST exclude pgbossier from `datasource.schemas` to avoid destructive `prisma migrate` drift. v1's "Prisma only manages declared schemas" was too absolute.
  - **Corrected "all three install paths exercise `prepare`" claim** (was on line 525 of v1). Git installs run `prepare`; tarball consumers receive pre-built `dist/` without re-running `prepare`. Spec now states this precisely.
  - **Commit-SHA pinning as primary git-install example.** Branch refs in `package-lock.json` re-resolve to the current branch head on every `npm ci` — non-reproducible.
  - **`engines` bumped to `>=18.3.0`** so `util.parseArgs` is unambiguously available.
  - **`git add -u` (not `-A`)** in the publish runbook step 4. `-A` stages untracked files; `-u` stages only changes to tracked files.
  - **CI exercises git+tarball install paths** via a new "consumer artifact smoke test" step.
  - **`--ignore-scripts` risk documented** in COMPATIBILITY.md (consumers running with that flag get an un-built package from git URL).
  - **Test coverage extended.** Reject `public` / `pg_*` / over-63-byte names; trigger-name collision regression test; `pool.end()` clean-exit test under both success and failure.
- **v1 (2026-05-23)** — Initial design. Locked the install path (JS + CLI), schema configurability, first-publish-deferred-until-descent-app, factory-function SQL parameterization, NOTIFY-channel-follows-schema, forward-only/additive upgrade policy, single-package distribution.

---

## Summary

Goal 9 polishes pg-bossier into something a real consumer can adopt without
hand-holding. The programmatic `install(pool)` / `uninstall(pool)` already
work and are idempotent; this goal adds: a **thin CLI wrapper** (`npx
pg-bossier install`, `uninstall`) for ops/CI contexts, **schema
configurability** (the `pgbossier` and `pgboss` schema names become options
rather than hardcoded literals — unblocks multi-instance support in the
N:N-distinct topology and issue #16's schema-per-test isolation),
**hardened schema-name validation** that rejects data-loss-prone names
like `public`, **transactional install** (either-everything-or-nothing
semantics with preflight checks), and a **prepared-but-not-executed
publish workflow** (the `develop → main` mechanics + `npm publish
--dry-run` checks live in `CONTRIBUTING.md`; the actual first `npm
publish` waits until descent-app has validated pg-bossier against a real
workload).

The success criterion for v1 of Goal 9 is **descent-app can install
pg-bossier from a git URL (commit-SHA pinned) or `npm pack` tarball and
have everything work end-to-end** — install, uninstall, the CLI, the
existing operational API (reads, progress, events). The npm-registry
publish is not part of v1's ship criteria; it's documented as the next
step once descent-app's validation is green.

---

## Context — what is already built

- **`install(pool)` and `uninstall(pool)`** in `src/install.ts` — fully idempotent SQL via `IF NOT EXISTS`, `CREATE OR REPLACE`, and `ON CONFLICT`. Symmetric: `DROP SCHEMA pgbossier CASCADE` removes everything pg-bossier owns and leaves `pgboss.job` untouched. Covered by `test/install.test.ts` and `test/uninstall.test.ts`.
- **SQL constants in `src/sql.ts`** — schema/sequence/table/indexes/trigger function/trigger/backfill, all currently hardcoded with the `pgbossier` and `pgboss` schema names. The trigger name is currently hardcoded as `pgbossier_capture` (v2 makes this `${s.pgbossier}_capture`).
- **Upgrade precedent.** Goal 7 added the `seq` column to the existing `pgbossier.record` table via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` plus a regression test that pins the upgrade path against a pre-existing v1 table. The "forward-only / additive" upgrade policy this design ratifies is the same one already used by Goal 7.
- **Package shape.** `package.json` declares `"type": "module"`, `"main"`, `"types"`, `"exports"`, `"files": ["dist"]`, `"prepare": "npm run build"`, `"engines": { "node": ">=18" }`, `pg` + `pg-boss` as peer deps. Builds via `tsc` to `dist/`.
- **Publishing state.** Version `0.0.0` on `develop`. No git tags. Not on npm. CHANGELOG holds everything under `[Unreleased]`.
- **Existing tests.** `vitest` + `@testcontainers/postgresql` against real Postgres + pg-boss 12.18.2. Current test count after Goal 7 is 87 across 10 files.

---

## Goals and non-goals

### What this design ships (v2 of Goal 9)

1. **Schema configurability** — `{ schema?: string, pgbossSchema?: string }` option on `install` / `uninstall` / `bossier()` and on every internal free-function call. Defaults match today's hardcoded names.
2. **Hardened schema-name validation** — Postgres unquoted-identifier shape + explicit block list (`public`, `information_schema`, `pg_*`, reserved keywords) + length ≤ 63 bytes.
3. **A thin CLI** — `npx pg-bossier install [--conn-string=…] [--schema=…] [--pgboss-schema=…]` and `uninstall`. Uses stdlib `util.parseArgs` with `strict: true`. Prints destination connection info before any SQL.
4. **Transactional install** with a preflight check for `${pgbossSchema}.job` existence. Either-everything-or-nothing semantics.
5. **NOTIFY channel scoped to schema** — `${schema}_job` instead of literal `pgbossier_job`. Default remains `pgbossier_job` (no break for existing Goal 7 consumers).
6. **Trigger name scoped to schema** — `${schema}_capture` instead of literal `pgbossier_capture`. Default remains `pgbossier_capture` (no break for existing default-schema consumers).
7. **Supported-topologies section** in the spec naming what works and what doesn't.
8. **Cross-version upgrade policy** ratified: forward-only, additive, idempotent. Non-additive changes require a version bump with a documented manual upgrade path.
9. **First-publish runbook** in `CONTRIBUTING.md` — `develop → main` mechanics, `npm publish --dry-run` checks, version-policy reference. **Not executed in v1.**
10. **Consumable from git URL (SHA-pinned) / `npm pack`** — verified by a CI smoke-test step.
11. **`engines` bumped to `>=18.3.0`** so `util.parseArgs` is unambiguously available.

### What this design deliberately does NOT ship

- **Actually publishing to npm.** Deferred until descent-app validates pg-bossier against a real workload.
- **A separate Prisma adapter package.** pg-bossier doesn't depend on Prisma; coexistence is documentation only.
- **Monorepo / multi-package shape.** Single npm package, same as today.
- **Numbered migration files.** The `install()` function IS the migration.
- **Automatic version detection or "schema is older than client" guard.**
- **GitHub Actions auto-publish on tag push.** Manual `npm publish` is the v1 story.
- **Down-migrations / rollback support.** "Downgrade" is `uninstall(pool)` + reinstall the older version.
- **Multi-writer support** — two pg-bossier installs writing to one `pgboss` schema. Explicitly **unsupported** (see Supported topologies below). Deferred as a separate goal if a real consumer surfaces the need.
- **Quoting all SQL identifiers.** v2 uses narrow validation (block list + length cap) instead of broad quoting. Reserved keywords are rejected at the validation layer; SQL keeps clean bare-identifier interpolation.

---

## Supported topologies

pg-bossier's design admits four topology configurations against pg-boss.
Two are supported in v1; two are not.

| pg-bossier schemas | pg-boss schemas (source) | Support | Behavior |
|---|---|---|---|
| **1** (`pgbossier`) | **1** (`pgboss`) | ✅ **Supported (default)** | The common case. One pg-bossier install captures everything from one pg-boss install. No collisions. |
| **N distinct** (`pgbossier_a`, `pgbossier_b`) | **N distinct** (`pgboss_a`, `pgboss_b`) | ✅ **Supported** | Each pg-bossier install pairs with its own pg-boss install. Trigger names, channel names, and audit tables are all schema-scoped — full isolation. |
| **2** distinct | **1 shared** | ❌ **Unsupported** | Two pg-bossier installs both trigger on the same `pgboss.job`. Even with parameterized trigger names, both fire on every pg-boss op → duplicate captures into both audit tables. If real consumers need this, it's a separate "multi-writer" goal. |
| **1** | **N distinct** | ❌ **Unsupported** | One pg-bossier instance cannot trigger on multiple pg-boss schemas. The `install()` call binds to one `pgbossSchema`. If consumers need this, run multiple installs. |

The supported configurations cover descent-app's actual topology (1:1)
and the schema-per-test isolation case #16 will eventually need (N:N
distinct, where N matches the test parallelism).

---

## Locked decisions

### Decision 1 — Install path: JS function + thin CLI wrapper

The programmatic `install(pool)` / `uninstall(pool)` stays the default. A
new `bin/pgbossier.js` script wraps the same SQL constants with a small
CLI surface for ops / CI contexts. No raw SQL file, no Prisma-migration
form.

Rationale: the JS path works for any Node consumer and integrates into
existing boot scripts. The CLI helps the ~1-hour-adoption promise for
contexts where the consumer doesn't want to wire up a one-off Node
script. Raw SQL files would duplicate the idempotency expressions
already in `src/sql.ts`.

### Decision 2 — Schema names: configurable in v1, narrow validation

`pgbossier` (our own objects) and `pgboss` (the source schema we trigger
on) become options. Defaults match today's hardcoded names. Every SQL
string in `src/sql.ts` becomes a factory function that takes a
`SchemaNames` object and returns the SQL with the schema names
interpolated.

**Validation is policy, not just syntax.** v2 takes the narrow-validation
path (block list + length cap) rather than broad-quoting all identifiers
in SQL — the reasoning is that quoted SQL would make dangerous names like
`"public"` *installable*, which doesn't solve the data-loss issue. The
block list documents the safety contract explicitly:

```ts
const RESERVED_SCHEMA_NAMES = new Set([
  'public',             // user data lives here; uninstall would be catastrophic
  'information_schema', // SQL standard system catalog
]);

// Postgres SQL reserved keywords that fail when used as a bare identifier.
// This is a static subset of pg_get_keywords() — full list maintained inline
// to avoid a runtime DB call for validation.
const RESERVED_KEYWORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'authorization', 'binary', 'both', 'case', 'cast',
  'check', 'collate', 'collation', 'column', 'concurrently', 'constraint',
  'create', 'cross', 'current_catalog', 'current_date', 'current_role',
  'current_schema', 'current_time', 'current_timestamp', 'current_user',
  'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end',
  'except', 'false', 'fetch', 'for', 'foreign', 'freeze', 'from', 'full',
  'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner',
  'intersect', 'into', 'is', 'isnull', 'join', 'lateral', 'leading',
  'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural',
  'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
  'outer', 'overlaps', 'placing', 'primary', 'references', 'returning',
  'right', 'select', 'session_user', 'similar', 'some', 'symmetric',
  'system_user', 'table', 'tablesample', 'then', 'to', 'trailing',
  'true', 'union', 'unique', 'user', 'using', 'variadic', 'verbose',
  'when', 'where', 'window', 'with',
]);
```

Rationale: Codex's R2 argument carried — narrow validation is the cleaner
path. Broad quoting would make `"user"` look supported, which it should
not be for a library that's going to interpolate this into ~25 SQL
statements.

### Decision 3 — First publish: prepare workflow, defer execution

Goal 9 ships the publish runbook in `CONTRIBUTING.md`, makes `npm publish
--dry-run` clean, and ensures the package is installable from a git URL
(SHA-pinned) or local pack. The first actual `npm publish` happens
**after** descent-app has validated pg-bossier against a real production
workload.

---

## SQL parameterization mechanic — factory functions

Factory functions, not placeholder templates or a query builder. SQL
strings stay legible; the schema name is interpolated into a plain
template literal; schema-name validation happens once at the public API
boundary.

```ts
// src/sql.ts (after)

export interface SchemaNames {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  pgbossier: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgboss: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function assertSchemaName(name: string, key: keyof SchemaNames): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `pgbossier: invalid ${key} schema name: ${JSON.stringify(name)}. ` +
      `Must match ${IDENT_RE.source}.`,
    );
  }
  if (name.startsWith('pg_')) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is reserved — ` +
      `Postgres reserves the 'pg_' prefix for system schemas.`,
    );
  }
  if (RESERVED_SCHEMA_NAMES.has(name)) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is reserved — ` +
      `using it would conflict with user data or system catalogs.`,
    );
  }
  if (RESERVED_KEYWORDS.has(name)) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} is a Postgres ` +
      `reserved keyword and cannot be used as a bare identifier.`,
    );
  }
  if (Buffer.byteLength(name, 'utf8') > 63) {
    throw new Error(
      `pgbossier: schema name ${JSON.stringify(name)} exceeds 63 bytes ` +
      `(NAMEDATALEN). Postgres would silently truncate it.`,
    );
  }
}

export function resolveSchemas(opts?: Partial<SchemaNames>): SchemaNames {
  const s: SchemaNames = {
    pgbossier: opts?.pgbossier ?? 'pgbossier',
    pgboss:    opts?.pgboss    ?? 'pgboss',
  };
  assertSchemaName(s.pgbossier, 'pgbossier');
  assertSchemaName(s.pgboss, 'pgboss');
  return s;
}

export function schemaSql(s: SchemaNames): string {
  return `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier};`;
}

export function recordTableSql(s: SchemaNames): string {
  return `CREATE TABLE IF NOT EXISTS ${s.pgbossier}.record (
    job_id uuid NOT NULL, queue text NOT NULL, attempt integer NOT NULL,
    state text NOT NULL, data jsonb, output jsonb, progress jsonb,
    terminal_detail jsonb, input_snapshot jsonb,
    created_on timestamptz, started_on timestamptz, completed_on timestamptz,
    captured_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, attempt)
  );`;
}

// Same factory shape for:
//   sequenceSql, recordSeqColumnSql, recordSeqIndexSql,
//   recordIndexesSql (returns string[]), backfillSql,
//   captureFunctionSql, captureTriggerSql.
```

The five validation gates (regex, `pg_` prefix, reserved-names list,
reserved-keywords list, length) catch all the failure modes the
adversarial review identified.

---

## Install / uninstall API surface

```ts
// src/install.ts (after)

export interface InstallOptions {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

export async function install(
  pool: Pool, options?: InstallOptions,
): Promise<void> {
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    options?.pgbossSchema,
  });
  const client = await pool.connect();
  try {
    // Preflight: confirm the source table exists. Fails fast with a clear
    // error instead of partway through DDL.
    await client.query(`SELECT 1 FROM ${s.pgboss}.job LIMIT 0`);

    // Atomic install: either everything succeeds or nothing changes.
    await client.query('BEGIN');
    await client.query(schemaSql(s));
    await client.query(sequenceSql(s));
    await client.query(recordTableSql(s));
    await client.query(recordSeqColumnSql(s));
    await client.query(recordSeqIndexSql(s));
    for (const idx of recordIndexesSql(s)) await client.query(idx);
    await client.query(captureFunctionSql(s));
    await client.query(captureTriggerSql(s));
    await client.query(backfillSql(s));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function uninstall(
  pool: Pool, options?: Pick<InstallOptions, 'schema'>,
): Promise<void> {
  const s = resolveSchemas({ pgbossier: options?.schema, pgboss: 'pgboss' });
  await pool.query(`DROP SCHEMA IF EXISTS ${s.pgbossier} CASCADE;`);
}
```

Notes:

- The preflight `SELECT 1 FROM ${s.pgboss}.job LIMIT 0` validates that the pg-boss source table exists *before* any mutation. If the `pgbossSchema` is wrong, the error surfaces with a clean "relation `wrong.job` does not exist" message and zero state is created.
- Postgres supports DDL in transactions. The `BEGIN`/`COMMIT` wrapper means a mid-install failure leaves nothing behind — no orphaned `pgbossier` schema, no partial sequence/table, no half-created function.
- `uninstall` only takes `schema` (the pg-bossier schema we own). The schema validation rejects `public` / `information_schema` / `pg_*` so the catastrophic `DROP SCHEMA public CASCADE` path is impossible.

### `bossier()` carries the same options

```ts
export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
  schema?: string;
  pgbossSchema?: string;
}

export function bossier(options: BossierOptions): Bossier {
  const { boss, pool } = options;
  const s = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });
  // Closed-over schemas inside methods map — consumer ergonomics unchanged.
}
```

---

## CLI design

`bin/pgbossier.js` — a Node shebang script using stdlib `util.parseArgs`
with `strict: true`. ~80 lines total. No external CLI dependency.

```bash
pgbossier install   [--conn-string=<url>] [--schema=<n>] [--pgboss-schema=<n>]
pgbossier uninstall [--conn-string=<url>] [--schema=<n>]
pgbossier --help
pgbossier --version

# Connection string resolution (first match wins)
#   1. --conn-string=<url>
#   2. PGBOSSIER_CONN_STRING env var
#   3. DATABASE_URL env var

# Exit codes
#   0  — success
#   1  — usage error / --help shown
#   2  — runtime error (DB connect failed, SQL error)
#   64 — invalid schema name (validation rejection)
```

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { install, uninstall } from 'pg-bossier';

const pkg = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'),
    'utf8',
  ),
);

let exitCode = 0;
let pool = null;

try {
  const { values, positionals } = parseArgs({
    options: {
      'conn-string':   { type: 'string' },
      'schema':        { type: 'string' },
      'pgboss-schema': { type: 'string' },
      'help':          { type: 'boolean', short: 'h' },
      'version':       { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: true,           // ← v2: reject unknown flags with clear error
  });

  if (values.version) { console.log(pkg.version); process.exit(0); }
  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(1);
  }

  const cmd = positionals[0];
  if (cmd !== 'install' && cmd !== 'uninstall') {
    printUsage();
    process.exit(1);
  }

  const connString =
    values['conn-string'] ??
    process.env.PGBOSSIER_CONN_STRING ??
    process.env.DATABASE_URL;
  if (!connString) {
    console.error(
      'pgbossier: no connection string. Pass --conn-string or set ' +
      'PGBOSSIER_CONN_STRING / DATABASE_URL.',
    );
    process.exit(1);
  }

  // Print destination (without credentials) before any SQL runs.
  // Mitigates the DATABASE_URL fallback footgun.
  const url = new URL(connString);
  console.log(
    `pgbossier: ${cmd} into host=${url.host} database=${url.pathname.slice(1)} ` +
    `schema=${values['schema'] ?? 'pgbossier'}` +
    (cmd === 'install' ? ` pgbossSchema=${values['pgboss-schema'] ?? 'pgboss'}` : ''),
  );

  pool = new Pool({
    connectionString: connString,
    connectionTimeoutMillis: 10_000,  // v2: fail fast on bad creds
  });

  if (cmd === 'install') {
    await install(pool, {
      schema:       values['schema'],
      pgbossSchema: values['pgboss-schema'],
    });
    console.log('pgbossier: installed');
  } else {
    await uninstall(pool, { schema: values['schema'] });
    console.log('pgbossier: uninstalled');
  }
} catch (err) {
  if (err instanceof Error && /pgbossier:.*schema name/.test(err.message)) {
    console.error(err.message);
    exitCode = 64;
  } else if (err instanceof Error && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`pgbossier: ${err.message}`);
    exitCode = 1;
  } else {
    console.error(
      `pgbossier: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 2;
  }
} finally {
  if (pool) await pool.end();
}
process.exit(exitCode);  // ← v2: AFTER finally, not before
```

The v2 control flow captures the exit code in a variable, runs `pool.end()`
in the `finally`, and exits *after* the `finally` returns. The v1 sketch
called `process.exit()` before `pool.end()` could await — a real bug.

`package.json` changes:

```jsonc
{
  "engines": { "node": ">=18.3.0" },     // ← v2: parseArgs needs 18.3+
  "files": ["dist", "bin"],
  "bin": { "pgbossier": "./bin/pgbossier.js" },
  "keywords": ["pg-boss", "postgres", "job-queue", "audit", "events", "lifecycle"]
}
```

---

## NOTIFY channel and trigger name — both schema-scoped

Two correctness fixes in one. Without them, two pg-bossier installs collide.

**NOTIFY channel.** Was hardcoded as `'pgbossier_job'`. Now `${s.pgbossier}_job`. Default unchanged for existing consumers.

**Trigger name.** Was hardcoded as `pgbossier_capture`. Now `${s.pgbossier}_capture`. Without this, install B's `DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job` clobbers install A's trigger — install A silently stops capturing.

Both changes:

- **`captureFunctionSql`** — the `pg_notify` call interpolates `${s.pgbossier}_job` as the channel name.
- **`captureTriggerSql`** — the trigger name itself becomes `${s.pgbossier}_capture`.

```ts
export function captureTriggerSql(s: SchemaNames): string {
  return `
    DROP TRIGGER IF EXISTS ${s.pgbossier}_capture ON ${s.pgboss}.job;
    CREATE TRIGGER ${s.pgbossier}_capture
      AFTER INSERT OR UPDATE OF state ON ${s.pgboss}.job
      FOR EACH ROW EXECUTE FUNCTION ${s.pgbossier}.capture();
  `;
}
```

- **`src/events.ts`** — `LISTEN ${s.pgbossier}_job` instead of literal; same value used in the notification-channel comparison.
- **`COMPATIBILITY.md`** — Goal 7's channel-name paragraph updates: "The default channel is `pgbossier_job`; with a non-default `schema` option, the channel is `${schema}_job`."

---

## Cross-version upgrade policy

**Forward-only, additive, idempotent.** Goal 7's `seq` column added cleanly to a pre-existing `pgbossier.record` table via this exact pattern. The existing test pins the policy for that case.

**Non-additive changes** require a version bump:
- Pre-1.0: minor bump (`0.1 → 0.2`) with CHANGELOG calling out the schema change and manual upgrade SQL.
- Post-1.0: major bump under the same documentation rule.

**Down-migration** is `uninstall(pool)` + reinstall the older pg-bossier version. Acceptable because pg-bossier is fail-open and audit-only.

**The destructive-change cliff.** `install()` cannot do `ALTER TABLE DROP COLUMN IF EXISTS` because re-running it on an install that never had the column would still try to drop. The policy is **add only, never remove via `install()`**.

---

## Distribution shape — single npm package

Stay single. `pg-bossier` ships as one package with `pg` and `pg-boss` as peer deps.

**package.json final shape (v2 changes marked):**

```jsonc
{
  // existing fields unchanged...
  "engines": { "node": ">=18.3.0" },        // ← v2: parseArgs needs 18.3+
  "files": ["dist", "bin"],                  // ← v2: bin/ shipped
  "bin": { "pgbossier": "./bin/pgbossier.js" }, // ← v2: CLI entry
  "keywords": [
    "pg-boss", "postgres", "job-queue",
    "audit", "events", "lifecycle"
  ]
}
```

---

## Prisma coexistence ⚠️

> **⚠️ If you use Prisma with `multiSchema` preview, you MUST exclude
> the `pgbossier` schema from your `datasource.schemas` list.**
>
> `prisma db pull` with `multiSchema` enabled introspects all schemas in
> the database by default — including `pgbossier`. The resulting
> `schema.prisma` would include pg-bossier's tables. Running
> `prisma migrate dev` against that schema would try to drop or migrate
> pg-bossier's tables — **destructive failure**.

The base coexistence story (without `multiSchema`) is simpler:

- Prisma's `prisma migrate` and `prisma db pull` (without `multiSchema`) only manage the schemas declared in your Prisma datasource. The `pgbossier` schema is not declared, so Prisma doesn't see it.
- `install(pool)` runs once per deployment — typically at app boot or in a one-shot script. It's idempotent; safe to run on every deploy.

For consumers using `multiSchema`, the explicit `datasource.schemas`
list must exclude `pgbossier` (and your custom `schema` option if set).
README's "Install" section documents this with a config example.

---

## First-publish runbook — prepared but unused in v1

```
# 1. On develop, verify everything green:
npm run lint && npm run build && npm test
npm publish --dry-run

# 2. Decide the version. First release = 0.1.0.

# 3. Switch to main, snapshot develop's tree onto it (NOT a git merge):
git checkout main
git status                          # MUST be clean — no untracked files
git read-tree -u --reset develop

# 4. Stage tracked changes only (NOT -A, which sweeps untracked files):
git add -u                          # ← v2: -u, not -A
# Then in package.json: 0.0.0 → 0.1.0
# Then in CHANGELOG.md: rename [Unreleased] → [0.1.0] - 2026-MM-DD,
#   add fresh [Unreleased] header.
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release 0.1.0"
git tag v0.1.0
git push origin main --follow-tags

# 5. Back on develop, open a fresh [Unreleased] for the next cycle:
git checkout develop
# Edit CHANGELOG.md to add empty [Unreleased] header back.
git commit -am "chore(changelog): open fresh [Unreleased] for next cycle"
git push origin develop

# 6. From main, publish:
git checkout main
npm publish
```

**Until step 6 runs**, consumers install pg-bossier via:

```
# Primary (reproducible — SHA-pinned):
npm install git+https://github.com/elfensky/pg-bossier#68fd7bb

# Development tracking (non-reproducible — re-resolves to branch head):
npm install git+https://github.com/elfensky/pg-bossier#develop

# Local tarball:
cd pg-bossier && npm pack
cd ../descent-app && npm install ../pg-bossier/pg-bossier-0.0.0.tgz
```

**SHA-pinned form is primary** because branch refs in `package-lock.json`
re-resolve to the branch head on every `npm ci` — non-reproducible
across rebuilds.

**Install-path behavior precision:**

- **Git URL install** — npm runs `prepare` after cloning; the consumer gets a fresh `tsc`-built `dist/`. Requires `prepare` to not be disabled (`--ignore-scripts` skips it).
- **`npm pack` tarball install** — `prepare` runs at PACK time, not at consumer install time. The tarball contains pre-built `dist/`; consumers extract it without re-running `tsc`.
- **`--ignore-scripts`** — consumers running `npm ci --ignore-scripts` (some security-conscious CI environments do) on a git URL install get an un-built package. Document this in `COMPATIBILITY.md` as a known constraint.

**Version policy reference:**
- v0.1.0 = first release. Everything in `[Unreleased]` bundles into the 0.1.0 entry.
- v0.x.y while the API surface is still maturing. Minor bumps for features, patch bumps for fixes. Non-additive schema changes are minor bumps under 0.x.
- v1.0.0 only when the API surface is committed.

---

## Tests

New + extended integration tests:

| File | What it covers |
|---|---|
| `test/install.test.ts` (extend) | `install(pool, { schema: 'altbossier' })` creates the alt-schema sequence/table/trigger; trigger name is `altbossier_capture` (NOT `pgbossier_capture`); two non-overlapping schemas installed in the same DB work independently with distinct triggers and distinct NOTIFY channels. **Trigger-name-collision regression**: install schema=A, install schema=B with the same `pgboss` source, assert install A's trigger STILL EXISTS afterwards. |
| `test/uninstall.test.ts` (extend) | `uninstall(pool, { schema: 'altbossier' })` drops only the alt schema. **`public` rejection regression**: `assertSchemaName('public')` throws; `uninstall(pool, { schema: 'public' })` throws BEFORE any SQL runs. |
| `test/install.test.ts` (extend) | **Transactional install**: mock the trigger-creation step to fail (or pass a bad `pgbossSchema`); assert the `pgbossier` schema does NOT exist after the failure (transaction rolled back). |
| `test/install.test.ts` (extend) | **Preflight check**: `install(pool, { pgbossSchema: 'wrong' })` fails on the preflight `SELECT 1 FROM wrong.job LIMIT 0` step, NOT on the trigger creation. Error message mentions `wrong.job`. |
| `test/sql.test.ts` (new, fast — no container) | Schema-name validation cases: valid lowercase ident accepted; quotes/dots/spaces rejected; `public` rejected; `information_schema` rejected; `pg_*` rejected; 64-byte name rejected; `user`/`select`/`from`/etc. reserved keywords rejected. |
| `test/cli.test.ts` (new) | `pgbossier --help` exit 1, prints usage; `pgbossier --version` exit 0 prints version; `pgbossier install` with no conn-string exit 1; **unknown flag exit 1** (verifies `strict: true`); invalid schema name exit 64; success path exit 0; **`pool.end()` clean exit** — process exits within ~500ms of completion (verifies the finally + post-finally exit code pattern); destination printed before SQL. |
| `test/events.test.ts` (extend) | Channel name follows schema option: `subscribe(pool, { schema: 'alt' })` listens on `alt_job`, not `pgbossier_job`. |
| `test/install.test.ts` (extend) | Re-running `install()` against a v1-shape (pre-`seq`) table is idempotent — confirms the upgrade-path contract still holds with all the new factory functions. |
| `test/install.test.ts` or new `test/topology.test.ts` | **Unsupported topology**: attempting `install` with default `pgbossSchema` twice into two distinct `pgbossier` schemas → both succeed (trigger names are distinct now), but both fire on every pg-boss op (duplicate capture). Test asserts this is the observed behavior and the spec documents it as unsupported. |

**Smoke test in CI** — new step that exercises the actual consumer artifact:

```yaml
# .github/workflows/ci.yml (new job)
consumer-artifact-smoke-test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '22', cache: npm }
    - run: npm ci && npm run build
    - run: npm pack
    - name: Install tarball in a fresh consumer dir
      run: |
        TARBALL=$(ls pg-bossier-*.tgz)
        mkdir /tmp/consumer && cd /tmp/consumer
        npm init -y
        npm install "$GITHUB_WORKSPACE/$TARBALL"
        # Verify the consumer gets a working bin script:
        npx pgbossier --version
        # Verify the consumer gets dist/ (no rebuild on tarball install):
        test -f node_modules/pg-bossier/dist/index.js
```

---

## File layout

**New**
- `bin/pgbossier.js` — CLI entry point (Node shebang script, ~80 lines, stdlib only).
- `test/sql.test.ts` — fast schema-name validation tests (no container).
- `test/cli.test.ts` — CLI integration tests (one container per file).
- `CONTRIBUTING.md` — release runbook + general contribution notes.

**Changed**
- `src/sql.ts` — factory functions, schema-name validation, `RESERVED_*` lists, schema-scoped trigger name in `captureTriggerSql`.
- `src/install.ts` — accepts `InstallOptions`, transaction wrapper, preflight check.
- `src/client.ts`, `src/read.ts`, `src/events.ts`, `src/progress.ts` — accept and propagate `SchemaNames` to the SQL factories they call.
- `src/index.ts` — re-exports `InstallOptions`, `SchemaNames`.
- `package.json` — `bin`, `engines >=18.3.0`, `files: ["dist", "bin"]`, `keywords`.
- `README.md` — new "Install" section, Prisma callout, supported topologies note.
- `COMPATIBILITY.md` — schema-scoped channel + trigger note, `--ignore-scripts` note.
- `CHANGELOG.md` — entry under `[Unreleased]` for the v2 design.
- `CLAUDE.md` — Goal 9 marked delivered in the status paragraph and goal-status table.
- `.github/workflows/ci.yml` — new `consumer-artifact-smoke-test` job.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Consumer passes `public` or other destructive schema name and the regex misses it | None — `assertSchemaName` block list prevents this at the API boundary | Block list (`public`, `information_schema`, `pg_*`, reserved keywords, > 63 bytes) tested with explicit cases |
| Two installs collide on the trigger name | None — trigger is schema-scoped to `${s.pgbossier}_capture` | Test pins this with the trigger-name-collision regression |
| Schema mismatch between `install` and `bossier()` | Medium — easy mistake | README example uses a single `const schemas = { schema: 'x' }` const passed to both |
| Pre-existing 0.0.0 dev environments push the wrong version | Low — only the release-runbook commit bumps the version | Runbook explicit |
| First `npm publish` fails (registry config, ownership, scope) | Low | `npm publish --dry-run` step 1 surfaces this before the real publish; publish is deferred until descent-app validation |
| Channel-name change breaks existing Goal 7 consumers | None — defaults unchanged | Default-path tests stay green |
| Bin script doesn't get executable permission on consumer install | Low — npm sets +x on `bin` entries automatically | The new consumer-artifact smoke test verifies `npx pgbossier --version` works |
| Consumer with `multiSchema` enabled in Prisma silently lets `db pull` introspect pgbossier | Medium-low — documented as a ⚠️ in README and COMPATIBILITY | Documentation is the contract; can't enforce in code |
| Consumer installs from git URL but the `prepare` build fails on their Node version | Low — engines `>=18.3.0`; consumers using pg-boss already have ≥18 | `engines` declared; `prepare` runs `tsc`; fast fail with a real error |
| Consumer uses `npm ci --ignore-scripts` and gets an un-built package from a git URL | Medium — common in security-conscious CI | Documented in COMPATIBILITY.md; tarball install is the workaround |
| Destructive schema change needed later and "add only, never remove" boxes us in | Low | Policy documented; non-additive changes are an explicit version-bump path with manual migration SQL in the CHANGELOG |
| User runs the CLI against the wrong DB because `DATABASE_URL` points elsewhere | Medium → Low | CLI prints destination (host + database + schema) before any SQL runs; consumer can Ctrl-C |
| Bad credentials cause CLI to hang on `new Pool()` | None — `connectionTimeoutMillis: 10_000` | Documented; tested in the CLI test |
| Branch-ref git installs are non-reproducible across `npm ci` | Documented — SHA-pinning is the primary form | Runbook + README show SHA as primary |
| Two installs share a `pgboss` schema and duplicate captures | Documented as unsupported in "Supported topologies" | Test pins the observed behavior; spec says "unsupported" |

---

## Open question for the implementation plan

- Should the bin script `import { install } from 'pg-bossier'` (using the package's own public API after `npm install`) or `import { install } from '../dist/install.js'` (relative path)? The first is more honest about the public-surface contract; the second works during development before `dist/` is at a stable path. Decide in the implementation plan; doesn't affect the spec.

---

## Related

- [Storage substrate design (2026-05-20)](../archive/2026-05-20-storage-architecture-design.md)
- [Goal 7 lifecycle events design (2026-05-22, v2)](../archive/2026-05-22-goal-7-lifecycle-events-design.md) — precedent for schema-scoped NOTIFY channel design and the seq-column upgrade pattern.
- [Goal 6 progress design (2026-05-21)](../archive/2026-05-21-goal-6-progress-api-design.md) — pattern for client-method wrappers that close over per-construction state.
- [Goal 9 adversarial review synthesis (2026-05-23)](../debates/2026-05-23-goal-9-spec-adversarial-review/99-synthesis.md)
- [Issue #10 — Goal 9: Install/uninstall surface](https://github.com/elfensky/pg-bossier/issues/10)
- [Issue #16 — Test infrastructure: adapt pg-boss's testing approach](https://github.com/elfensky/pg-bossier/issues/16) — schema-per-test isolation enabled by Decision 2.
- [pg-boss `schema` option](https://github.com/timgit/pg-boss/blob/master/docs/configuration.md) — precedent for configurable schema on a similar library.
- [Node `util.parseArgs` docs](https://nodejs.org/api/util.html#utilparseargsconfig) — stdlib CLI flag parsing used by `bin/pgbossier.js`.

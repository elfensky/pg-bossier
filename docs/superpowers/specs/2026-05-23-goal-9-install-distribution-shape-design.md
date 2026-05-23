# Goal 9 — Install / distribution shape: design

**Date:** 2026-05-23
**Sub-issue:** [#10](https://github.com/elfensky/pg-bossier/issues/10)
**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
**Status:** Design — pre-implementation. Builds on the storage substrate (PR #15), Goal 7's `seq`-column upgrade precedent, and the existing programmatic `install(pool)` / `uninstall(pool)`.

---

## Summary

Goal 9 polishes pg-bossier into something a real consumer can adopt without
hand-holding. The programmatic `install(pool)` / `uninstall(pool)` already
work and are idempotent; this goal adds three things alongside: a **thin CLI
wrapper** (`npx pg-bossier install`, `uninstall`) for ops/CI contexts, **schema
configurability** (the `pgbossier` and `pgboss` schema names become options
rather than hardcoded literals — unblocks multi-instance support and
issue #16's schema-per-test isolation), and a **prepared-but-not-executed
publish workflow** (the `develop → main` mechanics + `npm publish --dry-run`
checks live in `CONTRIBUTING.md`; the actual first `npm publish` waits until
descent-app has validated pg-bossier against a real workload).

The success criterion for v1 of Goal 9 is **descent-app can install
pg-bossier from a git URL or `npm pack` tarball and have everything work
end-to-end** — install, uninstall, the CLI, the existing operational API
(reads, progress, events). The npm-registry publish is not part of v1's
ship criteria; it's documented as the next step once descent-app's
validation is green.

---

## Context — what is already built

- **`install(pool)` and `uninstall(pool)`** in `src/install.ts` — fully idempotent SQL via `IF NOT EXISTS`, `CREATE OR REPLACE`, and `ON CONFLICT`. Symmetric: `DROP SCHEMA pgbossier CASCADE` removes everything pg-bossier owns and leaves `pgboss.job` untouched. Covered by `test/install.test.ts` and `test/uninstall.test.ts`.
- **SQL constants in `src/sql.ts`** — schema/sequence/table/indexes/trigger function/trigger/backfill, all currently hardcoded with the `pgbossier` and `pgboss` schema names.
- **Upgrade precedent.** Goal 7 added the `seq` column to the existing `pgbossier.record` table via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` plus a regression test that pins the upgrade path against a pre-existing v1 table. The "forward-only / additive" upgrade policy this design ratifies is the same one already used by Goal 7.
- **Package shape.** `package.json` declares `"type": "module"`, `"main"`, `"types"`, `"exports"`, `"files": ["dist"]`, `"prepare": "npm run build"`, `"engines": { "node": ">=18" }`, `pg` + `pg-boss` as peer deps. Builds via `tsc` to `dist/`.
- **Publishing state.** Version `0.0.0` on `develop`. No git tags. Not on npm. CHANGELOG holds everything under `[Unreleased]`.
- **Existing tests.** `vitest` + `@testcontainers/postgresql` against real Postgres + pg-boss 12.18.2. The current test count after Goal 7 is 87 across 10 files.

---

## Goals and non-goals

### What this design ships (v1 of Goal 9)

1. **Schema configurability.** `{ schema?: string, pgbossSchema?: string }` option on `install` / `uninstall` / `bossier()` and on every internal free-function call (`findById`, `subscribe`, etc.). Defaults are the current hardcoded names.
2. **A thin CLI.** `npx pg-bossier install [--conn-string=…] [--schema=…] [--pgboss-schema=…]` and `uninstall`. ~70 lines of Node using stdlib `util.parseArgs`. No new runtime dependency.
3. **NOTIFY channel scoped to schema.** `${schema}_job` instead of literal `pgbossier_job`. Default remains `pgbossier_job` (no break for existing Goal 7 consumers).
4. **Cross-version upgrade policy** ratified: forward-only, additive, idempotent. Non-additive changes require a version bump (minor on 0.x, major on ≥1.x) with a documented manual upgrade path.
5. **First-publish runbook** in `CONTRIBUTING.md` — `develop → main` mechanics, `npm publish --dry-run` checks, version-policy reference. **Not executed in v1.**
6. **Consumable from git URL / `npm pack`** — already works via the existing `prepare` script (`tsc` runs on install from git or tarball); we just verify it explicitly in CI.
7. **Schema-name validation** at the public API boundary — regex `^[a-z_][a-z0-9_]*$` (Postgres unquoted-identifier rules); invalid names rejected with a clear `Error` before any SQL builds.

### What this design deliberately does NOT ship

- **Actually publishing to npm.** Deferred until descent-app validates pg-bossier against a real workload (consumer-driven gate). Goal 9 documents the publish flow; the user runs it when ready.
- **A separate Prisma adapter package.** pg-bossier doesn't depend on Prisma; coexistence is documentation only.
- **Monorepo / multi-package shape.** Single npm package, same as today.
- **Numbered migration files (`migrations/00001_…sql`).** The `install()` function IS the migration; its idempotent shape produces the same end state regardless of which prior version was installed. Numbered migrations become a separate goal only when a concrete non-additive change forces the question.
- **Automatic version detection or "schema is older than client" guard.** No runtime check. The CHANGELOG documents non-additive changes; consumers manage upgrade order.
- **GitHub Actions auto-publish on tag push.** Manual `npm publish` is the v1 story.
- **Down-migrations / rollback support.** "Downgrade" is `uninstall(pool)` + reinstall the older version. Acceptable because pg-bossier is fail-open and audit-only.
- **Multi-pg-bossier-instance-per-schema.** Not a thing; one install per schema name, by design.

---

## Locked decisions

### Decision 1 — Install path: JS function + thin CLI wrapper

The programmatic `install(pool)` / `uninstall(pool)` stays the default. A new
`bin/pgbossier.js` script wraps the same SQL constants with a small CLI
surface for ops / CI contexts. No raw SQL file, no Prisma-migration form.

Rationale: the JS path works for any Node consumer and integrates into
existing boot scripts. The CLI helps the ~1-hour-adoption promise for
contexts where the consumer doesn't want to wire up a one-off Node script
(e.g., a Postgres bootstrap step in CI/CD). Raw SQL files would duplicate
the idempotency expressions already in `src/sql.ts` — divergence risk for
zero new capability.

### Decision 2 — Schema names: configurable in v1

`pgbossier` (our own objects) and `pgboss` (the source schema we trigger on)
become options. Defaults match today's hardcoded names. Every SQL string in
`src/sql.ts` becomes a factory function that takes a `SchemaNames` object
and returns the SQL with the schema names interpolated.

Rationale: unblocks multi-instance pg-bossier (two installs in different
schemas on the same database), unblocks issue #16's schema-per-test
isolation, and matches the existing precedent of `pg-boss` itself supporting
`new PgBoss({ schema: 'custom' })`. The cost (~7 source files touched + a
schema-name validation layer + extended tests) is bounded and one-time.

### Decision 3 — First publish: prepare workflow, defer execution

Goal 9 ships the publish runbook in `CONTRIBUTING.md`, makes
`npm publish --dry-run` clean, and ensures the package is installable from
a git URL or local pack. The first actual `npm publish` happens **after**
descent-app has validated pg-bossier against a real production workload —
that validation, not the existence of the runbook, is the real ship gate.

Rationale: irreversibility. Once `0.1.0` is on npm, unpublishing leaves
consumers with broken lockfiles. Validating against the primary consumer
before publishing protects everyone.

---

## SQL parameterization mechanic — factory functions

The chosen approach is **factory functions**, not placeholder templates or a
query builder. SQL strings stay legible; the schema name is interpolated
into a plain template literal; schema-name validation happens once at the
public API boundary.

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

The `assertSchemaName` regex `^[a-z_][a-z0-9_]*$` matches Postgres
unquoted-identifier rules. Anything else (quotes, dots, spaces, leading
digits, uppercase) is rejected with a clear `Error` *before* any SQL string
gets built — so no SQL injection vector ever reaches a query.

Read-side modules (`src/read.ts`, `src/progress.ts`, `src/events.ts`) also
get small refactors: the free functions accept a `SchemaNames` parameter,
the client wrapper closes over the resolved schemas once and supplies them
to each call. Consumer code calling `client.findById(jobId)` is unchanged.

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
  await pool.query(schemaSql(s));
  await pool.query(sequenceSql(s));
  await pool.query(recordTableSql(s));
  await pool.query(recordSeqColumnSql(s));
  await pool.query(recordSeqIndexSql(s));
  for (const idx of recordIndexesSql(s)) await pool.query(idx);
  await pool.query(captureFunctionSql(s));
  await pool.query(captureTriggerSql(s));
  await pool.query(backfillSql(s));
}

export async function uninstall(
  pool: Pool, options?: Pick<InstallOptions, 'schema'>,
): Promise<void> {
  const s = resolveSchemas({ pgbossier: options?.schema, pgboss: 'pgboss' });
  await pool.query(`DROP SCHEMA IF EXISTS ${s.pgbossier} CASCADE;`);
}
```

Notes:

- `uninstall` only takes `schema` (the pg-bossier schema we own); it never
  references `pgboss` because we don't drop someone else's schema.
- The CASCADE drop removes the schema, the table, the sequence, the
  function, and (cascading from the function) the trigger on
  `${pgbossSchema}.job`. Confirmed by the existing `uninstall.test.ts`.
- A consumer who passes `pgbossSchema: 'wrong'` to `install()` will get a
  Postgres error on the `CREATE TRIGGER` statement ("relation
  `wrong.job` does not exist"). Fail-loud, not silent.

### `bossier()` carries the same options

```ts
// src/client.ts (changes only)
export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

export function bossier(options: BossierOptions): Bossier {
  const { boss, pool } = options;
  const s = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });
  const methods: BossierMethods = {
    recordPatch: (jobId, attempt, patch) =>
      recordPatch(pool, s, jobId, attempt, patch),
    findById:    <I, O>(jobId) => findById<I, O>(pool, s, jobId),
    getEventsSince: <I, O>(since, opts) =>
      getEventsSince<I, O>(pool, s, since, opts),
    subscribe:   (opts) => subscribe(pool, s, opts),
    setProgress: (jobId, progress) => setProgress(pool, s, jobId, progress),
    // … and the other read methods, all closing over `s`.
  };
  // The proxy itself (pg-boss method forwarding) is unchanged.
}
```

Consumer ergonomics don't change: `client.findById(jobId)` works exactly
the same way it did before — schemas are resolved once at `bossier({...})`
construction and closed over inside each method.

Internal free functions (`findById(pool, schemas, jobId)`,
`subscribe(pool, schemas, opts)`, etc.) accept an explicit `SchemaNames`
argument. Tests use this form to exercise non-default schemas.

---

## CLI design

`bin/pgbossier.js` — a Node shebang script using stdlib `util.parseArgs`.
~70 lines total. No external CLI dependency.

```bash
# Commands
pgbossier install   [--conn-string=<url>] [--schema=<n>] [--pgboss-schema=<n>]
pgbossier uninstall [--conn-string=<url>] [--schema=<n>]
pgbossier --help
pgbossier --version

# Connection string resolution (first match wins)
#   1. --conn-string=<url>
#   2. PGBOSSIER_CONN_STRING env var
#   3. DATABASE_URL env var
# Missing → exit 1, usage error.

# Exit codes
#   0  — success
#   1  — usage error / --help shown
#   2  — runtime error (DB connect failed, SQL error)
#   64 — invalid schema name
```

Sketch:

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

const { values, positionals } = parseArgs({
  options: {
    'conn-string':   { type: 'string' },
    'schema':        { type: 'string' },
    'pgboss-schema': { type: 'string' },
    'help':          { type: 'boolean', short: 'h' },
    'version':       { type: 'boolean', short: 'v' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.version) { console.log(pkg.version); process.exit(0); }
if (values.help || positionals.length === 0) { printUsage(); process.exit(1); }

const cmd = positionals[0];
const connString =
  values['conn-string'] ??
  process.env.PGBOSSIER_CONN_STRING ??
  process.env.DATABASE_URL;
if (!connString) {
  console.error('pgbossier: no connection string. Pass --conn-string or set PGBOSSIER_CONN_STRING / DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({ connectionString: connString });
try {
  if (cmd === 'install') {
    await install(pool, {
      schema:       values['schema'],
      pgbossSchema: values['pgboss-schema'],
    });
    console.log('pgbossier: installed');
  } else if (cmd === 'uninstall') {
    await uninstall(pool, { schema: values['schema'] });
    console.log('pgbossier: uninstalled');
  } else {
    printUsage(); process.exit(1);
  }
  process.exit(0);
} catch (err) {
  if (err instanceof Error && /invalid (pgbossier|pgboss) schema name/.test(err.message)) {
    console.error(err.message);
    process.exit(64);
  }
  console.error(`pgbossier: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
} finally {
  await pool.end();
}
```

`package.json` gains `"bin": { "pgbossier": "./bin/pgbossier.js" }` and the
bin script is included via `"files": ["dist", "bin"]`. npm sets executable
bits on bin scripts automatically.

---

## NOTIFY channel becomes schema-scoped

This is a correctness fix, not just an ergonomic change. Without it, two
pg-bossier installs on different schemas in the same database would
cross-pollinate each other's notifications on the shared `pgbossier_job`
channel.

Changes:

- **`captureFunctionSql`** — the `pg_notify` call interpolates `${s.pgbossier}_job` as the channel name (was hardcoded `'pgbossier_job'`).
- **`src/events.ts`** — `LISTEN ${s.pgbossier}_job` instead of `LISTEN pgbossier_job`; the `msg.channel !== '${s.pgbossier}_job'` guard uses the same value; the channel constant becomes a per-subscriber property closed over from `subscribe(pool, schemas, opts)`.
- **Default behavior unchanged.** `subscribe(pool)` against an `install(pool)` (both with defaults) still uses `pgbossier_job` — no break for existing Goal 7 consumers.
- **`COMPATIBILITY.md`** — the channel-name paragraph in the "Unsupported topologies (Goal 7)" section updates to: "The default channel is `pgbossier_job`; with a non-default `schema` option, the channel is `${schema}_job`."

---

## Cross-version upgrade policy

**Forward-only, additive, idempotent.**

The single `install()` function IS the migration. Re-running it against an
older `pgbossier` schema upgrades it in place via the same idempotent
patterns we already use:

- `CREATE … IF NOT EXISTS` for sequences, tables, indexes.
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for new columns.
- `CREATE OR REPLACE FUNCTION` for trigger function bodies.

We have **one precedent already**: Goal 7's `seq` column added cleanly to
a pre-existing `pgbossier.record` table via this exact pattern. The
existing test `'install adds seq column to a pre-existing v1 pgbossier.record (upgrade path)'`
pins the policy for that case.

**Non-additive changes** (renaming a column, changing a column type,
dropping a column) require a version bump and a documented manual upgrade
path:

- Pre-1.0 (`0.x.y`): minor bump (`0.1 → 0.2`) with the CHANGELOG entry calling out the schema change and the manual upgrade SQL.
- Post-1.0: major bump (`1.x → 2.0`) under the same documentation rule.

**Down-migration** is `uninstall(pool)` + reinstall the older
pg-bossier version. This loses audit data; acceptable because the audit
table is consumer-owned and pg-bossier is fail-open by design.

**The destructive-change cliff.** `install()` cannot do
`ALTER TABLE DROP COLUMN IF EXISTS` because re-running it on an install
that never had the column would still try to drop. The policy is **add
only, never remove via `install()`**. Removals are manual,
CHANGELOG-documented, and tied to a version bump.

---

## Distribution shape — single npm package

Stay single. `pg-bossier` ships as one package with `pg` and `pg-boss` as
peer deps. No monorepo, no separate Prisma adapter, no
`@pgbossier/core` + `@pgbossier/prisma` split.

**Why this holds for v1:**

- pg-bossier doesn't depend on Prisma — it only needs a `pg.Pool`. Consumers using Prisma already have a Pool available; they pass it in.
- A separate Prisma adapter would only matter if pg-bossier needed to *use* Prisma's transaction context, not just coexist with it. It doesn't.
- The package.json already has the right shape; the only changes for Goal 9 are the `bin` entry and `bin/` in `files`.

**package.json changes:**

```jsonc
{
  // existing fields unchanged...
  "files": ["dist", "bin"],
  "bin": { "pgbossier": "./bin/pgbossier.js" },
  "keywords": ["pg-boss", "postgres", "job-queue", "audit", "events", "lifecycle"]
  // keywords already may be partial; ensure the full set is present
}
```

---

## Prisma coexistence — documentation, not code

The story is "they don't interfere because they don't overlap":

- Prisma's `prisma migrate` and `prisma db pull` only manage schemas declared in the consumer's `schema.prisma`. The `pgbossier` schema is not declared there, so Prisma doesn't see it.
- Consumers using Prisma's `multiSchema` preview feature **should not** add `pgbossier` to their declared schemas. Doing so would bring pg-bossier into their Prisma migration history, which fights `install()`'s idempotent migration story.
- `install(pool)` runs once per deployment — typically at app boot or in a one-shot script. It's idempotent; safe to run on every deploy.

This goes in `README.md` under a "Prisma coexistence" subsection of the
install docs. No code change is needed; coexistence is a documentation
contract.

---

## First-publish runbook — prepared but unused in v1

The actual first `npm publish` happens **after** descent-app validates
pg-bossier against a real workload. The runbook below lives in a new
`CONTRIBUTING.md` so it's executable when the gate opens.

```
# 1. On develop, verify everything green:
npm run lint && npm run build && npm test
npm publish --dry-run
#    → surfaces metadata/files issues without publishing; the `prepare`
#      script (tsc) runs, so this also confirms dist/ builds correctly.

# 2. Decide the version. First release = 0.1.0 per CLAUDE.md's
#    "while on 0.x.y the API is unstable" + semver convention.

# 3. Switch to main, snapshot develop's tree onto it.
#    NOTE: develop and main have unrelated histories by design — we use a
#    tree snapshot, NOT git merge or git merge --squash, which would conflict.
git checkout main
git read-tree -u --reset develop
# main's index + working tree now equal develop's tree exactly.

# 4. In ONE commit on main, bump version and rename [Unreleased]:
#    - package.json + package-lock.json:  0.0.0 → 0.1.0
#    - CHANGELOG.md:
#        rename "## [Unreleased]" → "## [0.1.0] - 2026-MM-DD"
#        add fresh empty "## [Unreleased]" block above it for next cycle.
git add -A
git commit -m "Release 0.1.0"
git tag v0.1.0
git push origin main --follow-tags

# 5. Back on develop, open a fresh [Unreleased] block for the next cycle:
git checkout develop
# (edit CHANGELOG.md to add the empty [Unreleased] header back at the top)
git commit -am "chore(changelog): open fresh [Unreleased] for next cycle"
git push origin develop

# 6. From main, publish:
git checkout main
npm publish
# You provide npm credentials. The prepare script runs tsc.
```

**Until step 6 runs**, consumers (including descent-app for validation)
install pg-bossier via:

```
npm install git+https://github.com/elfensky/pg-bossier#develop
# or, for a specific commit:
npm install git+https://github.com/elfensky/pg-bossier#68fd7bb
# or, for a local tarball:
cd pg-bossier && npm pack
cd ../descent-app && npm install ../pg-bossier/pg-bossier-0.0.0.tgz
```

All three install paths exercise the existing `prepare: "npm run build"`
hook — npm runs `tsc` after install and the consumer gets a built
`dist/`. This is already how the package works; Goal 9 verifies it in CI
but doesn't add machinery for it.

**Version policy reference** (excerpt from CLAUDE.md, restated here for
the runbook):

- v0.1.0 = first release. Everything currently in `[Unreleased]` (substrate, Goal 5, Goal 6, Goal 7, Goal 8, perf budget, Goal 9) bundles into the 0.1.0 changelog entry.
- v0.x.y while the API surface is still maturing (Goals 2/3/4 still pending). Minor bumps for features, patch bumps for fixes. Non-additive schema changes are minor bumps under 0.x.
- v1.0.0 only when the API surface is committed (likely after all 9 goals deliver and a stabilization window).

---

## Tests

New + extended integration tests:

| File | What it covers |
|---|---|
| `test/install.test.ts` (extend) | `install(pool, { schema: 'altbossier' })` creates the alt-schema sequence/table/trigger; `install(pool, { pgbossSchema: 'altpgboss' })` triggers off the right table (after the consumer manually `CREATE SCHEMA altpgboss; CREATE TABLE altpgboss.job (…)` for the test); two non-overlapping schemas installed in the same DB work independently. |
| `test/uninstall.test.ts` (extend) | `uninstall(pool, { schema: 'altbossier' })` drops only the alt schema; the default `pgbossier` schema (if also installed) survives untouched. |
| `test/sql.test.ts` (new, fast — no container) | Schema-name validation: every valid Postgres-ident-shape name accepted; names with quotes / dots / spaces / leading digits / uppercase rejected with the documented error message and matching exit code path. |
| `test/cli.test.ts` (new, container) | `pgbossier --help` exit 1, prints usage; `pgbossier --version` exit 0 prints version from package.json; `pgbossier install` with no conn-string exit 1; invalid schema name → exit 64; success path against a testcontainer → exit 0. Spawns the bin script via `child_process.spawn`. |
| `test/events.test.ts` (extend) | Channel name follows the schema option: `subscribe(pool, { schema: 'alt' })` listens on `alt_job`, not `pgbossier_job`. Existing default-schema tests stay green. |
| `test/install.test.ts` (extend) | Re-running `install()` after a Goal 7-style additive change (e.g., we add a new index in a future version) is idempotent against a pre-existing install — pins the upgrade-path contract. |

The new `sql.test.ts` runs under the regular vitest config (no container,
<100ms). The CLI test uses one container per file like the rest. CI
already runs lint + build + test on every push.

---

## Documentation

- **`README.md`** — new top-level "Install" section showing both the JS function path and the CLI path side by side; documents the `{ schema, pgbossSchema }` option; the Prisma coexistence note; the git-URL / local-pack install paths for pre-publish consumers.
- **`COMPATIBILITY.md`** — the existing "Unsupported topologies (Goal 7)" section's channel-name paragraph updates to acknowledge `${schema}_job` for non-default schemas.
- **`CHANGELOG.md`** — entry under `[Unreleased]` covering: `{ schema, pgbossSchema }` options on `install` / `uninstall` / `bossier()`; the new CLI; channel name follows schema; the cross-version upgrade policy.
- **`CLAUDE.md`** — project-status paragraph adds the Goal 9 done line; the goal-status table row for Goal 9 flips to ✅.
- **`CONTRIBUTING.md`** (new) — the first-publish runbook from above + the release process generally.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| A consumer passes an unsafe schema name and the regex misses it | Low — `^[a-z_][a-z0-9_]*$` matches Postgres unquoted-identifier rules exactly | Unit test pins valid/invalid cases; `assertSchemaName` runs at the public API boundary before any SQL builds |
| Schema mismatch between `install` and `bossier()` | Medium — easy mistake if a consumer writes both calls separately and only updates one | README example uses a single `const schemas = { schema: 'x' }` const passed to both; CI doesn't enforce but the docs guide consumers toward the single-source-of-truth pattern |
| Pre-existing 0.0.0 dev environments accidentally push the wrong version | Low — only the release-runbook commit bumps the version | Runbook explicit; CI doesn't auto-bump; `npm publish` requires the dev to actively run it after the version commit |
| First `npm publish` fails (registry config, ownership, scope) | Low if the user has published before | `npm publish --dry-run` in the runbook step 1 surfaces this before the real publish; the publish step is deferred until after descent-app validation, so there's no rush |
| Channel-name change breaks existing Goal 7 consumers | None — default value (`pgbossier_job`) is unchanged; only changes if the consumer opts into a non-default `schema` | Default-path tests stay green; the change is purely additive |
| Bin script doesn't get executable permission on consumer install | Low — npm sets +x on `bin` entries automatically | `npm pack` test in CI confirms the bin script ships with the right bits |
| Consumer with `multiSchema` enabled in Prisma adds `pgbossier` to their schema and Prisma starts trying to manage our tables | Medium-low — documented as "don't do this" but discoverable | README warns explicitly; if a consumer does it anyway, `install()` is idempotent enough that the conflict surfaces as a clear Postgres error rather than silent corruption |
| Consumer installs pg-bossier from a git URL but the `prepare` build fails on their Node version | Low — we require Node ≥ 18, which everyone using pg-boss already has | `engines` declared; `prepare` runs `tsc`; fast fail with a real error if Node is too old |
| Destructive schema change needed later and we've painted ourselves into a corner with "add only, never remove" | Low — pg-bossier is small + focused; the audit table's columns are unlikely to be removed | Policy is documented; non-additive changes are an explicit version-bump path with manual migration SQL in the CHANGELOG. The cliff is real but distant |

---

## Open question for the implementation plan

- Should the bin script `import { install } from 'pg-bossier'` (using the package's own public API after `npm install`) or `import { install } from '../dist/install.js'` (using the relative path)? The first is more honest about the public-surface contract; the second works during development before `dist/` is at a stable path. Decide in the implementation plan; doesn't affect the spec.

---

## Related

- [Storage substrate design (2026-05-20)](./2026-05-20-storage-architecture-design.md)
- [Goal 7 lifecycle events design (2026-05-22, v2)](./2026-05-22-goal-7-lifecycle-events-design.md) — the precedent for schema-scoped NOTIFY channel design and the seq-column upgrade pattern.
- [Goal 6 progress design (2026-05-21)](./2026-05-21-goal-6-progress-api-design.md) — pattern for client-method wrappers that close over per-construction state.
- [Issue #10 — Goal 9: Install/uninstall surface](https://github.com/elfensky/pg-bossier/issues/10)
- [Issue #16 — Test infrastructure: adapt pg-boss's testing approach](https://github.com/elfensky/pg-bossier/issues/16) — schema-per-test isolation that this design unblocks.
- [pg-boss `schema` option](https://github.com/timgit/pg-boss/blob/master/docs/configuration.md) — precedent for configurable schema on a similar library.
- [Node `util.parseArgs` docs](https://nodejs.org/api/util.html#utilparseargsconfig) — stdlib CLI flag parsing used by `bin/pgbossier.js`.

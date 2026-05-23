Reading additional input from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/andrei/Developer/github/pg-bossier
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/andrei/.codex/memories]
reasoning effort: none
reasoning summaries: none
session id: 019e545c-d588-7763-a7e5-5f703d61d2fe
--------
user
# Adversarial review — Round 1

You are participating in a 4-way adversarial review of a software design spec
for pg-bossier — a JS/TS library that layers on top of pg-boss (a Postgres job
queue) to provide an operational data plane.

**Your role: ADVERSARIAL CHALLENGER.** Find real problems. Be technically
concrete. Cite specific sections or quotes from the spec. Surface real risks,
not hypothetical ones.

## Read the spec first

The spec under review is at:

`/Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md`

Read the whole file before you write a single critique line.

## Project charter constraints (issue #1, load-bearing — NON-NEGOTIABLE)

- **Audit writes are fail-open** — pg-bossier failures NEVER block pg-boss operations.
- **Per-event overhead has a published budget** (#12 closed; budgets in `PERFORMANCE.md`).
- **API-shape principle: composition, not replacement.** Read methods are new pg-bossier methods, not overloads of pg-boss methods. Write extensions are explicit per-feature decisions.
- **pg-boss compatibility tiers** — *Stable* (public JS API), *Transitional* (`pgboss.job` table reads), *Forbidden* (pg-boss internals — NEVER depend on).
- **Symmetric uninstall** — `DROP SCHEMA pgbossier CASCADE` must leave zero remnants pg-bossier owns.
- **KISS** — simple solutions only; no abstractions for hypothetical future needs; three similar lines beats a premature abstraction.
- **Non-goals**: no UI, no REST, no fork of pg-boss, no scheduling, no workflow engine, no queue runtime mutation, no observability platform, no automatic handler introspection, no ORM dependency, no bounded retention tooling.
- **Primary consumer**: descent-app (Prisma-using, runs pg-boss in production, has ~45 raw `pgboss.*` queries today). The user has stated explicitly: *"we won't be publishing until it's thoroughly tested in descent-app anyway."*

## Currently shipped (pre-Goal 9)

- Programmatic `install(pool)` / `uninstall(pool)` — idempotent SQL, schema/sequence/table/indexes/trigger function/trigger/backfill. Schema names `pgbossier` and `pgboss` are hardcoded.
- 87 integration tests across 10 files, green on develop.
- `pgbossier.record` schema absorbed one upgrade (Goal 7 added `seq BIGINT` via `ADD COLUMN IF NOT EXISTS`).
- Goal 7's NOTIFY channel currently hardcoded as `'pgbossier_job'`.
- `package.json` at version 0.0.0, no `bin` entry, builds via `tsc` to `dist/`.

## Attack vectors — address each in order

1. **SQL parameterization + schema-name validation.** The regex `^[a-z_][a-z0-9_]*$` is presented as Postgres-unquoted-ident-rules-equivalent and as the SQL-injection guardrail. Is this regex actually sufficient? What about Postgres reserved words ('user', 'public', 'pg_catalog', etc.) — would a consumer who passes `schema: 'user'` succeed at install? What about names that conflict with Postgres system catalogs? What about case sensitivity (the regex is lowercase-only — does that match Postgres reality)? What about identifier length limits (NAMEDATALEN = 63 by default)? Is `pg_` prefix reserved (yes — Postgres reserves it)? Does the spec's validation miss any of these?

2. **NOTIFY channel correctness fix (`${schema}_job`).** Two pg-bossier installs in different schemas in the same DB are supposed to be isolated by this change. But: is the channel-name change the ONLY cross-pollination vector? What about (a) the trigger on `pgboss.job` — if both installs trigger on the same pgboss schema, both audit-row writes fire for every pg-boss op, regardless of channel; (b) the `BACKFILL_SQL` — what happens if install A backfills then install B installs later, do they share rows; (c) two installs in DIFFERENT pgboss schemas on the same DB — is that the intended use case, or is the design only correct when pgbossSchema is also distinct?

3. **Cross-version upgrade policy — destructive-change cliff.** "Add only, never remove via `install()`" is stated as policy with a major version bump required for non-additive changes. Is this realistic for the future Goals 2/3/4 still pending? Goal 2 (terminal-state detail) might want to enforce a `class` constraint on `terminal_detail` — is that additive or destructive? Goal 3 (retry history) might add a `parent_attempt` column — additive. But what if Goal 2 wants to ALTER an existing column's type or constraints? The policy says "manual SQL in CHANGELOG" but doesn't say HOW to run that manual SQL — does the consumer copy-paste from CHANGELOG into `psql`? Is there a documented harness?

4. **CLI design — `util.parseArgs` adequacy.** stdlib `util.parseArgs` is stable since Node 18.3. Does it handle: (a) `--conn-string=postgres://user:pass@host:5432/db` (a URL with `:`, `@`, `?`, `=` characters in the value — does the parser get confused?), (b) Windows `npx pg-bossier install` — does the bin shim work, does shell quoting differ, do exit codes propagate?, (c) `npm run` with `--` separator forwarding — does it actually forward the args correctly? Also: the env var precedence `PGBOSSIER_CONN_STRING > DATABASE_URL` — is `DATABASE_URL` a good default given Heroku/Railway/Vercel set it and many consumers will have it set to a DIFFERENT database than the one they want pg-bossier installed in?

5. **Pre-publish consumption (git URL / npm pack).** Spec claims `npm install git+https://...#develop` works because of `prepare: "npm run build"`. Verify: (a) does npm 10+ actually run prepare on git installs by default? (npm 7 changed this; some envs disabled it), (b) does the consumer's lockfile capture the git commit, or just the URL? (lockfile semantics matter for reproducibility), (c) does `npm pack` produce a tarball that's installable AND that includes the bin script with executable bits preserved?, (d) does `prepare` ALSO run when a consumer installs from a registry tarball (it shouldn't — that's the difference between `prepare` and `prepack`/`postinstall`)?

6. **Publish runbook — develop → main tree snapshot.** Spec uses `git read-tree -u --reset develop` to put develop's tree onto main. Is this the right command? It updates the index AND working tree to match develop, but does it correctly handle deletions (files on main not on develop), unrelated histories (develop and main share no common ancestor), and `.gitignore` differences? Will the resulting commit on main have all the right ancestry semantics, or will `git log` be misleading? Also: the runbook says "tag v0.1.0 + push" — is there a risk that pushing the tag triggers any GitHub Action we don't want to trigger?

7. **Schema mismatch failure mode.** Consumer passes `pgbossSchema: 'wrong'` to `install()`. Spec says "trigger creation fails with 'relation wrong.job does not exist'". But: does the install order matter — does the FIRST SQL statement that references the wrong schema fail, or does the schema get partially created (the `pgbossier` schema exists, the trigger doesn't) leaving a half-broken state? Does `uninstall()` then clean it up cleanly, or does it leave orphaned objects? Is there a transaction wrapper that would help?

8. **`uninstall()` cascade — true symmetric removal.** Spec asserts `DROP SCHEMA pgbossier CASCADE` removes everything pg-bossier owns. Verify by enumeration: (a) the schema, (b) the table, (c) the sequence, (d) the indexes (cascaded from the table), (e) the trigger function, (f) the trigger ON `pgboss.job` (cascaded from the function), (g) the NOTIFY channel (which isn't a schema-owned object — does `DROP SCHEMA CASCADE` reach it? If two pg-bossier installs share a channel name because they didn't update the channel-scoping change, does dropping one break the other?). Are there any pg-bossier-owned objects the spec didn't enumerate?

9. **Prisma coexistence — the documentation contract.** Spec says "Prisma's `prisma migrate` only manages schemas declared in your `schema.prisma`." But: with `multiSchema` preview enabled (becoming default in Prisma 6+?), a consumer running `prisma db pull` will introspect the entire database — does that pull `pgbossier` schema into their Prisma file inadvertently? Is there a Prisma-side configuration that EXPLICITLY excludes a schema from introspection, and should we document it? Conversely, what's the impact of pg-bossier's `install()` on Prisma's `prisma migrate diff` — does it report drift?

10. **Tests — sufficient coverage?** The spec's test plan covers the new CLI, schema validation, non-default schemas, channel-name scoping. What about: (a) the existing 87 tests under the schema config change — does any of them silently break because they assume `pgbossier` literally?, (b) the `prepare` script on git install — is there a CI check that exercises this?, (c) the bin script's connection cleanup (`pool.end()` in `finally`) — under what conditions does the script hang at exit?, (d) the `--version` output — does it match `package.json` after a release bump?

11. **Issue #1 charter — does this design quietly violate anything?** Re-read the non-goals and constraints. Anything here that crosses a line? E.g., the CLI introduces a new public surface (the `bin` entry) — is "CLI tooling" implicitly out of scope per the "No HTTP/REST" / "No UI" mantra? The schema configurability adds an option that grows the public API — does it conflict with KISS?

12. **Anything missing from v1 entirely** that the spec doesn't even mention but probably needs.

## Deliverable

A critique addressing each numbered vector. Be concise but technically rigorous. Cite the spec.

End with exactly one of:
- **SHIP AS-IS** — if you find nothing material
- **SHIP WITH NAMED CHANGES** — list each change as `CHANGE: <description>` with a one-line rationale
- **BLOCK UNTIL <X>** — only if you believe a hard blocker exists

Identify yourself by name in your response header (e.g. `# Codex critique — Round 1`).
codex
Reviewing the spec first, then I’ll pressure-test each attack vector against the actual document and the current repo shape where the spec makes factual claims.
exec
/bin/zsh -lc 'wc -l docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc "sed -n '1,260p' docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
     596 docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md

 succeeded in 0ms:
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

codex
I’ve read the design through the API and SQL sections. Next I’m reading the rest of the spec and checking the repo claims that affect the critique, especially package/distribution and uninstall behavior.
exec
/bin/zsh -lc "sed -n '261,520p' docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '521,620p' docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
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

exec
/bin/zsh -lc "sed -n '1,220p' package.json" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
{
    "name": "pg-bossier",
    "version": "0.0.0",
    "description": "Operational data-plane on pg-boss: forensic preservation with lineage and failure classes, typed query API, mid-flight progress, and subscribable job events. Extends pg-boss, never replaces it.",
    "author": "Andrei Lavrenov <andrei@lav.ren>",
    "license": "MIT",
    "type": "module",
    "repository": {
        "type": "git",
        "url": "git+https://github.com/elfensky/pg-bossier.git"
    },
    "bugs": {
        "url": "https://github.com/elfensky/pg-bossier/issues"
    },
    "homepage": "https://github.com/elfensky/pg-bossier#readme",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "default": "./dist/index.js"
        }
    },
    "files": [
        "dist"
    ],
    "engines": {
        "node": ">=18"
    },
    "scripts": {
        "build": "tsc",
        "prepare": "npm run build",
        "lint": "eslint .",
        "lint:fix": "eslint . --fix",
        "test": "vitest run",
        "test:perf": "vitest run --config vitest.perf.config.ts"
    },
    "peerDependencies": {
        "pg-boss": "^12.18.2",
        "pg": "^8.0.0"
    },
    "devDependencies": {
        "@testcontainers/postgresql": "^12.0.0",
        "@types/pg": "^8.20.0",
        "eslint": "^10.4.0",
        "pg": "^8.21.0",
        "pg-boss": "^12.18.2",
        "typescript": "^6.0.3",
        "typescript-eslint": "^8.59.0",
        "vitest": "^4.1.7"
    }
}

exec
/bin/zsh -lc 'rg -n "DROP SCHEMA IF EXISTS|CREATE TRIGGER|NOTIFY|pgbossier_job|prepare|bin|version|files|exports|main|types" -S src test package.json PERFORMANCE.md CONTRIBUTING.md' in /Users/andrei/Developer/github/pg-bossier
 exited 2 in 0ms:
rg: CONTRIBUTING.md: No such file or directory (os error 2)
package.json:3:    "version": "0.0.0",
package.json:16:    "main": "./dist/index.js",
package.json:17:    "types": "./dist/index.d.ts",
package.json:18:    "exports": {
package.json:20:            "types": "./dist/index.d.ts",
package.json:24:    "files": [
package.json:32:        "prepare": "npm run build",
package.json:44:        "@types/pg": "^8.20.0",
package.json:48:        "typescript": "^6.0.3",
package.json:49:        "typescript-eslint": "^8.59.0",
test/harness.ts:14:  // supervise/schedule off: otherwise pg-boss's maintenance and cron loops insert
PERFORMANCE.md:77:- 10k / 100k / 1M-job scale extensions (likely separate `test/perf/chronicle-NNk.test.ts` files).
src/events.ts:101:    await this.client.query('LISTEN pgbossier_job');
src/events.ts:172:    if (msg.channel !== 'pgbossier_job' || msg.payload === undefined) return;
src/events.ts:226:      try { await this.client.query('UNLISTEN pgbossier_job'); } catch { /* connection may be dead */ }
test/perf/chronicle-scale.test.ts:107:  let remaining = jobIds.length;
test/perf/chronicle-scale.test.ts:108:  while (remaining > 0) {
test/perf/chronicle-scale.test.ts:114:    remaining -= batch.length;
src/client.ts:119:        return fn.bind(target);
test/events.test.ts:41:test('five event types fire for a job that fails-with-retry-then-succeeds', async () => {
test/events.test.ts:141:  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload1]);
test/events.test.ts:142:  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, [payload2]);
test/events.test.ts:181:  await h.pool.query(`SELECT pg_notify('pgbossier_job', $1)`, ['{not valid json']);
test/events.test.ts:201:    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
test/events.test.ts:227:    `SELECT pid FROM pg_stat_activity WHERE state = 'idle' AND query ILIKE '%LISTEN%pgbossier_job%'`,
test/client.test.ts:37:  // bossier client. If proxy method-binding were wrong, these would throw
test/client.test.ts:57:test('forwarded EventEmitter methods bind to the underlying instance', () => {
test/capture.test.ts:116:test('trigger publishes pg_notify on pgbossier_job with identity + seq', async () => {
test/capture.test.ts:124:  await listener.query('LISTEN pgbossier_job');
test/capture.test.ts:140:    expect(ev.channel).toBe('pgbossier_job');
src/sql.ts:64:      'pgbossier_job',
src/sql.ts:84:CREATE TRIGGER pgbossier_capture
src/install.ts:23:  await pool.query(`DROP SCHEMA IF EXISTS pgbossier CASCADE;`);

codex
The spec is making a few strong factual claims about Postgres and npm behavior. I’m checking the current SQL objects and package shape now so the critique stays anchored to real repo behavior, not generic advice.
exec
/bin/zsh -lc "sed -n '1,220p' src/sql.ts" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
export const SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS pgbossier;`;

export const SEQUENCE_SQL = `CREATE SEQUENCE IF NOT EXISTS pgbossier.record_seq;`;

export const RECORD_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pgbossier.record (
  job_id          uuid        NOT NULL,
  queue           text        NOT NULL,
  attempt         integer     NOT NULL,
  state           text        NOT NULL,
  data            jsonb,
  output          jsonb,
  progress        jsonb,
  terminal_detail jsonb,
  input_snapshot  jsonb,
  created_on      timestamptz,
  started_on      timestamptz,
  completed_on    timestamptz,
  captured_at     timestamptz NOT NULL DEFAULT now(),  -- first-capture time; never re-stamped
  PRIMARY KEY (job_id, attempt)
);`;

export const RECORD_INDEXES_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON pgbossier.record (queue, state);`,
  `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON pgbossier.record (captured_at);`,
  `CREATE INDEX IF NOT EXISTS record_data_gin            ON pgbossier.record USING gin (data);`,
  `CREATE INDEX IF NOT EXISTS record_output_gin          ON pgbossier.record USING gin (output);`,
  `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON pgbossier.record USING gin (terminal_detail);`,
  `CREATE INDEX IF NOT EXISTS record_active_idx ON pgbossier.record (queue, started_on) WHERE state = 'active';`,
];

export const RECORD_SEQ_COLUMN_SQL = `
ALTER TABLE pgbossier.record
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('pgbossier.record_seq');`;

export const RECORD_SEQ_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS record_seq_idx ON pgbossier.record (seq);`;

export const CAPTURE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_seq bigint;
BEGIN
  BEGIN
    new_seq := nextval('pgbossier.record_seq');

    INSERT INTO pgbossier.record
      (job_id, queue, attempt, state, data, output,
       created_on, started_on, completed_on, captured_at, seq)
    VALUES
      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
       NEW.created_on, NEW.started_on, NEW.completed_on, now(), new_seq)
    ON CONFLICT (job_id, attempt) DO UPDATE SET
      state        = EXCLUDED.state,
      data         = EXCLUDED.data,
      output       = EXCLUDED.output,
      created_on   = EXCLUDED.created_on,
      started_on   = EXCLUDED.started_on,
      completed_on = EXCLUDED.completed_on,
      seq          = new_seq;

    PERFORM pg_notify(
      'pgbossier_job',
      json_build_object(
        'job_id',      NEW.id,
        'queue',       NEW.name,
        'attempt',     NEW.retry_count,
        'state',       NEW.state,
        'seq',         new_seq,
        'captured_at', now()
      )::text
    );
  EXCEPTION WHEN OTHERS THEN
    -- fail-open per issue #1: log and continue.
    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;`;

export const CAPTURE_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;
CREATE TRIGGER pgbossier_capture
  AFTER INSERT OR UPDATE OF state ON pgboss.job
  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();`;

export const BACKFILL_SQL = `
INSERT INTO pgbossier.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM pgboss.job
ON CONFLICT (job_id, attempt) DO NOTHING;`;

exec
/bin/zsh -lc "sed -n '1,220p' src/install.ts" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
import type { Pool } from 'pg';
import {
  SCHEMA_SQL, SEQUENCE_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
  RECORD_SEQ_COLUMN_SQL, RECORD_SEQ_INDEX_SQL,
  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL, BACKFILL_SQL,
} from './sql.js';

export async function install(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);
  await pool.query(SEQUENCE_SQL);
  await pool.query(RECORD_TABLE_SQL);
  await pool.query(RECORD_SEQ_COLUMN_SQL);
  await pool.query(RECORD_SEQ_INDEX_SQL);
  for (const indexSql of RECORD_INDEXES_SQL) {
    await pool.query(indexSql);
  }
  await pool.query(CAPTURE_FUNCTION_SQL);
  await pool.query(CAPTURE_TRIGGER_SQL);
  await pool.query(BACKFILL_SQL);
}

export async function uninstall(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS pgbossier CASCADE;`);
}

exec
/bin/zsh -lc "sed -n '1,280p' src/events.ts" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import type { JobState } from './read.js';

export type JobEventName =
  | 'created' | 'started' | 'completed' | 'failed' | 'cancelled' | 'retried';

export interface JobEvent {
  /** Friendly event name. Pass-through string for unknown future pg-boss states. */
  event: JobEventName | (string & {});
  jobId: string;
  queue: string;
  attempt: number;
  /** Raw pg-boss state. */
  state: JobState | (string & {});
  /** Monotonic per-transition cursor. Pairs with getEventsSince(seq). */
  seq: bigint;
  capturedAt: Date;
}

export type ErrorReason = 'gap' | 'parse' | 'handler';

export interface BossierErrorEvent {
  reason: ErrorReason;
  error: unknown;
  at: Date;
}

export interface BossierWarningEvent {
  unknownState: string;
  jobId: string;
  at: Date;
}

interface BossierEventsMap {
  created:   [JobEvent];
  started:   [JobEvent];
  completed: [JobEvent];
  failed:    [JobEvent];
  cancelled: [JobEvent];
  retried:   [JobEvent];
  job:       [JobEvent];
  connected: [];
  warning:   [BossierWarningEvent];
  error:     [BossierErrorEvent];
}

export interface SubscribeOptions {
  signal?: AbortSignal;
}

export interface BossierEvents extends EventEmitter {
  on<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  once<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  off<K extends keyof BossierEventsMap>(
    name: K, listener: (...args: BossierEventsMap[K]) => void,
  ): this;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

const STATE_TO_EVENT: Record<string, JobEventName> = {
  created:   'created',
  active:    'started',
  retry:     'retried',
  completed: 'completed',
  failed:    'failed',
  cancelled: 'cancelled',
};

class BossierEventsImpl extends EventEmitter implements BossierEvents {
  private pool: Pool;
  private client: PoolClient | null = null;
  private closed = false;
  private seenUnknownStates = new Set<string>();
  private failureCount = 0;
  private reconnectCancellers: (() => void)[] = [];
  /** True only for the very first open() call — used to defer the 'connected' emit. */
  private isFirstOpen = true;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  // Stable references for listener removal on release.
  private readonly boundNotification = (msg: { channel: string; payload?: string }) => { this.handleNotification(msg); };
  private readonly boundError = (err: unknown) => { this.onClientLost(err); };
  private readonly boundEnd = () => { this.onClientLost(new Error('connection ended')); };

  async open(): Promise<void> {
    if (this.closed) return;
    this.client = await this.pool.connect();
    this.client.on('notification', this.boundNotification);
    this.client.on('error', this.boundError);
    this.client.on('end', this.boundEnd);
    await this.client.query('LISTEN pgbossier_job');
    this.failureCount = 0;
    if (this.isFirstOpen) {
      this.isFirstOpen = false;
      // Defer the initial 'connected' so callers can register listeners after subscribe() returns.
      setImmediate(() => { if (!this.closed) this.emit('connected'); });
    } else {
      this.emit('connected');
    }
  }

  private removeClientListeners(): void {
    if (!this.client) return;
    this.client.off('notification', this.boundNotification);
    this.client.off('error', this.boundError);
    this.client.off('end', this.boundEnd);
  }

  private onClientLost(err: unknown): void {
    if (this.closed || !this.client) return;
    this.removeClientListeners();
    try { this.client.release(err instanceof Error ? err : new Error(String(err))); } catch { /* */ }
    this.client = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delayMs = this.computeBackoffMs();
    const wait = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      this.reconnectCancellers.push(() => { clearTimeout(timer); resolve(); });
    });
    void wait.then(async () => {
      if (this.closed) return;
      try {
        await this.open();
        this.emitError('gap', new Error('event-stream gap during reconnect'));
      } catch {
        this.failureCount += 1;
        this.scheduleReconnect();
      }
    });
  }

  private computeBackoffMs(): number {
    const base = Math.min(1000 * Math.pow(2, this.failureCount), 30_000);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.round(base * jitter);
  }

  private emitError(reason: ErrorReason, error: unknown): void {
    const event: BossierErrorEvent = { reason, error, at: new Date() };
    this.emit('error', event);
  }

  private safeEmit<K extends keyof BossierEventsMap>(
    name: K, ...args: BossierEventsMap[K]
  ): void {
    const listeners = this.listeners(name).slice();
    for (const listener of listeners) {
      try {
        (listener as (...a: BossierEventsMap[K]) => void)(...args);
      } catch (err) {
        this.emitError('handler', err);
      }
    }
  }

  private handleNotification(msg: { channel: string; payload?: string }): void {
    if (this.closed) return;
    if (msg.channel !== 'pgbossier_job' || msg.payload === undefined) return;

    let parsed: { job_id?: string; queue?: string; attempt?: number;
                  state?: string; seq?: number | string; captured_at?: string };
    try {
      parsed = JSON.parse(msg.payload) as typeof parsed;
    } catch (err) {
      this.emitError('parse', err);
      return;
    }

    const { job_id, queue, attempt, state, seq, captured_at } = parsed;
    if (typeof job_id !== 'string' || typeof queue !== 'string' ||
        typeof attempt !== 'number' || typeof state !== 'string' ||
        (typeof seq !== 'number' && typeof seq !== 'string') ||
        typeof captured_at !== 'string') {
      this.emitError('parse', new Error(`pgbossier: malformed notification payload: ${msg.payload}`));
      return;
    }

    const eventName = STATE_TO_EVENT[state];
    const jobEvent: JobEvent = {
      event: eventName ?? state,
      jobId: job_id,
      queue,
      attempt,
      state,
      seq: BigInt(seq),
      capturedAt: new Date(captured_at),
    };

    if (eventName) {
      this.safeEmit(eventName, jobEvent);   // per-type first
    } else {
      if (!this.seenUnknownStates.has(state)) {
        this.seenUnknownStates.add(state);
        const warning: BossierWarningEvent = {
          unknownState: state, jobId: job_id, at: new Date(),
        };
        this.emit('warning', warning);
      }
    }
    this.safeEmit('job', jobEvent);          // then catch-all
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.reconnectCancellers.slice()) {
      try { cancel(); } catch { /* */ }
    }
    this.reconnectCancellers = [];
    if (this.client) {
      this.removeClientListeners();
      try { await this.client.query('UNLISTEN pgbossier_job'); } catch { /* connection may be dead */ }
      this.client.release();
      this.client = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
}

export async function subscribe(
  pool: Pool,
  opts: SubscribeOptions = {},
): Promise<BossierEvents> {
  if (opts.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const events = new BossierEventsImpl(pool);
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { void events.close(); }, { once: true });
  }
  await events.open();
  return events;
}

exec
/bin/zsh -lc 'git merge-base main develop || true' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
exec
/bin/zsh -lc 'git branch --list && git rev-list --max-parents=0 main develop' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
* develop
  main
4ec1a0cedfe429fa48da90912b5eb6630635ef51
39dcaa6dcf6d5a15b1211d6c7a4775bfbda12a11

codex
I have enough context to pin this to concrete spec statements. I’m pulling line references for the exact claims I’m going to challenge so the review is citation-backed instead of hand-wavy.
exec
/bin/zsh -lc "nl -ba docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md | sed -n '1,260p'" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
     1	# Goal 9 — Install / distribution shape: design
     2	
     3	**Date:** 2026-05-23
     4	**Sub-issue:** [#10](https://github.com/elfensky/pg-bossier/issues/10)
     5	**Parent:** [#1](https://github.com/elfensky/pg-bossier/issues/1) (charter)
     6	**Status:** Design — pre-implementation. Builds on the storage substrate (PR #15), Goal 7's `seq`-column upgrade precedent, and the existing programmatic `install(pool)` / `uninstall(pool)`.
     7	
     8	---
     9	
    10	## Summary
    11	
    12	Goal 9 polishes pg-bossier into something a real consumer can adopt without
    13	hand-holding. The programmatic `install(pool)` / `uninstall(pool)` already
    14	work and are idempotent; this goal adds three things alongside: a **thin CLI
    15	wrapper** (`npx pg-bossier install`, `uninstall`) for ops/CI contexts, **schema
    16	configurability** (the `pgbossier` and `pgboss` schema names become options
    17	rather than hardcoded literals — unblocks multi-instance support and
    18	issue #16's schema-per-test isolation), and a **prepared-but-not-executed
    19	publish workflow** (the `develop → main` mechanics + `npm publish --dry-run`
    20	checks live in `CONTRIBUTING.md`; the actual first `npm publish` waits until
    21	descent-app has validated pg-bossier against a real workload).
    22	
    23	The success criterion for v1 of Goal 9 is **descent-app can install
    24	pg-bossier from a git URL or `npm pack` tarball and have everything work
    25	end-to-end** — install, uninstall, the CLI, the existing operational API
    26	(reads, progress, events). The npm-registry publish is not part of v1's
    27	ship criteria; it's documented as the next step once descent-app's
    28	validation is green.
    29	
    30	---
    31	
    32	## Context — what is already built
    33	
    34	- **`install(pool)` and `uninstall(pool)`** in `src/install.ts` — fully idempotent SQL via `IF NOT EXISTS`, `CREATE OR REPLACE`, and `ON CONFLICT`. Symmetric: `DROP SCHEMA pgbossier CASCADE` removes everything pg-bossier owns and leaves `pgboss.job` untouched. Covered by `test/install.test.ts` and `test/uninstall.test.ts`.
    35	- **SQL constants in `src/sql.ts`** — schema/sequence/table/indexes/trigger function/trigger/backfill, all currently hardcoded with the `pgbossier` and `pgboss` schema names.
    36	- **Upgrade precedent.** Goal 7 added the `seq` column to the existing `pgbossier.record` table via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` plus a regression test that pins the upgrade path against a pre-existing v1 table. The "forward-only / additive" upgrade policy this design ratifies is the same one already used by Goal 7.
    37	- **Package shape.** `package.json` declares `"type": "module"`, `"main"`, `"types"`, `"exports"`, `"files": ["dist"]`, `"prepare": "npm run build"`, `"engines": { "node": ">=18" }`, `pg` + `pg-boss` as peer deps. Builds via `tsc` to `dist/`.
    38	- **Publishing state.** Version `0.0.0` on `develop`. No git tags. Not on npm. CHANGELOG holds everything under `[Unreleased]`.
    39	- **Existing tests.** `vitest` + `@testcontainers/postgresql` against real Postgres + pg-boss 12.18.2. The current test count after Goal 7 is 87 across 10 files.
    40	
    41	---
    42	
    43	## Goals and non-goals
    44	
    45	### What this design ships (v1 of Goal 9)
    46	
    47	1. **Schema configurability.** `{ schema?: string, pgbossSchema?: string }` option on `install` / `uninstall` / `bossier()` and on every internal free-function call (`findById`, `subscribe`, etc.). Defaults are the current hardcoded names.
    48	2. **A thin CLI.** `npx pg-bossier install [--conn-string=…] [--schema=…] [--pgboss-schema=…]` and `uninstall`. ~70 lines of Node using stdlib `util.parseArgs`. No new runtime dependency.
    49	3. **NOTIFY channel scoped to schema.** `${schema}_job` instead of literal `pgbossier_job`. Default remains `pgbossier_job` (no break for existing Goal 7 consumers).
    50	4. **Cross-version upgrade policy** ratified: forward-only, additive, idempotent. Non-additive changes require a version bump (minor on 0.x, major on ≥1.x) with a documented manual upgrade path.
    51	5. **First-publish runbook** in `CONTRIBUTING.md` — `develop → main` mechanics, `npm publish --dry-run` checks, version-policy reference. **Not executed in v1.**
    52	6. **Consumable from git URL / `npm pack`** — already works via the existing `prepare` script (`tsc` runs on install from git or tarball); we just verify it explicitly in CI.
    53	7. **Schema-name validation** at the public API boundary — regex `^[a-z_][a-z0-9_]*$` (Postgres unquoted-identifier rules); invalid names rejected with a clear `Error` before any SQL builds.
    54	
    55	### What this design deliberately does NOT ship
    56	
    57	- **Actually publishing to npm.** Deferred until descent-app validates pg-bossier against a real workload (consumer-driven gate). Goal 9 documents the publish flow; the user runs it when ready.
    58	- **A separate Prisma adapter package.** pg-bossier doesn't depend on Prisma; coexistence is documentation only.
    59	- **Monorepo / multi-package shape.** Single npm package, same as today.
    60	- **Numbered migration files (`migrations/00001_…sql`).** The `install()` function IS the migration; its idempotent shape produces the same end state regardless of which prior version was installed. Numbered migrations become a separate goal only when a concrete non-additive change forces the question.
    61	- **Automatic version detection or "schema is older than client" guard.** No runtime check. The CHANGELOG documents non-additive changes; consumers manage upgrade order.
    62	- **GitHub Actions auto-publish on tag push.** Manual `npm publish` is the v1 story.
    63	- **Down-migrations / rollback support.** "Downgrade" is `uninstall(pool)` + reinstall the older version. Acceptable because pg-bossier is fail-open and audit-only.
    64	- **Multi-pg-bossier-instance-per-schema.** Not a thing; one install per schema name, by design.
    65	
    66	---
    67	
    68	## Locked decisions
    69	
    70	### Decision 1 — Install path: JS function + thin CLI wrapper
    71	
    72	The programmatic `install(pool)` / `uninstall(pool)` stays the default. A new
    73	`bin/pgbossier.js` script wraps the same SQL constants with a small CLI
    74	surface for ops / CI contexts. No raw SQL file, no Prisma-migration form.
    75	
    76	Rationale: the JS path works for any Node consumer and integrates into
    77	existing boot scripts. The CLI helps the ~1-hour-adoption promise for
    78	contexts where the consumer doesn't want to wire up a one-off Node script
    79	(e.g., a Postgres bootstrap step in CI/CD). Raw SQL files would duplicate
    80	the idempotency expressions already in `src/sql.ts` — divergence risk for
    81	zero new capability.
    82	
    83	### Decision 2 — Schema names: configurable in v1
    84	
    85	`pgbossier` (our own objects) and `pgboss` (the source schema we trigger on)
    86	become options. Defaults match today's hardcoded names. Every SQL string in
    87	`src/sql.ts` becomes a factory function that takes a `SchemaNames` object
    88	and returns the SQL with the schema names interpolated.
    89	
    90	Rationale: unblocks multi-instance pg-bossier (two installs in different
    91	schemas on the same database), unblocks issue #16's schema-per-test
    92	isolation, and matches the existing precedent of `pg-boss` itself supporting
    93	`new PgBoss({ schema: 'custom' })`. The cost (~7 source files touched + a
    94	schema-name validation layer + extended tests) is bounded and one-time.
    95	
    96	### Decision 3 — First publish: prepare workflow, defer execution
    97	
    98	Goal 9 ships the publish runbook in `CONTRIBUTING.md`, makes
    99	`npm publish --dry-run` clean, and ensures the package is installable from
   100	a git URL or local pack. The first actual `npm publish` happens **after**
   101	descent-app has validated pg-bossier against a real production workload —
   102	that validation, not the existence of the runbook, is the real ship gate.
   103	
   104	Rationale: irreversibility. Once `0.1.0` is on npm, unpublishing leaves
   105	consumers with broken lockfiles. Validating against the primary consumer
   106	before publishing protects everyone.
   107	
   108	---
   109	
   110	## SQL parameterization mechanic — factory functions
   111	
   112	The chosen approach is **factory functions**, not placeholder templates or a
   113	query builder. SQL strings stay legible; the schema name is interpolated
   114	into a plain template literal; schema-name validation happens once at the
   115	public API boundary.
   116	
   117	```ts
   118	// src/sql.ts (after)
   119	
   120	export interface SchemaNames {
   121	  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
   122	  pgbossier: string;
   123	  /** Where pg-boss installed itself. Default: 'pgboss'. */
   124	  pgboss: string;
   125	}
   126	
   127	const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
   128	
   129	function assertSchemaName(name: string, key: keyof SchemaNames): void {
   130	  if (!IDENT_RE.test(name)) {
   131	    throw new Error(
   132	      `pgbossier: invalid ${key} schema name: ${JSON.stringify(name)}. ` +
   133	      `Must match ${IDENT_RE.source}.`,
   134	    );
   135	  }
   136	}
   137	
   138	export function resolveSchemas(opts?: Partial<SchemaNames>): SchemaNames {
   139	  const s: SchemaNames = {
   140	    pgbossier: opts?.pgbossier ?? 'pgbossier',
   141	    pgboss:    opts?.pgboss    ?? 'pgboss',
   142	  };
   143	  assertSchemaName(s.pgbossier, 'pgbossier');
   144	  assertSchemaName(s.pgboss, 'pgboss');
   145	  return s;
   146	}
   147	
   148	export function schemaSql(s: SchemaNames): string {
   149	  return `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier};`;
   150	}
   151	
   152	export function recordTableSql(s: SchemaNames): string {
   153	  return `CREATE TABLE IF NOT EXISTS ${s.pgbossier}.record (
   154	    job_id uuid NOT NULL, queue text NOT NULL, attempt integer NOT NULL,
   155	    state text NOT NULL, data jsonb, output jsonb, progress jsonb,
   156	    terminal_detail jsonb, input_snapshot jsonb,
   157	    created_on timestamptz, started_on timestamptz, completed_on timestamptz,
   158	    captured_at timestamptz NOT NULL DEFAULT now(),
   159	    PRIMARY KEY (job_id, attempt)
   160	  );`;
   161	}
   162	
   163	// Same factory shape for:
   164	//   sequenceSql, recordSeqColumnSql, recordSeqIndexSql,
   165	//   recordIndexesSql (returns string[]), backfillSql,
   166	//   captureFunctionSql, captureTriggerSql.
   167	```
   168	
   169	The `assertSchemaName` regex `^[a-z_][a-z0-9_]*$` matches Postgres
   170	unquoted-identifier rules. Anything else (quotes, dots, spaces, leading
   171	digits, uppercase) is rejected with a clear `Error` *before* any SQL string
   172	gets built — so no SQL injection vector ever reaches a query.
   173	
   174	Read-side modules (`src/read.ts`, `src/progress.ts`, `src/events.ts`) also
   175	get small refactors: the free functions accept a `SchemaNames` parameter,
   176	the client wrapper closes over the resolved schemas once and supplies them
   177	to each call. Consumer code calling `client.findById(jobId)` is unchanged.
   178	
   179	---
   180	
   181	## Install / uninstall API surface
   182	
   183	```ts
   184	// src/install.ts (after)
   185	
   186	export interface InstallOptions {
   187	  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
   188	  schema?: string;
   189	  /** Where pg-boss installed itself. Default: 'pgboss'. */
   190	  pgbossSchema?: string;
   191	}
   192	
   193	export async function install(
   194	  pool: Pool, options?: InstallOptions,
   195	): Promise<void> {
   196	  const s = resolveSchemas({
   197	    pgbossier: options?.schema,
   198	    pgboss:    options?.pgbossSchema,
   199	  });
   200	  await pool.query(schemaSql(s));
   201	  await pool.query(sequenceSql(s));
   202	  await pool.query(recordTableSql(s));
   203	  await pool.query(recordSeqColumnSql(s));
   204	  await pool.query(recordSeqIndexSql(s));
   205	  for (const idx of recordIndexesSql(s)) await pool.query(idx);
   206	  await pool.query(captureFunctionSql(s));
   207	  await pool.query(captureTriggerSql(s));
   208	  await pool.query(backfillSql(s));
   209	}
   210	
   211	export async function uninstall(
   212	  pool: Pool, options?: Pick<InstallOptions, 'schema'>,
   213	): Promise<void> {
   214	  const s = resolveSchemas({ pgbossier: options?.schema, pgboss: 'pgboss' });
   215	  await pool.query(`DROP SCHEMA IF EXISTS ${s.pgbossier} CASCADE;`);
   216	}
   217	```
   218	
   219	Notes:
   220	
   221	- `uninstall` only takes `schema` (the pg-bossier schema we own); it never
   222	  references `pgboss` because we don't drop someone else's schema.
   223	- The CASCADE drop removes the schema, the table, the sequence, the
   224	  function, and (cascading from the function) the trigger on
   225	  `${pgbossSchema}.job`. Confirmed by the existing `uninstall.test.ts`.
   226	- A consumer who passes `pgbossSchema: 'wrong'` to `install()` will get a
   227	  Postgres error on the `CREATE TRIGGER` statement ("relation
   228	  `wrong.job` does not exist"). Fail-loud, not silent.
   229	
   230	### `bossier()` carries the same options
   231	
   232	```ts
   233	// src/client.ts (changes only)
   234	export interface BossierOptions {
   235	  boss: PgBoss;
   236	  pool: Pool;
   237	  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
   238	  schema?: string;
   239	  /** Where pg-boss installed itself. Default: 'pgboss'. */
   240	  pgbossSchema?: string;
   241	}
   242	
   243	export function bossier(options: BossierOptions): Bossier {
   244	  const { boss, pool } = options;
   245	  const s = resolveSchemas({
   246	    pgbossier: options.schema,
   247	    pgboss:    options.pgbossSchema,
   248	  });
   249	  const methods: BossierMethods = {
   250	    recordPatch: (jobId, attempt, patch) =>
   251	      recordPatch(pool, s, jobId, attempt, patch),
   252	    findById:    <I, O>(jobId) => findById<I, O>(pool, s, jobId),
   253	    getEventsSince: <I, O>(since, opts) =>
   254	      getEventsSince<I, O>(pool, s, since, opts),
   255	    subscribe:   (opts) => subscribe(pool, s, opts),
   256	    setProgress: (jobId, progress) => setProgress(pool, s, jobId, progress),
   257	    // … and the other read methods, all closing over `s`.
   258	  };
   259	  // The proxy itself (pg-boss method forwarding) is unchanged.
   260	}

exec
/bin/zsh -lc "nl -ba docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md | sed -n '261,596p'" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
   261	```
   262	
   263	Consumer ergonomics don't change: `client.findById(jobId)` works exactly
   264	the same way it did before — schemas are resolved once at `bossier({...})`
   265	construction and closed over inside each method.
   266	
   267	Internal free functions (`findById(pool, schemas, jobId)`,
   268	`subscribe(pool, schemas, opts)`, etc.) accept an explicit `SchemaNames`
   269	argument. Tests use this form to exercise non-default schemas.
   270	
   271	---
   272	
   273	## CLI design
   274	
   275	`bin/pgbossier.js` — a Node shebang script using stdlib `util.parseArgs`.
   276	~70 lines total. No external CLI dependency.
   277	
   278	```bash
   279	# Commands
   280	pgbossier install   [--conn-string=<url>] [--schema=<n>] [--pgboss-schema=<n>]
   281	pgbossier uninstall [--conn-string=<url>] [--schema=<n>]
   282	pgbossier --help
   283	pgbossier --version
   284	
   285	# Connection string resolution (first match wins)
   286	#   1. --conn-string=<url>
   287	#   2. PGBOSSIER_CONN_STRING env var
   288	#   3. DATABASE_URL env var
   289	# Missing → exit 1, usage error.
   290	
   291	# Exit codes
   292	#   0  — success
   293	#   1  — usage error / --help shown
   294	#   2  — runtime error (DB connect failed, SQL error)
   295	#   64 — invalid schema name
   296	```
   297	
   298	Sketch:
   299	
   300	```js
   301	#!/usr/bin/env node
   302	import { parseArgs } from 'node:util';
   303	import { readFileSync } from 'node:fs';
   304	import { fileURLToPath } from 'node:url';
   305	import { dirname, resolve } from 'node:path';
   306	import { Pool } from 'pg';
   307	import { install, uninstall } from 'pg-bossier';
   308	
   309	const pkg = JSON.parse(
   310	  readFileSync(
   311	    resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'),
   312	    'utf8',
   313	  ),
   314	);
   315	
   316	const { values, positionals } = parseArgs({
   317	  options: {
   318	    'conn-string':   { type: 'string' },
   319	    'schema':        { type: 'string' },
   320	    'pgboss-schema': { type: 'string' },
   321	    'help':          { type: 'boolean', short: 'h' },
   322	    'version':       { type: 'boolean', short: 'v' },
   323	  },
   324	  allowPositionals: true,
   325	  strict: false,
   326	});
   327	
   328	if (values.version) { console.log(pkg.version); process.exit(0); }
   329	if (values.help || positionals.length === 0) { printUsage(); process.exit(1); }
   330	
   331	const cmd = positionals[0];
   332	const connString =
   333	  values['conn-string'] ??
   334	  process.env.PGBOSSIER_CONN_STRING ??
   335	  process.env.DATABASE_URL;
   336	if (!connString) {
   337	  console.error('pgbossier: no connection string. Pass --conn-string or set PGBOSSIER_CONN_STRING / DATABASE_URL.');
   338	  process.exit(1);
   339	}
   340	
   341	const pool = new Pool({ connectionString: connString });
   342	try {
   343	  if (cmd === 'install') {
   344	    await install(pool, {
   345	      schema:       values['schema'],
   346	      pgbossSchema: values['pgboss-schema'],
   347	    });
   348	    console.log('pgbossier: installed');
   349	  } else if (cmd === 'uninstall') {
   350	    await uninstall(pool, { schema: values['schema'] });
   351	    console.log('pgbossier: uninstalled');
   352	  } else {
   353	    printUsage(); process.exit(1);
   354	  }
   355	  process.exit(0);
   356	} catch (err) {
   357	  if (err instanceof Error && /invalid (pgbossier|pgboss) schema name/.test(err.message)) {
   358	    console.error(err.message);
   359	    process.exit(64);
   360	  }
   361	  console.error(`pgbossier: ${err instanceof Error ? err.message : String(err)}`);
   362	  process.exit(2);
   363	} finally {
   364	  await pool.end();
   365	}
   366	```
   367	
   368	`package.json` gains `"bin": { "pgbossier": "./bin/pgbossier.js" }` and the
   369	bin script is included via `"files": ["dist", "bin"]`. npm sets executable
   370	bits on bin scripts automatically.
   371	
   372	---
   373	
   374	## NOTIFY channel becomes schema-scoped
   375	
   376	This is a correctness fix, not just an ergonomic change. Without it, two
   377	pg-bossier installs on different schemas in the same database would
   378	cross-pollinate each other's notifications on the shared `pgbossier_job`
   379	channel.
   380	
   381	Changes:
   382	
   383	- **`captureFunctionSql`** — the `pg_notify` call interpolates `${s.pgbossier}_job` as the channel name (was hardcoded `'pgbossier_job'`).
   384	- **`src/events.ts`** — `LISTEN ${s.pgbossier}_job` instead of `LISTEN pgbossier_job`; the `msg.channel !== '${s.pgbossier}_job'` guard uses the same value; the channel constant becomes a per-subscriber property closed over from `subscribe(pool, schemas, opts)`.
   385	- **Default behavior unchanged.** `subscribe(pool)` against an `install(pool)` (both with defaults) still uses `pgbossier_job` — no break for existing Goal 7 consumers.
   386	- **`COMPATIBILITY.md`** — the channel-name paragraph in the "Unsupported topologies (Goal 7)" section updates to: "The default channel is `pgbossier_job`; with a non-default `schema` option, the channel is `${schema}_job`."
   387	
   388	---
   389	
   390	## Cross-version upgrade policy
   391	
   392	**Forward-only, additive, idempotent.**
   393	
   394	The single `install()` function IS the migration. Re-running it against an
   395	older `pgbossier` schema upgrades it in place via the same idempotent
   396	patterns we already use:
   397	
   398	- `CREATE … IF NOT EXISTS` for sequences, tables, indexes.
   399	- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for new columns.
   400	- `CREATE OR REPLACE FUNCTION` for trigger function bodies.
   401	
   402	We have **one precedent already**: Goal 7's `seq` column added cleanly to
   403	a pre-existing `pgbossier.record` table via this exact pattern. The
   404	existing test `'install adds seq column to a pre-existing v1 pgbossier.record (upgrade path)'`
   405	pins the policy for that case.
   406	
   407	**Non-additive changes** (renaming a column, changing a column type,
   408	dropping a column) require a version bump and a documented manual upgrade
   409	path:
   410	
   411	- Pre-1.0 (`0.x.y`): minor bump (`0.1 → 0.2`) with the CHANGELOG entry calling out the schema change and the manual upgrade SQL.
   412	- Post-1.0: major bump (`1.x → 2.0`) under the same documentation rule.
   413	
   414	**Down-migration** is `uninstall(pool)` + reinstall the older
   415	pg-bossier version. This loses audit data; acceptable because the audit
   416	table is consumer-owned and pg-bossier is fail-open by design.
   417	
   418	**The destructive-change cliff.** `install()` cannot do
   419	`ALTER TABLE DROP COLUMN IF EXISTS` because re-running it on an install
   420	that never had the column would still try to drop. The policy is **add
   421	only, never remove via `install()`**. Removals are manual,
   422	CHANGELOG-documented, and tied to a version bump.
   423	
   424	---
   425	
   426	## Distribution shape — single npm package
   427	
   428	Stay single. `pg-bossier` ships as one package with `pg` and `pg-boss` as
   429	peer deps. No monorepo, no separate Prisma adapter, no
   430	`@pgbossier/core` + `@pgbossier/prisma` split.
   431	
   432	**Why this holds for v1:**
   433	
   434	- pg-bossier doesn't depend on Prisma — it only needs a `pg.Pool`. Consumers using Prisma already have a Pool available; they pass it in.
   435	- A separate Prisma adapter would only matter if pg-bossier needed to *use* Prisma's transaction context, not just coexist with it. It doesn't.
   436	- The package.json already has the right shape; the only changes for Goal 9 are the `bin` entry and `bin/` in `files`.
   437	
   438	**package.json changes:**
   439	
   440	```jsonc
   441	{
   442	  // existing fields unchanged...
   443	  "files": ["dist", "bin"],
   444	  "bin": { "pgbossier": "./bin/pgbossier.js" },
   445	  "keywords": ["pg-boss", "postgres", "job-queue", "audit", "events", "lifecycle"]
   446	  // keywords already may be partial; ensure the full set is present
   447	}
   448	```
   449	
   450	---
   451	
   452	## Prisma coexistence — documentation, not code
   453	
   454	The story is "they don't interfere because they don't overlap":
   455	
   456	- Prisma's `prisma migrate` and `prisma db pull` only manage schemas declared in the consumer's `schema.prisma`. The `pgbossier` schema is not declared there, so Prisma doesn't see it.
   457	- Consumers using Prisma's `multiSchema` preview feature **should not** add `pgbossier` to their declared schemas. Doing so would bring pg-bossier into their Prisma migration history, which fights `install()`'s idempotent migration story.
   458	- `install(pool)` runs once per deployment — typically at app boot or in a one-shot script. It's idempotent; safe to run on every deploy.
   459	
   460	This goes in `README.md` under a "Prisma coexistence" subsection of the
   461	install docs. No code change is needed; coexistence is a documentation
   462	contract.
   463	
   464	---
   465	
   466	## First-publish runbook — prepared but unused in v1
   467	
   468	The actual first `npm publish` happens **after** descent-app validates
   469	pg-bossier against a real workload. The runbook below lives in a new
   470	`CONTRIBUTING.md` so it's executable when the gate opens.
   471	
   472	```
   473	# 1. On develop, verify everything green:
   474	npm run lint && npm run build && npm test
   475	npm publish --dry-run
   476	#    → surfaces metadata/files issues without publishing; the `prepare`
   477	#      script (tsc) runs, so this also confirms dist/ builds correctly.
   478	
   479	# 2. Decide the version. First release = 0.1.0 per CLAUDE.md's
   480	#    "while on 0.x.y the API is unstable" + semver convention.
   481	
   482	# 3. Switch to main, snapshot develop's tree onto it.
   483	#    NOTE: develop and main have unrelated histories by design — we use a
   484	#    tree snapshot, NOT git merge or git merge --squash, which would conflict.
   485	git checkout main
   486	git read-tree -u --reset develop
   487	# main's index + working tree now equal develop's tree exactly.
   488	
   489	# 4. In ONE commit on main, bump version and rename [Unreleased]:
   490	#    - package.json + package-lock.json:  0.0.0 → 0.1.0
   491	#    - CHANGELOG.md:
   492	#        rename "## [Unreleased]" → "## [0.1.0] - 2026-MM-DD"
   493	#        add fresh empty "## [Unreleased]" block above it for next cycle.
   494	git add -A
   495	git commit -m "Release 0.1.0"
   496	git tag v0.1.0
   497	git push origin main --follow-tags
   498	
   499	# 5. Back on develop, open a fresh [Unreleased] block for the next cycle:
   500	git checkout develop
   501	# (edit CHANGELOG.md to add the empty [Unreleased] header back at the top)
   502	git commit -am "chore(changelog): open fresh [Unreleased] for next cycle"
   503	git push origin develop
   504	
   505	# 6. From main, publish:
   506	git checkout main
   507	npm publish
   508	# You provide npm credentials. The prepare script runs tsc.
   509	```
   510	
   511	**Until step 6 runs**, consumers (including descent-app for validation)
   512	install pg-bossier via:
   513	
   514	```
   515	npm install git+https://github.com/elfensky/pg-bossier#develop
   516	# or, for a specific commit:
   517	npm install git+https://github.com/elfensky/pg-bossier#68fd7bb
   518	# or, for a local tarball:
   519	cd pg-bossier && npm pack
   520	cd ../descent-app && npm install ../pg-bossier/pg-bossier-0.0.0.tgz
   521	```
   522	
   523	All three install paths exercise the existing `prepare: "npm run build"`
   524	hook — npm runs `tsc` after install and the consumer gets a built
   525	`dist/`. This is already how the package works; Goal 9 verifies it in CI
   526	but doesn't add machinery for it.
   527	
   528	**Version policy reference** (excerpt from CLAUDE.md, restated here for
   529	the runbook):
   530	
   531	- v0.1.0 = first release. Everything currently in `[Unreleased]` (substrate, Goal 5, Goal 6, Goal 7, Goal 8, perf budget, Goal 9) bundles into the 0.1.0 changelog entry.
   532	- v0.x.y while the API surface is still maturing (Goals 2/3/4 still pending). Minor bumps for features, patch bumps for fixes. Non-additive schema changes are minor bumps under 0.x.
   533	- v1.0.0 only when the API surface is committed (likely after all 9 goals deliver and a stabilization window).
   534	
   535	---
   536	
   537	## Tests
   538	
   539	New + extended integration tests:
   540	
   541	| File | What it covers |
   542	|---|---|
   543	| `test/install.test.ts` (extend) | `install(pool, { schema: 'altbossier' })` creates the alt-schema sequence/table/trigger; `install(pool, { pgbossSchema: 'altpgboss' })` triggers off the right table (after the consumer manually `CREATE SCHEMA altpgboss; CREATE TABLE altpgboss.job (…)` for the test); two non-overlapping schemas installed in the same DB work independently. |
   544	| `test/uninstall.test.ts` (extend) | `uninstall(pool, { schema: 'altbossier' })` drops only the alt schema; the default `pgbossier` schema (if also installed) survives untouched. |
   545	| `test/sql.test.ts` (new, fast — no container) | Schema-name validation: every valid Postgres-ident-shape name accepted; names with quotes / dots / spaces / leading digits / uppercase rejected with the documented error message and matching exit code path. |
   546	| `test/cli.test.ts` (new, container) | `pgbossier --help` exit 1, prints usage; `pgbossier --version` exit 0 prints version from package.json; `pgbossier install` with no conn-string exit 1; invalid schema name → exit 64; success path against a testcontainer → exit 0. Spawns the bin script via `child_process.spawn`. |
   547	| `test/events.test.ts` (extend) | Channel name follows the schema option: `subscribe(pool, { schema: 'alt' })` listens on `alt_job`, not `pgbossier_job`. Existing default-schema tests stay green. |
   548	| `test/install.test.ts` (extend) | Re-running `install()` after a Goal 7-style additive change (e.g., we add a new index in a future version) is idempotent against a pre-existing install — pins the upgrade-path contract. |
   549	
   550	The new `sql.test.ts` runs under the regular vitest config (no container,
   551	<100ms). The CLI test uses one container per file like the rest. CI
   552	already runs lint + build + test on every push.
   553	
   554	---
   555	
   556	## Documentation
   557	
   558	- **`README.md`** — new top-level "Install" section showing both the JS function path and the CLI path side by side; documents the `{ schema, pgbossSchema }` option; the Prisma coexistence note; the git-URL / local-pack install paths for pre-publish consumers.
   559	- **`COMPATIBILITY.md`** — the existing "Unsupported topologies (Goal 7)" section's channel-name paragraph updates to acknowledge `${schema}_job` for non-default schemas.
   560	- **`CHANGELOG.md`** — entry under `[Unreleased]` covering: `{ schema, pgbossSchema }` options on `install` / `uninstall` / `bossier()`; the new CLI; channel name follows schema; the cross-version upgrade policy.
   561	- **`CLAUDE.md`** — project-status paragraph adds the Goal 9 done line; the goal-status table row for Goal 9 flips to ✅.
   562	- **`CONTRIBUTING.md`** (new) — the first-publish runbook from above + the release process generally.
   563	
   564	---
   565	
   566	## Risks and mitigations
   567	
   568	| Risk | Likelihood | Mitigation |
   569	|---|---|---|
   570	| A consumer passes an unsafe schema name and the regex misses it | Low — `^[a-z_][a-z0-9_]*$` matches Postgres unquoted-identifier rules exactly | Unit test pins valid/invalid cases; `assertSchemaName` runs at the public API boundary before any SQL builds |
   571	| Schema mismatch between `install` and `bossier()` | Medium — easy mistake if a consumer writes both calls separately and only updates one | README example uses a single `const schemas = { schema: 'x' }` const passed to both; CI doesn't enforce but the docs guide consumers toward the single-source-of-truth pattern |
   572	| Pre-existing 0.0.0 dev environments accidentally push the wrong version | Low — only the release-runbook commit bumps the version | Runbook explicit; CI doesn't auto-bump; `npm publish` requires the dev to actively run it after the version commit |
   573	| First `npm publish` fails (registry config, ownership, scope) | Low if the user has published before | `npm publish --dry-run` in the runbook step 1 surfaces this before the real publish; the publish step is deferred until after descent-app validation, so there's no rush |
   574	| Channel-name change breaks existing Goal 7 consumers | None — default value (`pgbossier_job`) is unchanged; only changes if the consumer opts into a non-default `schema` | Default-path tests stay green; the change is purely additive |
   575	| Bin script doesn't get executable permission on consumer install | Low — npm sets +x on `bin` entries automatically | `npm pack` test in CI confirms the bin script ships with the right bits |
   576	| Consumer with `multiSchema` enabled in Prisma adds `pgbossier` to their schema and Prisma starts trying to manage our tables | Medium-low — documented as "don't do this" but discoverable | README warns explicitly; if a consumer does it anyway, `install()` is idempotent enough that the conflict surfaces as a clear Postgres error rather than silent corruption |
   577	| Consumer installs pg-bossier from a git URL but the `prepare` build fails on their Node version | Low — we require Node ≥ 18, which everyone using pg-boss already has | `engines` declared; `prepare` runs `tsc`; fast fail with a real error if Node is too old |
   578	| Destructive schema change needed later and we've painted ourselves into a corner with "add only, never remove" | Low — pg-bossier is small + focused; the audit table's columns are unlikely to be removed | Policy is documented; non-additive changes are an explicit version-bump path with manual migration SQL in the CHANGELOG. The cliff is real but distant |
   579	
   580	---
   581	
   582	## Open question for the implementation plan
   583	
   584	- Should the bin script `import { install } from 'pg-bossier'` (using the package's own public API after `npm install`) or `import { install } from '../dist/install.js'` (using the relative path)? The first is more honest about the public-surface contract; the second works during development before `dist/` is at a stable path. Decide in the implementation plan; doesn't affect the spec.
   585	
   586	---
   587	
   588	## Related
   589	
   590	- [Storage substrate design (2026-05-20)](./2026-05-20-storage-architecture-design.md)
   591	- [Goal 7 lifecycle events design (2026-05-22, v2)](./2026-05-22-goal-7-lifecycle-events-design.md) — the precedent for schema-scoped NOTIFY channel design and the seq-column upgrade pattern.
   592	- [Goal 6 progress design (2026-05-21)](./2026-05-21-goal-6-progress-api-design.md) — pattern for client-method wrappers that close over per-construction state.
   593	- [Issue #10 — Goal 9: Install/uninstall surface](https://github.com/elfensky/pg-bossier/issues/10)
   594	- [Issue #16 — Test infrastructure: adapt pg-boss's testing approach](https://github.com/elfensky/pg-bossier/issues/16) — schema-per-test isolation that this design unblocks.
   595	- [pg-boss `schema` option](https://github.com/timgit/pg-boss/blob/master/docs/configuration.md) — precedent for configurable schema on a similar library.
   596	- [Node `util.parseArgs` docs](https://nodejs.org/api/util.html#utilparseargsconfig) — stdlib CLI flag parsing used by `bin/pgbossier.js`.

codex
One concrete bug in the CLI sketch is worth validating rather than assuming: the interaction between `process.exit(...)` and the `finally { await pool.end() }` cleanup path. I’m testing that directly.
exec
/bin/zsh -lc "node -e \"(async()=>{try{console.log('try');process.exit(0)}finally{console.log('finally');await new Promise(r=>setTimeout(r,10));console.log('after')}})()\"" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
try

exec
/bin/zsh -lc "node -e \"const {parseArgs}=require('node:util'); console.log(JSON.stringify(parseArgs({options:{'conn-string':{type:'string'}},allowPositionals:true,strict:false,args:['install','--conn-string=postgres://user:pass@host:5432/db?sslmode=require&x=y']}), null, 2))\"" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
{
  "values": {
    "conn-string": "postgres://user:pass@host:5432/db?sslmode=require&x=y"
  },
  "positionals": [
    "install"
  ]
}

exec
/bin/zsh -lc 'ls -1 package-lock.json CHANGELOG.md CLAUDE.md README.md COMPATIBILITY.md 2>/dev/null' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
CHANGELOG.md
CLAUDE.md
COMPATIBILITY.md
README.md
package-lock.json

codex
I’m also validating the package-lifecycle claim locally. The spec says git URL, tarball, and `npm pack` all exercise `prepare`; that’s easy to get wrong, so I’m checking actual npm behavior instead of relying on memory.
exec
/bin/zsh -lc 'npm --version' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc "rm -rf /private/tmp/pgbossier-lifecycle && mkdir -p /private/tmp/pgbossier-lifecycle/pkg /private/tmp/pgbossier-lifecycle/consumer && cd /private/tmp/pgbossier-lifecycle/pkg && cat > package.json <<'EOF'
{
  \"name\": \"lifecycle-probe\",
  \"version\": \"1.0.0\",
  \"type\": \"module\",
  \"files\": [\"dist\"],
  \"scripts\": {
    \"prepare\": \"mkdir -p dist && echo built > dist/built.txt\",
    \"prepack\": \"mkdir -p dist && echo prepack > dist/prepack.txt\"
  }
}
EOF
npm pack >/tmp/lifecycle-pack.log 2>&1 && ls -R . && cd ../consumer && npm init -y >/dev/null 2>&1 && npm install ../pkg/lifecycle-probe-1.0.0.tgz >/tmp/lifecycle-install.log 2>&1 && echo '---PKG---' && find ../pkg -maxdepth 3 -type f | sort && echo '---CONSUMER NODE_MODULES---' && find node_modules/lifecycle-probe -maxdepth 3 -type f | sort && echo '---BUILT CONTENT---' && cat node_modules/lifecycle-probe/dist/built.txt 2>/dev/null || true && echo '---PREPACK CONTENT---' && cat node_modules/lifecycle-probe/dist/prepack.txt 2>/dev/null || true" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 454ms:
11.7.0

 succeeded in 1675ms:
---PREPACK CONTENT---

codex
The first lifecycle probe was inconclusive because the shell pipeline compressed the output too aggressively. I’m reading the resulting temp package directly now.
exec
/bin/zsh -lc 'find /private/tmp/pgbossier-lifecycle/pkg -maxdepth 3 -type f | sort' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc 'find /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe -maxdepth 3 -type f | sort' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
find: /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe: No such file or directory

exec
/bin/zsh -lc 'for f in /private/tmp/pgbossier-lifecycle/pkg/dist/* /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe/dist/*; do echo "FILE:$f"; cat "$f"; done' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc "cat /tmp/lifecycle-pack.log; printf '\\n---\\n'; cat /tmp/lifecycle-install.log" in /Users/andrei/Developer/github/pg-bossier
 exited 1 in 0ms:

> lifecycle-probe@1.0.0 prepack
> mkdir -p dist && echo prepack > dist/prepack.txt


> lifecycle-probe@1.0.0 prepare
> mkdir -p dist && echo built > dist/built.txt

npm error Log files were not written due to an error writing to the directory: /Users/andrei/.npm/_logs
npm error You can rerun the command with `--loglevel=verbose` to see the logs in your terminal

---
cat: /tmp/lifecycle-install.log: No such file or directory

 succeeded in 152ms:
/private/tmp/pgbossier-lifecycle/pkg/dist/built.txt
/private/tmp/pgbossier-lifecycle/pkg/dist/prepack.txt
/private/tmp/pgbossier-lifecycle/pkg/package.json

 exited 1 in 108ms:
zsh:1: no matches found: /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe/dist/*

codex
The lifecycle result already shows one important point: `npm pack` runs `prepack` and `prepare` in the package being packed, not in the consuming app. I’m finishing the tarball-install check separately.
exec
/bin/zsh -lc 'mkdir -p /Users/andrei/.npm/_logs && cd /private/tmp/pgbossier-lifecycle/consumer && npm init -y >/dev/null 2>&1 && npm install ../pkg/lifecycle-probe-1.0.0.tgz --loglevel=notice' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc 'find /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe -maxdepth 3 -type f | sort' in /Users/andrei/Developer/github/pg-bossier
exec
/bin/zsh -lc 'for f in /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe/dist/*; do echo "FILE:$f"; cat "$f"; done' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 403ms:
find: /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe: No such file or directory

 exited 1 in 425ms:
zsh:1: no matches found: /private/tmp/pgbossier-lifecycle/consumer/node_modules/lifecycle-probe/dist/*

 exited 255 in 2058ms:
npm error code EPERM
npm error syscall mkdtemp
npm error path /Users/andrei/.npm/_cacache/tmp/A4fAoT
npm error errno -1
npm error
npm error Your cache folder contains root-owned files, due to a bug in
npm error previous versions of npm which has since been addressed.
npm error
npm error To permanently fix this problem, please run:
npm error   sudo chown -R 501:20 "/Users/andrei/.npm"
npm error Log files were not written due to an error writing to the directory: /Users/andrei/.npm/_logs
npm error You can rerun the command with `--loglevel=verbose` to see the logs in your terminal

exec
/bin/zsh -lc "rm -rf /private/tmp/npm-cache /private/tmp/pgbossier-lifecycle/consumer && mkdir -p /private/tmp/npm-cache /private/tmp/pgbossier-lifecycle/consumer && cd /private/tmp/pgbossier-lifecycle/consumer && npm init -y >/dev/null 2>&1 && npm_config_cache=/private/tmp/npm-cache npm install ../pkg/lifecycle-probe-1.0.0.tgz --loglevel=notice && find node_modules/lifecycle-probe -maxdepth 3 -type f | sort && printf '\\n---\\n' && for f in node_modules/lifecycle-probe/dist/*; do echo \"FILE:"'$f"; cat "$f"; done' in /Users/andrei/Developer/github/pg-bossier
 exited 254 in 324ms:
npm warn tarball tarball data for file:../pkg/lifecycle-probe-1.0.0.tgz (null) seems to be corrupted. Trying again.
npm warn tarball tarball data for file:../pkg/lifecycle-probe-1.0.0.tgz (null) seems to be corrupted. Trying again.
npm error code ENOENT
npm error syscall open
npm error path /private/tmp/pgbossier-lifecycle/pkg/lifecycle-probe-1.0.0.tgz
npm error errno -2
npm error enoent ENOENT: no such file or directory, open '/private/tmp/pgbossier-lifecycle/pkg/lifecycle-probe-1.0.0.tgz'
npm error enoent This is related to npm not being able to find a file.
npm error enoent
npm error A complete log of this run can be found in: /private/tmp/npm-cache/_logs/2026-05-23T10_25_08_824Z-debug-0.log

exec
/bin/zsh -lc 'find /private/tmp/pgbossier-lifecycle/pkg -maxdepth 1 -type f | sort' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
/private/tmp/pgbossier-lifecycle/pkg/package.json

exec
/bin/zsh -lc 'cd /private/tmp/pgbossier-lifecycle/pkg && npm_config_cache=/private/tmp/npm-cache npm pack --loglevel=notice && ls -1' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 987ms:

> lifecycle-probe@1.0.0 prepack
> mkdir -p dist && echo prepack > dist/prepack.txt


> lifecycle-probe@1.0.0 prepare
> mkdir -p dist && echo built > dist/built.txt

npm notice
npm notice 📦  lifecycle-probe@1.0.0
npm notice Tarball Contents
npm notice 6B dist/built.txt
npm notice 8B dist/prepack.txt
npm notice 244B package.json
npm notice Tarball Details
npm notice name: lifecycle-probe
npm notice version: 1.0.0
npm notice filename: lifecycle-probe-1.0.0.tgz
npm notice package size: 292 B
npm notice unpacked size: 258 B
npm notice shasum: 4645b4501e633ec902d2b238a6f58f85186a1871
npm notice integrity: sha512-WNXt/q23wu33T[...]2j6ZTP4TWKnsA==
npm notice total files: 3
npm notice
lifecycle-probe-1.0.0.tgz
dist
lifecycle-probe-1.0.0.tgz
package.json

exec
/bin/zsh -lc "rm -rf /private/tmp/pgbossier-lifecycle/consumer && mkdir -p /private/tmp/pgbossier-lifecycle/consumer && cd /private/tmp/pgbossier-lifecycle/consumer && npm init -y >/dev/null 2>&1 && npm_config_cache=/private/tmp/npm-cache npm install ../pkg/lifecycle-probe-1.0.0.tgz --loglevel=notice && find node_modules/lifecycle-probe -maxdepth 3 -type f | sort && printf '\\n---\\n' && for f in node_modules/lifecycle-probe/dist/*; do echo \"FILE:"'$f"; cat "$f"; done' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 366ms:

added 1 package in 143ms
node_modules/lifecycle-probe/dist/built.txt
node_modules/lifecycle-probe/dist/prepack.txt
node_modules/lifecycle-probe/package.json

---
FILE:node_modules/lifecycle-probe/dist/built.txt
built
FILE:node_modules/lifecycle-probe/dist/prepack.txt
prepack

codex
I’ve confirmed tarball behavior locally. One more distribution check remains: whether `prepare` runs for a git dependency install, since the spec depends on that path for pre-publish consumption.
exec
/bin/zsh -lc "rm -rf /private/tmp/git-prepare-probe && mkdir -p /private/tmp/git-prepare-probe/repo /private/tmp/git-prepare-probe/consumer && cd /private/tmp/git-prepare-probe/repo && git init -q && cat > package.json <<'EOF'
{
  \"name\": \"git-prepare-probe\",
  \"version\": \"1.0.0\",
  \"type\": \"module\",
  \"files\": [\"dist\"],
  \"scripts\": {
    \"prepare\": \"mkdir -p dist && echo built-from-prepare > dist/built.txt\"
  }
}
EOF
git add package.json && git -c user.name='a' -c user.email='a@a' commit -qm init && cd ../consumer && npm init -y >/dev/null 2>&1 && npm_config_cache=/private/tmp/npm-cache npm install git+file:///private/tmp/git-prepare-probe/repo --loglevel=notice && find node_modules/git-prepare-probe -maxdepth 3 -type f | sort && printf '\\n---\\n' && cat node_modules/git-prepare-probe/dist/built.txt" in /Users/andrei/Developer/github/pg-bossier
 exited 128 in 144ms:
error: 1Password: Could not connect to socket. Is the agent running?

fatal: failed to write commit object

exec
/bin/zsh -lc "rm -rf /private/tmp/git-prepare-probe && mkdir -p /private/tmp/git-prepare-probe/repo /private/tmp/git-prepare-probe/consumer && cd /private/tmp/git-prepare-probe/repo && git init -q && git config commit.gpgsign false && cat > package.json <<'EOF'
{
  \"name\": \"git-prepare-probe\",
  \"version\": \"1.0.0\",
  \"type\": \"module\",
  \"files\": [\"dist\"],
  \"scripts\": {
    \"prepare\": \"mkdir -p dist && echo built-from-prepare > dist/built.txt\"
  }
}
EOF
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false git add package.json && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false git -c user.name='a' -c user.email='a@a' commit -qm init && cd ../consumer && npm init -y >/dev/null 2>&1 && npm_config_cache=/private/tmp/npm-cache npm install git+file:///private/tmp/git-prepare-probe/repo --loglevel=notice && find node_modules/git-prepare-probe -maxdepth 3 -type f | sort && printf '\\n---\\n' && cat node_modules/git-prepare-probe/dist/built.txt" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 5090ms:

added 1 package in 4s
node_modules/git-prepare-probe/dist/built.txt
node_modules/git-prepare-probe/package.json

---
built-from-prepare

exec
/bin/zsh -lc 'cat /private/tmp/git-prepare-probe/consumer/package-lock.json' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
{
  "name": "consumer",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "consumer",
      "version": "1.0.0",
      "license": "ISC",
      "dependencies": {
        "git-prepare-probe": "git+file:///private/tmp/git-prepare-probe/repo"
      }
    },
    "node_modules/git-prepare-probe": {
      "version": "1.0.0",
      "resolved": "git+file:///private/tmp/git-prepare-probe/repo#ec878191951769f66866d6f5d120ee4f16e9bbff"
    }
  }
}

codex
The git install path checks out on current npm, and the lockfile records the commit SHA in `resolved`. I’m doing one last packaging probe around `bin` so I can separate real risk from non-risk there.
exec
/bin/zsh -lc "rm -rf /private/tmp/bin-probe && mkdir -p /private/tmp/bin-probe/pkg/bin /private/tmp/bin-probe/consumer && cd /private/tmp/bin-probe/pkg && cat > package.json <<'EOF'
{
  \"name\": \"bin-probe\",
  \"version\": \"1.0.0\",
  \"type\": \"module\",
  \"files\": [\"bin\"],
  \"bin\": { \"bin-probe\": \"./bin/probe.js\" }
}
EOF
cat > bin/probe.js <<'EOF'
#"'!/usr/bin/env node
console.log('"'ok')
EOF
chmod 644 bin/probe.js
npm_config_cache=/private/tmp/npm-cache npm pack --loglevel=notice >/tmp/bin-pack.log 2>&1 && cd ../consumer && npm init -y >/dev/null 2>&1 && npm_config_cache=/private/tmp/npm-cache npm install ../pkg/bin-probe-1.0.0.tgz --loglevel=notice >/tmp/bin-install.log 2>&1 && stat -f '%Sp %N' node_modules/bin-probe/bin/probe.js node_modules/.bin/bin-probe && printf '\\n---PACK---\\n' && cat /tmp/bin-pack.log && printf '\\n---INSTALL---\\n' && cat /tmp/bin-install.log" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 1940ms:
-rwxr-xr-x node_modules/bin-probe/bin/probe.js
lrwxr-xr-x node_modules/.bin/bin-probe

---PACK---
npm notice
npm notice 📦  bin-probe@1.0.0
npm notice Tarball Contents
npm notice 38B bin/probe.js
npm notice 132B package.json
npm notice Tarball Details
npm notice name: bin-probe
npm notice version: 1.0.0
npm notice filename: bin-probe-1.0.0.tgz
npm notice package size: 247 B
npm notice unpacked size: 170 B
npm notice shasum: 91e52e3b931a22c090e0f199ddf8a8688cb0387d
npm notice integrity: sha512-3QmNpoemYMPoD[...]4H104UFmbiYwg==
npm notice total files: 2
npm notice
bin-probe-1.0.0.tgz

---INSTALL---

added 1 package in 560ms

codex
The release runbook may be acceptable or it may be a footgun depending on the repo’s Actions triggers. I’m checking the local workflow files before I call that out.
exec
/bin/zsh -lc 'rg --files .github/workflows' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
.github/workflows/ci.yml

exec
/bin/zsh -lc 'rg -n "on:|tags:|push:" .github/workflows -S' in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
.github/workflows/ci.yml:8:on:
.github/workflows/ci.yml:9:  push:
.github/workflows/ci.yml:15:    runs-on: ubuntu-latest
.github/workflows/ci.yml:21:          node-version: '22'
.github/workflows/ci.yml:33:    runs-on: ubuntu-latest

exec
/bin/zsh -lc "sed -n '1,120p' .github/workflows/ci.yml" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
# Lint, build, and run the integration suite on every push to develop or main
# and every PR. The suite uses @testcontainers/postgresql; Docker is preinstalled
# on the ubuntu-latest runner, so no `services:` Postgres block is needed. A
# separate tripwire job warns when pg-boss publishes a minor above the
# peer-dep floor — see COMPATIBILITY.md "Version support" for the policy.
name: CI

on:
  push:
    branches: [develop, main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm test

  pg-boss-version-tripwire:
    # Warns (does not fail) when the latest published pg-boss minor is above
    # the peer-dep floor declared in package.json. The trigger to add a
    # floor+latest matrix (and the correctness assertions that earn it) is
    # this warning firing. See COMPATIBILITY.md "Version support".
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: actions/checkout@v4
      - name: Compare pg-boss floor vs latest published minor
        run: |
          set -euo pipefail
          FLOOR_RANGE=$(node -e "console.log(require('./package.json').peerDependencies['pg-boss'])")
          FLOOR_MM=$(printf '%s' "$FLOOR_RANGE" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1.\2/')
          LATEST=$(npm view pg-boss version)
          LATEST_MM=$(printf '%s' "$LATEST" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/')
          echo "Peer-dep range: $FLOOR_RANGE  (minor: $FLOOR_MM)"
          echo "Latest published: $LATEST     (minor: $LATEST_MM)"
          if [ "$FLOOR_MM" = "$LATEST_MM" ]; then
            echo "Floor and latest minor match — no tripwire."
          else
            echo "::warning::pg-boss latest minor ($LATEST_MM, version $LATEST) is above the peer-dep floor minor ($FLOOR_MM, range $FLOOR_RANGE). See COMPATIBILITY.md section 'Version support — no matrix today, self-firing tripwire'."
          fi

exec
/bin/zsh -lc "nl -ba src/sql.ts | sed -n '1,140p'
nl -ba src/install.ts | sed -n '1,80p'
nl -ba package.json | sed -n '1,120p'
nl -ba .github/workflows/ci.yml | sed -n '1,80p'" in /Users/andrei/Developer/github/pg-bossier
 succeeded in 0ms:
     1	export const SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS pgbossier;`;
     2	
     3	export const SEQUENCE_SQL = `CREATE SEQUENCE IF NOT EXISTS pgbossier.record_seq;`;
     4	
     5	export const RECORD_TABLE_SQL = `
     6	CREATE TABLE IF NOT EXISTS pgbossier.record (
     7	  job_id          uuid        NOT NULL,
     8	  queue           text        NOT NULL,
     9	  attempt         integer     NOT NULL,
    10	  state           text        NOT NULL,
    11	  data            jsonb,
    12	  output          jsonb,
    13	  progress        jsonb,
    14	  terminal_detail jsonb,
    15	  input_snapshot  jsonb,
    16	  created_on      timestamptz,
    17	  started_on      timestamptz,
    18	  completed_on    timestamptz,
    19	  captured_at     timestamptz NOT NULL DEFAULT now(),  -- first-capture time; never re-stamped
    20	  PRIMARY KEY (job_id, attempt)
    21	);`;
    22	
    23	export const RECORD_INDEXES_SQL: readonly string[] = [
    24	  `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON pgbossier.record (queue, state);`,
    25	  `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON pgbossier.record (captured_at);`,
    26	  `CREATE INDEX IF NOT EXISTS record_data_gin            ON pgbossier.record USING gin (data);`,
    27	  `CREATE INDEX IF NOT EXISTS record_output_gin          ON pgbossier.record USING gin (output);`,
    28	  `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON pgbossier.record USING gin (terminal_detail);`,
    29	  `CREATE INDEX IF NOT EXISTS record_active_idx ON pgbossier.record (queue, started_on) WHERE state = 'active';`,
    30	];
    31	
    32	export const RECORD_SEQ_COLUMN_SQL = `
    33	ALTER TABLE pgbossier.record
    34	  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('pgbossier.record_seq');`;
    35	
    36	export const RECORD_SEQ_INDEX_SQL =
    37	  `CREATE INDEX IF NOT EXISTS record_seq_idx ON pgbossier.record (seq);`;
    38	
    39	export const CAPTURE_FUNCTION_SQL = `
    40	CREATE OR REPLACE FUNCTION pgbossier.capture() RETURNS trigger
    41	LANGUAGE plpgsql AS $$
    42	DECLARE
    43	  new_seq bigint;
    44	BEGIN
    45	  BEGIN
    46	    new_seq := nextval('pgbossier.record_seq');
    47	
    48	    INSERT INTO pgbossier.record
    49	      (job_id, queue, attempt, state, data, output,
    50	       created_on, started_on, completed_on, captured_at, seq)
    51	    VALUES
    52	      (NEW.id, NEW.name, NEW.retry_count, NEW.state, NEW.data, NEW.output,
    53	       NEW.created_on, NEW.started_on, NEW.completed_on, now(), new_seq)
    54	    ON CONFLICT (job_id, attempt) DO UPDATE SET
    55	      state        = EXCLUDED.state,
    56	      data         = EXCLUDED.data,
    57	      output       = EXCLUDED.output,
    58	      created_on   = EXCLUDED.created_on,
    59	      started_on   = EXCLUDED.started_on,
    60	      completed_on = EXCLUDED.completed_on,
    61	      seq          = new_seq;
    62	
    63	    PERFORM pg_notify(
    64	      'pgbossier_job',
    65	      json_build_object(
    66	        'job_id',      NEW.id,
    67	        'queue',       NEW.name,
    68	        'attempt',     NEW.retry_count,
    69	        'state',       NEW.state,
    70	        'seq',         new_seq,
    71	        'captured_at', now()
    72	      )::text
    73	    );
    74	  EXCEPTION WHEN OTHERS THEN
    75	    -- fail-open per issue #1: log and continue.
    76	    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
    77	  END;
    78	  RETURN NULL;
    79	END;
    80	$$;`;
    81	
    82	export const CAPTURE_TRIGGER_SQL = `
    83	DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;
    84	CREATE TRIGGER pgbossier_capture
    85	  AFTER INSERT OR UPDATE OF state ON pgboss.job
    86	  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();`;
    87	
    88	export const BACKFILL_SQL = `
    89	INSERT INTO pgbossier.record
    90	  (job_id, queue, attempt, state, data, output,
    91	   created_on, started_on, completed_on, captured_at)
    92	SELECT id, name, retry_count, state, data, output,
    93	       created_on, started_on, completed_on, now()
    94	FROM pgboss.job
    95	ON CONFLICT (job_id, attempt) DO NOTHING;`;
     1	import type { Pool } from 'pg';
     2	import {
     3	  SCHEMA_SQL, SEQUENCE_SQL, RECORD_TABLE_SQL, RECORD_INDEXES_SQL,
     4	  RECORD_SEQ_COLUMN_SQL, RECORD_SEQ_INDEX_SQL,
     5	  CAPTURE_FUNCTION_SQL, CAPTURE_TRIGGER_SQL, BACKFILL_SQL,
     6	} from './sql.js';
     7	
     8	export async function install(pool: Pool): Promise<void> {
     9	  await pool.query(SCHEMA_SQL);
    10	  await pool.query(SEQUENCE_SQL);
    11	  await pool.query(RECORD_TABLE_SQL);
    12	  await pool.query(RECORD_SEQ_COLUMN_SQL);
    13	  await pool.query(RECORD_SEQ_INDEX_SQL);
    14	  for (const indexSql of RECORD_INDEXES_SQL) {
    15	    await pool.query(indexSql);
    16	  }
    17	  await pool.query(CAPTURE_FUNCTION_SQL);
    18	  await pool.query(CAPTURE_TRIGGER_SQL);
    19	  await pool.query(BACKFILL_SQL);
    20	}
    21	
    22	export async function uninstall(pool: Pool): Promise<void> {
    23	  await pool.query(`DROP SCHEMA IF EXISTS pgbossier CASCADE;`);
    24	}
     1	{
     2	    "name": "pg-bossier",
     3	    "version": "0.0.0",
     4	    "description": "Operational data-plane on pg-boss: forensic preservation with lineage and failure classes, typed query API, mid-flight progress, and subscribable job events. Extends pg-boss, never replaces it.",
     5	    "author": "Andrei Lavrenov <andrei@lav.ren>",
     6	    "license": "MIT",
     7	    "type": "module",
     8	    "repository": {
     9	        "type": "git",
    10	        "url": "git+https://github.com/elfensky/pg-bossier.git"
    11	    },
    12	    "bugs": {
    13	        "url": "https://github.com/elfensky/pg-bossier/issues"
    14	    },
    15	    "homepage": "https://github.com/elfensky/pg-bossier#readme",
    16	    "main": "./dist/index.js",
    17	    "types": "./dist/index.d.ts",
    18	    "exports": {
    19	        ".": {
    20	            "types": "./dist/index.d.ts",
    21	            "default": "./dist/index.js"
    22	        }
    23	    },
    24	    "files": [
    25	        "dist"
    26	    ],
    27	    "engines": {
    28	        "node": ">=18"
    29	    },
    30	    "scripts": {
    31	        "build": "tsc",
    32	        "prepare": "npm run build",
    33	        "lint": "eslint .",
    34	        "lint:fix": "eslint . --fix",
    35	        "test": "vitest run",
    36	        "test:perf": "vitest run --config vitest.perf.config.ts"
    37	    },
    38	    "peerDependencies": {
    39	        "pg-boss": "^12.18.2",
    40	        "pg": "^8.0.0"
    41	    },
    42	    "devDependencies": {
    43	        "@testcontainers/postgresql": "^12.0.0",
    44	        "@types/pg": "^8.20.0",
    45	        "eslint": "^10.4.0",
    46	        "pg": "^8.21.0",
    47	        "pg-boss": "^12.18.2",
    48	        "typescript": "^6.0.3",
    49	        "typescript-eslint": "^8.59.0",
    50	        "vitest": "^4.1.7"
    51	    }
    52	}
     1	# Lint, build, and run the integration suite on every push to develop or main
     2	# and every PR. The suite uses @testcontainers/postgresql; Docker is preinstalled
     3	# on the ubuntu-latest runner, so no `services:` Postgres block is needed. A
     4	# separate tripwire job warns when pg-boss publishes a minor above the
     5	# peer-dep floor — see COMPATIBILITY.md "Version support" for the policy.
     6	name: CI
     7	
     8	on:
     9	  push:
    10	    branches: [develop, main]
    11	  pull_request:
    12	
    13	jobs:
    14	  verify:
    15	    runs-on: ubuntu-latest
    16	    timeout-minutes: 15
    17	    steps:
    18	      - uses: actions/checkout@v4
    19	      - uses: actions/setup-node@v4
    20	        with:
    21	          node-version: '22'
    22	          cache: npm
    23	      - run: npm ci
    24	      - run: npm run lint
    25	      - run: npm run build
    26	      - run: npm test
    27	
    28	  pg-boss-version-tripwire:
    29	    # Warns (does not fail) when the latest published pg-boss minor is above
    30	    # the peer-dep floor declared in package.json. The trigger to add a
    31	    # floor+latest matrix (and the correctness assertions that earn it) is
    32	    # this warning firing. See COMPATIBILITY.md "Version support".
    33	    runs-on: ubuntu-latest
    34	    timeout-minutes: 2
    35	    steps:
    36	      - uses: actions/checkout@v4
    37	      - name: Compare pg-boss floor vs latest published minor
    38	        run: |
    39	          set -euo pipefail
    40	          FLOOR_RANGE=$(node -e "console.log(require('./package.json').peerDependencies['pg-boss'])")
    41	          FLOOR_MM=$(printf '%s' "$FLOOR_RANGE" | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1.\2/')
    42	          LATEST=$(npm view pg-boss version)
    43	          LATEST_MM=$(printf '%s' "$LATEST" | sed -E 's/^([0-9]+)\.([0-9]+).*/\1.\2/')
    44	          echo "Peer-dep range: $FLOOR_RANGE  (minor: $FLOOR_MM)"
    45	          echo "Latest published: $LATEST     (minor: $LATEST_MM)"
    46	          if [ "$FLOOR_MM" = "$LATEST_MM" ]; then
    47	            echo "Floor and latest minor match — no tripwire."
    48	          else
    49	            echo "::warning::pg-boss latest minor ($LATEST_MM, version $LATEST) is above the peer-dep floor minor ($FLOOR_MM, range $FLOOR_RANGE). See COMPATIBILITY.md section 'Version support — no matrix today, self-firing tripwire'."
    50	          fi

codex
# Codex critique — Round 1

Reviewed [2026-05-23-goal-9-install-distribution-shape-design.md](/Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md).

1. The schema validator is overstated. The spec says `^[a-z_][a-z0-9_]*$` “matches Postgres unquoted-identifier rules” and is the injection guardrail (lines 127-172, 570). It is a safe subset, not an exact match: Postgres unquoted identifiers also allow `$`, uppercase folds to lowercase, and the spec ignores reserved words, `pg_`-prefixed names, and identifier byte-length limits. The length omission is material because `${schema}_job` needs headroom too; a 63-byte schema name can make the derived channel truncate/collide.

2. The NOTIFY fix is not the only isolation problem. The spec claims schema configurability “unblocks multi-instance pg-bossier” and that channel scoping is the correctness fix (lines 90-94, 376-386, 543), but the actual design still attaches a trigger to `${pgbossSchema}.job`. With the current trigger pattern in [src/sql.ts](/Users/andrei/Developer/github/pg-bossier/src/sql.ts:82), a second install on the same `pgbossSchema` drops and replaces the first trigger. Even if trigger names become unique, both triggers would then fire on the same source table and duplicate capture into multiple audit schemas; backfill has the same duplication issue. The spec needs an explicit topology contract: either `1 pgbossier schema : 1 pgboss schema`, or a real multi-writer design.

3. The additive-only upgrade policy is plausible for some future changes, but the manual path is underspecified. Lines 407-422 say non-additive changes go in the CHANGELOG with “manual upgrade SQL,” but there is no execution model: app boot script, one-shot CLI, `psql`, or checked-in SQL file. For a primary consumer that is explicitly “descent-app first,” “copy SQL from CHANGELOG” is too loose. At minimum the spec should define a supported manual migration harness or runner story.

4. `util.parseArgs` itself is fine for connection strings; I verified `--conn-string=postgres://user:pass@host:5432/db?sslmode=require&x=y` parses correctly. The real CLI problems are elsewhere: line 288’s `DATABASE_URL` fallback is risky for an admin command, and lines 355-365 call `process.exit(...)` before `finally { await pool.end() }`, which means cleanup never runs. Windows `npx`/`npm run --` are probably fine via npm’s bin shims; the spec’s control-flow sketch is the part that is wrong.

5. The distribution section has one false claim. Lines 523-526 say all three install paths exercise `prepare` and “npm runs `tsc` after install”; that is not true for tarball consumption. I verified locally on npm 11: git installs run `prepare`, `npm pack` runs `prepare`/`prepack` while building the tarball, and installing the tarball just unpacks the built artifacts. The good news: lockfiles do record the git commit SHA in `resolved`, and npm does preserve/install bin executability correctly.

6. The `develop -> main` snapshot runbook is workable but underexplained. The repo really does have unrelated `main` and `develop` histories, so `git read-tree -u --reset develop` will force the tree shape the spec wants (lines 482-487). The cost is that `main` history will not reflect `develop` ancestry at all; future `git log`/blame on `main` will look like periodic snapshots, not lineage. Also, the runbook should require a clean worktree before `read-tree`. Tag-push Actions risk looks low here because [.github/workflows/ci.yml](/Users/andrei/Developer/github/pg-bossier/.github/workflows/ci.yml:8) only triggers on branch pushes, not tags.

7. The schema-mismatch failure mode is understated. Lines 226-228 say wrong `pgbossSchema` fails on `CREATE TRIGGER`, but [src/install.ts](/Users/andrei/Developer/github/pg-bossier/src/install.ts:8) runs many prior DDL statements first and the spec keeps that ordering. So the failure is late and leaves a partially created `pgbossier` schema, table, sequence, indexes, and function behind. `uninstall()` will probably clean that up, but the spec should say `install()` is transactional or explicitly accept partial install state. Right now it handwaves the sharp edge.

8. The symmetric-uninstall claim is mostly right, but only for the supported topology it never defines. `DROP SCHEMA ... CASCADE` will remove the schema-owned table, sequence, indexes, function, and dependent trigger (lines 223-225). NOTIFY channels are not durable objects, so there is nothing to “drop” there. The real uninstall hazard is the same shared-trigger topology from point 2: if installs share a `pgbossSchema`, uninstalling one can remove the only active trigger path and silently break the other.

9. The Prisma coexistence section is too absolute for a Prisma-heavy primary consumer. Lines 456-458 say Prisma only manages declared schemas and therefore “doesn’t see” `pgbossier`; that is only true if consumers keep `pgbossier` out of `datasource.schemas`. With multi-schema introspection in play, the doc needs to say exactly how to exclude `pgbossier`, and what to expect from `db pull` / `migrate diff` drift checks. “Documentation contract” is fine, but the contract needs to be explicit.

10. Test coverage is not sufficient as written. The plan covers happy-path schema options and CLI basics (lines 541-548), but it misses the highest-risk cases: shared-`pgbossSchema` multi-install behavior, identifier length / reserved-name rejection, transactional rollback on wrong `pgbossSchema`, and actual git/tarball consumer smoke tests. It also does not acknowledge that many existing tests hardcode `pgbossier` / `pgbossier_job` today, so the “existing default-schema tests stay green” claim needs an audit, not an assumption.

11. Against the charter, the main issue is overreach, not surface area. A thin CLI does not violate “no UI/REST,” and schema configurability is KISS enough. The problem is that the spec quietly turns “custom schema names” into “multi-instance support” without a sound ownership model for triggers/backfill. That is a correctness claim, not just an ergonomic one.

12. Missing entirely: a preflight check that the target `${pgbossSchema}.job` exists and is the table you expect before mutating anything, and a supported-topology matrix. Those two omissions are why several other sections read as stronger than the design actually is.

**SHIP WITH NAMED CHANGES**

CHANGE: Narrow or redesign the multi-instance claim. Either declare `1 pgbossier schema : 1 pgboss schema` as the only supported topology, or introduce a real trigger naming/ownership model and test it.  
CHANGE: Replace the schema validator claim with a documented safe subset and add checks for reserved/system names, `pg_` prefix, and byte-length; if channel names remain `${schema}_job`, cap schema length so the derived channel cannot truncate/collide.  
CHANGE: Make `install()` transactional and add a preflight existence check for `${pgbossSchema}.job` before creating pg-bossier-owned objects.  
CHANGE: Define a concrete manual-migration harness for non-additive upgrades; “SQL in CHANGELOG” alone is not an operational story.  
CHANGE: Fix the CLI sketch to avoid `process.exit()` before cleanup, and reconsider `DATABASE_URL` fallback for install/uninstall commands.  
CHANGE: Correct the packaging claims: git install runs `prepare`; tarball consumer install does not. Add explicit CI smoke tests for `git` install and `npm pack` install.  
CHANGE: Expand Prisma docs to state the exact exclusion contract for `multiSchema` users and what drift/introspection behavior to expect.
tokens used
112,024
# Codex critique — Round 1

Reviewed [2026-05-23-goal-9-install-distribution-shape-design.md](/Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md).

1. The schema validator is overstated. The spec says `^[a-z_][a-z0-9_]*$` “matches Postgres unquoted-identifier rules” and is the injection guardrail (lines 127-172, 570). It is a safe subset, not an exact match: Postgres unquoted identifiers also allow `$`, uppercase folds to lowercase, and the spec ignores reserved words, `pg_`-prefixed names, and identifier byte-length limits. The length omission is material because `${schema}_job` needs headroom too; a 63-byte schema name can make the derived channel truncate/collide.

2. The NOTIFY fix is not the only isolation problem. The spec claims schema configurability “unblocks multi-instance pg-bossier” and that channel scoping is the correctness fix (lines 90-94, 376-386, 543), but the actual design still attaches a trigger to `${pgbossSchema}.job`. With the current trigger pattern in [src/sql.ts](/Users/andrei/Developer/github/pg-bossier/src/sql.ts:82), a second install on the same `pgbossSchema` drops and replaces the first trigger. Even if trigger names become unique, both triggers would then fire on the same source table and duplicate capture into multiple audit schemas; backfill has the same duplication issue. The spec needs an explicit topology contract: either `1 pgbossier schema : 1 pgboss schema`, or a real multi-writer design.

3. The additive-only upgrade policy is plausible for some future changes, but the manual path is underspecified. Lines 407-422 say non-additive changes go in the CHANGELOG with “manual upgrade SQL,” but there is no execution model: app boot script, one-shot CLI, `psql`, or checked-in SQL file. For a primary consumer that is explicitly “descent-app first,” “copy SQL from CHANGELOG” is too loose. At minimum the spec should define a supported manual migration harness or runner story.

4. `util.parseArgs` itself is fine for connection strings; I verified `--conn-string=postgres://user:pass@host:5432/db?sslmode=require&x=y` parses correctly. The real CLI problems are elsewhere: line 288’s `DATABASE_URL` fallback is risky for an admin command, and lines 355-365 call `process.exit(...)` before `finally { await pool.end() }`, which means cleanup never runs. Windows `npx`/`npm run --` are probably fine via npm’s bin shims; the spec’s control-flow sketch is the part that is wrong.

5. The distribution section has one false claim. Lines 523-526 say all three install paths exercise `prepare` and “npm runs `tsc` after install”; that is not true for tarball consumption. I verified locally on npm 11: git installs run `prepare`, `npm pack` runs `prepare`/`prepack` while building the tarball, and installing the tarball just unpacks the built artifacts. The good news: lockfiles do record the git commit SHA in `resolved`, and npm does preserve/install bin executability correctly.

6. The `develop -> main` snapshot runbook is workable but underexplained. The repo really does have unrelated `main` and `develop` histories, so `git read-tree -u --reset develop` will force the tree shape the spec wants (lines 482-487). The cost is that `main` history will not reflect `develop` ancestry at all; future `git log`/blame on `main` will look like periodic snapshots, not lineage. Also, the runbook should require a clean worktree before `read-tree`. Tag-push Actions risk looks low here because [.github/workflows/ci.yml](/Users/andrei/Developer/github/pg-bossier/.github/workflows/ci.yml:8) only triggers on branch pushes, not tags.

7. The schema-mismatch failure mode is understated. Lines 226-228 say wrong `pgbossSchema` fails on `CREATE TRIGGER`, but [src/install.ts](/Users/andrei/Developer/github/pg-bossier/src/install.ts:8) runs many prior DDL statements first and the spec keeps that ordering. So the failure is late and leaves a partially created `pgbossier` schema, table, sequence, indexes, and function behind. `uninstall()` will probably clean that up, but the spec should say `install()` is transactional or explicitly accept partial install state. Right now it handwaves the sharp edge.

8. The symmetric-uninstall claim is mostly right, but only for the supported topology it never defines. `DROP SCHEMA ... CASCADE` will remove the schema-owned table, sequence, indexes, function, and dependent trigger (lines 223-225). NOTIFY channels are not durable objects, so there is nothing to “drop” there. The real uninstall hazard is the same shared-trigger topology from point 2: if installs share a `pgbossSchema`, uninstalling one can remove the only active trigger path and silently break the other.

9. The Prisma coexistence section is too absolute for a Prisma-heavy primary consumer. Lines 456-458 say Prisma only manages declared schemas and therefore “doesn’t see” `pgbossier`; that is only true if consumers keep `pgbossier` out of `datasource.schemas`. With multi-schema introspection in play, the doc needs to say exactly how to exclude `pgbossier`, and what to expect from `db pull` / `migrate diff` drift checks. “Documentation contract” is fine, but the contract needs to be explicit.

10. Test coverage is not sufficient as written. The plan covers happy-path schema options and CLI basics (lines 541-548), but it misses the highest-risk cases: shared-`pgbossSchema` multi-install behavior, identifier length / reserved-name rejection, transactional rollback on wrong `pgbossSchema`, and actual git/tarball consumer smoke tests. It also does not acknowledge that many existing tests hardcode `pgbossier` / `pgbossier_job` today, so the “existing default-schema tests stay green” claim needs an audit, not an assumption.

11. Against the charter, the main issue is overreach, not surface area. A thin CLI does not violate “no UI/REST,” and schema configurability is KISS enough. The problem is that the spec quietly turns “custom schema names” into “multi-instance support” without a sound ownership model for triggers/backfill. That is a correctness claim, not just an ergonomic one.

12. Missing entirely: a preflight check that the target `${pgbossSchema}.job` exists and is the table you expect before mutating anything, and a supported-topology matrix. Those two omissions are why several other sections read as stronger than the design actually is.

**SHIP WITH NAMED CHANGES**

CHANGE: Narrow or redesign the multi-instance claim. Either declare `1 pgbossier schema : 1 pgboss schema` as the only supported topology, or introduce a real trigger naming/ownership model and test it.  
CHANGE: Replace the schema validator claim with a documented safe subset and add checks for reserved/system names, `pg_` prefix, and byte-length; if channel names remain `${schema}_job`, cap schema length so the derived channel cannot truncate/collide.  
CHANGE: Make `install()` transactional and add a preflight existence check for `${pgbossSchema}.job` before creating pg-bossier-owned objects.  
CHANGE: Define a concrete manual-migration harness for non-additive upgrades; “SQL in CHANGELOG” alone is not an operational story.  
CHANGE: Fix the CLI sketch to avoid `process.exit()` before cleanup, and reconsider `DATABASE_URL` fallback for install/uninstall commands.  
CHANGE: Correct the packaging claims: git install runs `prepare`; tarball consumer install does not. Add explicit CI smoke tests for `git` install and `npm pack` install.  
CHANGE: Expand Prisma docs to state the exact exclusion contract for `multiSchema` users and what drift/introspection behavior to expect.

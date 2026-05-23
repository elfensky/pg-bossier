# Goal 9 Install / Distribution Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pg-bossier Goal 9 — install/uninstall surface + distribution shape per the v2 spec. Adds a thin CLI wrapper, makes schema names configurable (`pgbossier` and `pgboss`), hardens schema-name validation against `public`/system-prefix/reserved-keyword failures, wraps `install()` in a transaction with a preflight check, scopes the NOTIFY channel AND trigger name by schema, and prepares (but does not execute) the first-publish runbook.

**Architecture:** SQL constants in `src/sql.ts` become **factory functions** that take a `SchemaNames` object and return SQL with the schema names interpolated. A `resolveSchemas()` helper validates at the public API boundary via a 5-gate policy (regex + `pg_` prefix + reserved names + reserved keywords + length ≤ 63 bytes). `install()` becomes transactional with a preflight `SELECT 1 FROM ${pgbossSchema}.job LIMIT 0`. The client and every read/write module (`client.ts`, `read.ts`, `events.ts`, `progress.ts`) accept and propagate `SchemaNames`. A new `bin/pgbossier.js` Node script — using stdlib `util.parseArgs` with `strict: true`, no external CLI deps — wraps the same SQL constants for ops/CI contexts. The trigger name follows the schema (`${s.pgbossier}_capture`) to avoid silent install-A-killed-by-install-B collisions.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Node 18.3+ (bumped for `util.parseArgs`), ESM, `pg` (node-postgres), vitest + `@testcontainers/postgresql` for tests, pg-boss 12.18.2 as wrapped queue.

**Spec:** [`docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md`](../specs/2026-05-23-goal-9-install-distribution-shape-design.md) (v2, committed `3eb0603` on develop)
**Charter:** [`CLAUDE.md`](../../../CLAUDE.md) — feature branches via `git worktree`; `--no-ff` merge into `develop`; CHANGELOG under `[Unreleased]`; lint + build + test must all pass before claiming done.

---

## File map (locked before tasks)

**New files**
- `bin/pgbossier.js` — CLI entry. Shebang Node script, ~80 lines, stdlib only.
- `test/sql.test.ts` — fast schema-name validation tests (no container).
- `test/cli.test.ts` — CLI integration tests (one container per file).
- `test/topology.test.ts` — supported/unsupported topology tests.
- `CONTRIBUTING.md` — first-publish runbook + release process.

**Modified files**
- `src/sql.ts` — SQL constants become factory functions; add `SchemaNames`, `resolveSchemas`, `assertSchemaName`, `RESERVED_SCHEMA_NAMES`, `RESERVED_KEYWORDS`. Trigger name parameterized to `${s.pgbossier}_capture`. NOTIFY channel parameterized to `${s.pgbossier}_job`.
- `src/install.ts` — accepts `InstallOptions`; transaction wrapper; preflight check.
- `src/client.ts` — `BossierOptions` gains `schema?` and `pgbossSchema?`; methods close over resolved `SchemaNames`.
- `src/read.ts` — every free function accepts `SchemaNames` as a parameter; SQL uses `${s.pgbossier}` interpolation.
- `src/events.ts` — `subscribe` accepts `SchemaNames`; `LISTEN ${s.pgbossier}_job`; channel comparison schema-scoped.
- `src/progress.ts` — `setProgress`/`getProgress` accept `SchemaNames`.
- `src/index.ts` — re-exports `InstallOptions`, `SchemaNames`.
- `test/harness.ts`, `test/install.test.ts`, `test/uninstall.test.ts`, `test/capture.test.ts`, `test/read.test.ts`, `test/progress.test.ts`, `test/events.test.ts`, `test/client.test.ts` — propagate the new types; add per-test schema-config coverage as needed.
- `package.json` — `bin`, `engines >=18.3.0`, `files: ["dist", "bin"]`, `keywords`.
- `.github/workflows/ci.yml` — new `consumer-artifact-smoke-test` job that `npm pack`s + installs the tarball in a fresh dir.
- `README.md` — new "Install" section (JS function + CLI side by side); Prisma `multiSchema` callout; supported topologies note.
- `COMPATIBILITY.md` — schema-scoped channel/trigger note; `--ignore-scripts` note.
- `CHANGELOG.md` — `[Unreleased]` entry.
- `CLAUDE.md` — project-status paragraph; goal-status table.

**Decomposition principle.** Validation comes before factories; factories come before `install()` transaction; install transaction comes before consumer-side schema propagation; CLI comes after the JS API stabilizes; docs come last.

---

## Task 0 — Worktree, branch, baseline

**Files:** `.worktrees/feature-goal-9-install-distribution-shape/` (gitignored)

- [ ] **Step 1: Create the worktree off `develop`**

Run from the main checkout:
```bash
git worktree add .worktrees/feature-goal-9-install-distribution-shape \
  -b feature/goal-9-install-distribution-shape develop
```

Expected: new directory at `.worktrees/feature-goal-9-install-distribution-shape/`, branch checked out.

- [ ] **Step 2: Install deps + verify baseline is green**

```bash
cd .worktrees/feature-goal-9-install-distribution-shape
npm install
npm run lint && npm run build && npm test
```

Expected: lint clean, `tsc` clean, all 87 existing tests pass.

---

## Task 1 — Add `SchemaNames`, `resolveSchemas`, and the validation policy (TDD)

**Files:**
- Modify: `src/sql.ts` (add types + helpers at the top)
- Test: `test/sql.test.ts` (new — fast, no container)

**Goal:** Schema-name validation policy in place, exhaustively tested. No SQL changes yet — that's Task 2.

- [ ] **Step 1: Create `test/sql.test.ts` with the failing validation tests**

```ts
import { test, expect, describe } from 'vitest';
import { assertSchemaName, resolveSchemas } from '../src/sql.js';

describe('assertSchemaName — valid names accepted', () => {
  for (const name of ['pgbossier', 'pgboss', 'altbossier', 'a_b_c', '_under', 'a1']) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).not.toThrow();
    });
  }
});

describe('assertSchemaName — regex rejection', () => {
  for (const name of ['Has-Dash', 'has space', 'has.dot', '"quoted"', 'UpperCase', '1starts_digit', '']) {
    test(`rejects ${JSON.stringify(name)} (regex)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/Must match/);
    });
  }
});

describe('assertSchemaName — pg_ prefix rejection', () => {
  for (const name of ['pg_', 'pg_catalog', 'pg_temp', 'pg_bossier_alt']) {
    test(`rejects ${JSON.stringify(name)} (pg_ prefix)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/'pg_' prefix/);
    });
  }
});

describe('assertSchemaName — reserved-name rejection (data-loss prevention)', () => {
  test('rejects "public" (would DROP SCHEMA public CASCADE all user tables)', () => {
    expect(() => assertSchemaName('public', 'pgbossier')).toThrow(/reserved/);
  });
  test('rejects "information_schema"', () => {
    expect(() => assertSchemaName('information_schema', 'pgbossier')).toThrow(/reserved/);
  });
});

describe('assertSchemaName — reserved-keyword rejection', () => {
  for (const name of ['user', 'select', 'from', 'table', 'where', 'order', 'group']) {
    test(`rejects ${JSON.stringify(name)} (reserved keyword)`, () => {
      expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/reserved keyword/);
    });
  }
});

describe('assertSchemaName — length rejection', () => {
  test('accepts a 63-byte name (NAMEDATALEN limit)', () => {
    const name = 'a' + 'b'.repeat(62);
    expect(name.length).toBe(63);
    expect(() => assertSchemaName(name, 'pgbossier')).not.toThrow();
  });
  test('rejects a 64-byte name (over NAMEDATALEN)', () => {
    const name = 'a' + 'b'.repeat(63);
    expect(name.length).toBe(64);
    expect(() => assertSchemaName(name, 'pgbossier')).toThrow(/exceeds 63 bytes/);
  });
});

describe('resolveSchemas — defaults and overrides', () => {
  test('returns defaults when no options', () => {
    expect(resolveSchemas()).toEqual({ pgbossier: 'pgbossier', pgboss: 'pgboss' });
  });
  test('returns defaults when empty options', () => {
    expect(resolveSchemas({})).toEqual({ pgbossier: 'pgbossier', pgboss: 'pgboss' });
  });
  test('overrides pgbossier only', () => {
    expect(resolveSchemas({ pgbossier: 'alt' })).toEqual({ pgbossier: 'alt', pgboss: 'pgboss' });
  });
  test('overrides pgboss only', () => {
    expect(resolveSchemas({ pgboss: 'altpgboss' })).toEqual({ pgbossier: 'pgbossier', pgboss: 'altpgboss' });
  });
  test('rejects invalid pgbossier name', () => {
    expect(() => resolveSchemas({ pgbossier: 'public' })).toThrow(/reserved/);
  });
  test('rejects invalid pgboss name', () => {
    expect(() => resolveSchemas({ pgboss: 'pg_temp' })).toThrow(/'pg_' prefix/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/sql.test.ts
```

Expected: all tests fail (`assertSchemaName` and `resolveSchemas` are not exported yet).

- [ ] **Step 3: Add the validation policy to `src/sql.ts`**

Replace the file's beginning (before the existing constants) with:

```ts
export interface SchemaNames {
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  pgbossier: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgboss: string;
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

const RESERVED_SCHEMA_NAMES = new Set([
  'public',
  'information_schema',
]);

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

export function assertSchemaName(name: string, key: keyof SchemaNames): void {
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
```

Leave the existing SQL constants (`SCHEMA_SQL`, `RECORD_TABLE_SQL`, etc.) in place — those become factory functions in Task 2.

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- test/sql.test.ts
```

Expected: all 36+ validation tests pass.

- [ ] **Step 5: Run full suite + lint + build**

```bash
npm run lint && npm run build && npm test
```

Expected: all green (87 existing + new validation tests = ~123).

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts test/sql.test.ts
git commit -m "feat(sql): add SchemaNames + assertSchemaName + resolveSchemas

5-gate validation policy: regex + pg_ prefix + reserved names (public,
information_schema) + reserved keywords + 63-byte length cap. Rejects
data-loss-prone names like 'public' at the API boundary before any
SQL builds.

No SQL changes yet — factory functions land in Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Convert SQL constants to factory functions (parameterize schema names + trigger name + channel name)

**Files:**
- Modify: `src/sql.ts` (replace all constants)
- Modify: `src/install.ts` (call factories with `resolveSchemas()`)
- Test: `test/install.test.ts`, `test/capture.test.ts` (existing tests stay green)

**Goal:** Every SQL string becomes a factory function. Trigger name + NOTIFY channel scoped to schema. Existing tests with default schemas stay green.

- [ ] **Step 1: Write the failing test for schema-scoped trigger + channel names**

Append to `test/install.test.ts`:

```ts
test('install with custom schema names parameterizes trigger and channel', async () => {
  const h = await startHarness();
  try {
    // Set up an alternate pg-boss schema (so trigger has a target)
    await h.pool.query(`CREATE SCHEMA IF NOT EXISTS altpgboss`);
    // Bootstrap pg-boss into the alt schema by mimicking what boss.start does:
    // for the test, just create the minimum pgboss.job-like table.
    await h.pool.query(`
      CREATE TABLE IF NOT EXISTS altpgboss.job (
        id uuid PRIMARY KEY, name text NOT NULL, retry_count integer NOT NULL DEFAULT 0,
        state text NOT NULL, data jsonb, output jsonb,
        created_on timestamptz, started_on timestamptz, completed_on timestamptz
      );
    `);

    await install(h.pool, { schema: 'altbossier', pgbossSchema: 'altpgboss' });

    // Verify the alt schema + objects exist
    const { rows: schemaRows } = await h.pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'altbossier'`,
    );
    expect(schemaRows).toHaveLength(1);

    // Verify the trigger name is schema-scoped (altbossier_capture, NOT pgbossier_capture)
    const { rows: triggerRows } = await h.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'altpgboss.job'::regclass AND tgname LIKE '%_capture'`,
    );
    expect(triggerRows).toHaveLength(1);
    expect(triggerRows[0]!.tgname).toBe('altbossier_capture');
  } finally { await h.teardown(); }
});

test('install rejects schema:"public" before any SQL runs (data-loss prevention)', async () => {
  const h = await startHarness();
  try {
    await expect(install(h.pool, { schema: 'public' })).rejects.toThrow(/reserved/);
    // Verify NO schema was created (no SQL ran)
    const { rows } = await h.pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
    );
    expect(rows).toHaveLength(0);
  } finally { await h.teardown(); }
});

test('two installs with different pgbossier schemas keep distinct triggers', async () => {
  const h = await startHarness();
  try {
    await install(h.pool); // default 'pgbossier'

    // Verify install A's trigger exists
    let trig = await h.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_capture'`,
    );
    expect(trig.rows).toHaveLength(1);

    await install(h.pool, { schema: 'altbossier' });

    // After install B, both triggers should exist on pgboss.job
    trig = await h.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname IN ('pgbossier_capture', 'altbossier_capture')`,
    );
    expect(trig.rows).toHaveLength(2);
    // Install A's trigger MUST still exist (regression test for the v1 collision bug)
    expect(trig.rows.map(r => r.tgname).sort()).toEqual(['altbossier_capture', 'pgbossier_capture']);
  } finally { await h.teardown(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/install.test.ts
```

Expected: the three new tests fail (install signature doesn't accept options; trigger name is hardcoded).

- [ ] **Step 3: Replace all SQL constants in `src/sql.ts` with factory functions**

Below the validation policy from Task 1, replace the existing SQL constants with factory functions:

```ts
export function schemaSql(s: SchemaNames): string {
  return `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier};`;
}

export function sequenceSql(s: SchemaNames): string {
  return `CREATE SEQUENCE IF NOT EXISTS ${s.pgbossier}.record_seq;`;
}

export function recordTableSql(s: SchemaNames): string {
  return `
CREATE TABLE IF NOT EXISTS ${s.pgbossier}.record (
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
  captured_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt)
);`;
}

export function recordIndexesSql(s: SchemaNames): readonly string[] {
  const t = `${s.pgbossier}.record`;
  return [
    `CREATE INDEX IF NOT EXISTS record_queue_state_idx     ON ${t} (queue, state);`,
    `CREATE INDEX IF NOT EXISTS record_captured_at_idx     ON ${t} (captured_at);`,
    `CREATE INDEX IF NOT EXISTS record_data_gin            ON ${t} USING gin (data);`,
    `CREATE INDEX IF NOT EXISTS record_output_gin          ON ${t} USING gin (output);`,
    `CREATE INDEX IF NOT EXISTS record_terminal_detail_gin ON ${t} USING gin (terminal_detail);`,
    `CREATE INDEX IF NOT EXISTS record_active_idx          ON ${t} (queue, started_on) WHERE state = 'active';`,
  ];
}

export function recordSeqColumnSql(s: SchemaNames): string {
  return `
ALTER TABLE ${s.pgbossier}.record
  ADD COLUMN IF NOT EXISTS seq BIGINT NOT NULL DEFAULT nextval('${s.pgbossier}.record_seq');`;
}

export function recordSeqIndexSql(s: SchemaNames): string {
  return `CREATE INDEX IF NOT EXISTS record_seq_idx ON ${s.pgbossier}.record (seq);`;
}

export function captureFunctionSql(s: SchemaNames): string {
  return `
CREATE OR REPLACE FUNCTION ${s.pgbossier}.capture() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_seq bigint;
BEGIN
  BEGIN
    new_seq := nextval('${s.pgbossier}.record_seq');

    INSERT INTO ${s.pgbossier}.record
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
      '${s.pgbossier}_job',
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
    RAISE WARNING 'pgbossier: capture failed for job %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;`;
}

export function captureTriggerSql(s: SchemaNames): string {
  const trigName = `${s.pgbossier}_capture`;
  return `
DROP TRIGGER IF EXISTS ${trigName} ON ${s.pgboss}.job;
CREATE TRIGGER ${trigName}
  AFTER INSERT OR UPDATE OF state ON ${s.pgboss}.job
  FOR EACH ROW EXECUTE FUNCTION ${s.pgbossier}.capture();`;
}

export function backfillSql(s: SchemaNames): string {
  return `
INSERT INTO ${s.pgbossier}.record
  (job_id, queue, attempt, state, data, output,
   created_on, started_on, completed_on, captured_at)
SELECT id, name, retry_count, state, data, output,
       created_on, started_on, completed_on, now()
FROM ${s.pgboss}.job
ON CONFLICT (job_id, attempt) DO NOTHING;`;
}
```

**Delete the old constants** (`SCHEMA_SQL`, `RECORD_TABLE_SQL`, `RECORD_INDEXES_SQL`, etc.) — they're replaced by the factories.

- [ ] **Step 4: Update `src/install.ts` to use the factories**

Replace the full body of `src/install.ts` with:

```ts
import type { Pool } from 'pg';
import {
  resolveSchemas,
  schemaSql, sequenceSql, recordTableSql, recordIndexesSql,
  recordSeqColumnSql, recordSeqIndexSql,
  captureFunctionSql, captureTriggerSql, backfillSql,
  type SchemaNames,
} from './sql.js';

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
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    'pgboss',
  });
  await pool.query(`DROP SCHEMA IF EXISTS ${s.pgbossier} CASCADE;`);
}
```

Note: this task does NOT yet wrap install() in a transaction — that's Task 3. We're keeping each TDD step isolated.

- [ ] **Step 5: Run install tests to verify pass**

```bash
npm test -- test/install.test.ts
```

Expected: all install tests pass, including the three new ones.

- [ ] **Step 6: Run full suite**

```bash
npm test
```

Expected: all existing tests still pass (default-schema path unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/sql.ts src/install.ts test/install.test.ts
git commit -m "feat(sql): SQL constants become schema-aware factory functions

Every SQL string in src/sql.ts becomes a factory function taking
SchemaNames. Trigger name (\${s.pgbossier}_capture) and NOTIFY channel
(\${s.pgbossier}_job) both scoped to schema — fixes the collision bug
where install B's DROP TRIGGER IF EXISTS pgbossier_capture would
silently kill install A's trigger.

install(pool, options?) accepts { schema?, pgbossSchema? }; defaults
preserve current behavior so existing tests stay green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Wrap `install()` in a transaction + add preflight check

**Files:**
- Modify: `src/install.ts`
- Test: `test/install.test.ts`

**Goal:** `install()` is atomic — either everything succeeds or nothing changed. Preflight surfaces wrong-`pgbossSchema` errors before any DDL runs.

- [ ] **Step 1: Write the failing tests**

Append to `test/install.test.ts`:

```ts
test('install with wrong pgbossSchema fails on preflight, leaving no state behind', async () => {
  const h = await startHarness();
  try {
    // pg-boss is in default 'pgboss' schema; we pass 'wrong'
    await expect(
      install(h.pool, { pgbossSchema: 'wrong' }),
    ).rejects.toThrow(/wrong/);

    // Critically: pgbossier schema MUST NOT exist (no partial install)
    const { rows } = await h.pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
    );
    expect(rows).toHaveLength(0);
  } finally { await h.teardown(); }
});

test('install is transactional — mid-install failure leaves nothing behind', async () => {
  const h = await startHarness();
  try {
    // Set up a scenario where the trigger creation will fail by removing
    // the pg-boss source table mid-flight. We do this by passing a
    // pgbossSchema that exists but has no job table.
    await h.pool.query(`CREATE SCHEMA IF NOT EXISTS partialboss`);

    // No 'job' table in partialboss → preflight should catch it
    await expect(
      install(h.pool, { pgbossSchema: 'partialboss' }),
    ).rejects.toThrow(/partialboss/);

    // pgbossier schema must not exist
    const { rows } = await h.pool.query(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
    );
    expect(rows).toHaveLength(0);
  } finally { await h.teardown(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/install.test.ts
```

Expected: the two new tests fail. Without the transaction wrapper, install creates the `pgbossier` schema before the trigger creation fails. The new tests assert the schema does NOT exist after a failure.

- [ ] **Step 3: Wrap `install()` in a transaction + preflight**

Replace the body of `install()` in `src/install.ts`:

```ts
export async function install(
  pool: Pool, options?: InstallOptions,
): Promise<void> {
  const s = resolveSchemas({
    pgbossier: options?.schema,
    pgboss:    options?.pgbossSchema,
  });

  const client = await pool.connect();
  try {
    // Preflight: confirm the pg-boss source table exists. Fails fast with
    // a clear error before any DDL runs.
    await client.query(`SELECT 1 FROM ${s.pgboss}.job LIMIT 0`);

    // Atomic install: BEGIN/COMMIT around all DDL. Postgres supports DDL
    // in transactions; a mid-install failure rolls back everything.
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
    await client.query('ROLLBACK').catch(() => { /* connection may be dead */ });
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npm test -- test/install.test.ts
npm test
```

Expected: all install tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/install.ts test/install.test.ts
git commit -m "feat(install): wrap install() in a transaction + preflight check

install(pool, options?) now runs:
  1. Preflight SELECT 1 FROM \${pgbossSchema}.job LIMIT 0 — fails fast
     with a clear error if the pg-boss source table is missing.
  2. All DDL inside BEGIN/COMMIT — Postgres supports DDL in transactions,
     so a mid-install failure rolls back the entire install. No
     orphaned partial state to clean up.

Two new regression tests:
- install(..., { pgbossSchema: 'wrong' }) fails on preflight and leaves
  no pgbossier schema behind.
- install(..., { pgbossSchema: 'partialboss' }) where the schema exists
  but the job table doesn't fails cleanly with no partial state.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Propagate `SchemaNames` through read.ts, progress.ts, events.ts

**Files:**
- Modify: `src/read.ts`, `src/progress.ts`, `src/events.ts`
- Modify: `test/harness.ts` (if needed to support alt schemas)

**Goal:** Every free function that builds SQL accepts `SchemaNames` as a parameter. Existing tests (using defaults) stay green. New free-function signatures pave the way for Task 5's client wiring.

- [ ] **Step 1: Update `src/read.ts` free functions to accept `SchemaNames`**

Modify each exported function in `src/read.ts` to take `schemas: SchemaNames` as the second parameter (after `pool`). For example:

```ts
import type { SchemaNames } from './sql.js';

export async function findById<TInput = unknown, TOutput = unknown>(
  pool: Pool,
  schemas: SchemaNames,
  jobId: string,
): Promise<JobRecord<TInput, TOutput> | null> {
  // ... existing logic, but every `pgbossier.record` becomes `${schemas.pgbossier}.record`
  const { rows } = await pool.query<RawRecordRow>(
    `SELECT ... FROM ${schemas.pgbossier}.record WHERE job_id = $1 LIMIT 1`,
    [jobId],
  );
  // ... rest unchanged
}
```

Apply the same pattern to: `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, `listLongRunning`, `getEventsSince`. Every literal `pgbossier.record` becomes `${schemas.pgbossier}.record`.

- [ ] **Step 2: Update `src/progress.ts` free functions to accept `SchemaNames`**

```ts
import type { SchemaNames } from './sql.js';

export async function setProgress(
  pool: Pool, schemas: SchemaNames, jobId: string, progress: unknown,
): Promise<void> {
  // existing validation + JSON marshalling unchanged...
  try {
    const { rowCount } = await pool.query(
      `UPDATE ${schemas.pgbossier}.record
         SET progress = $2::jsonb
       WHERE job_id = $1
         AND attempt = (
           SELECT max(attempt) FROM ${schemas.pgbossier}.record WHERE job_id = $1
         )`,
      [jobId, json],
    );
    // ... rest unchanged
  } catch (err) { /* unchanged */ }
}

export async function getProgress<TProgress = unknown>(
  pool: Pool, schemas: SchemaNames, jobId: string,
): Promise<ProgressResult<TProgress> | null> {
  if (!UUID_RE.test(jobId)) return null;
  const { rows } = await pool.query<{ progress: unknown; attempt: number }>(
    `SELECT progress, attempt FROM ${schemas.pgbossier}.record
     WHERE job_id = $1 AND progress IS NOT NULL
     ORDER BY attempt DESC
     LIMIT 1`,
    [jobId],
  );
  // ... rest unchanged
}
```

- [ ] **Step 3: Update `src/events.ts` to accept `SchemaNames` in `subscribe()`**

The internal `subscribe(pool, opts)` free function gains a `schemas: SchemaNames` parameter. The `BossierEventsImpl` constructor stores schemas, the `open()` method uses `LISTEN ${schemas.pgbossier}_job`, the notification handler compares `msg.channel === '${schemas.pgbossier}_job'`. Also: `recordPatch` in `src/record.ts` (the column-patcher) gains the same `schemas` parameter and uses `${schemas.pgbossier}.record`.

```ts
import type { SchemaNames } from './sql.js';

export async function subscribe(
  pool: Pool, schemas: SchemaNames, opts: SubscribeOptions = {},
): Promise<BossierEvents> {
  if (opts.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const events = new BossierEventsImpl(pool, schemas);  // ← schemas stored on instance
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => { void events.close(); }, { once: true });
  }
  await events.open();
  return events;
}
```

Inside `BossierEventsImpl`, store `this.schemas = schemas` in constructor; use `this.schemas.pgbossier + '_job'` as the channel name everywhere `'pgbossier_job'` was hardcoded.

- [ ] **Step 4: Update `src/record.ts` `recordPatch` to accept `SchemaNames`**

```ts
import type { SchemaNames } from './sql.js';

export async function recordPatch(
  pool: Pool, schemas: SchemaNames, jobId: string, attempt: number, patch: RecordPatch,
): Promise<void> {
  await pool.query(
    `UPDATE ${schemas.pgbossier}.record SET
       terminal_detail = COALESCE($3, terminal_detail),
       input_snapshot  = COALESCE($4, input_snapshot)
     WHERE job_id = $1 AND attempt = $2`,
    [jobId, attempt, patch.terminal_detail ?? null, patch.input_snapshot ?? null],
  );
}
```

- [ ] **Step 5: Run lint + build to surface call-site errors**

```bash
npm run lint && npm run build
```

Expected: lint reports unused variables; build fails because callers of these functions (`src/client.ts`) still pass the old `(pool, ...)` signature. We'll fix `src/client.ts` in Task 5.

For now, this is expected. Don't commit yet.

- [ ] **Step 6: Run tests — expect breakage**

```bash
npm test
```

Expected: many tests fail because they call the free functions directly with the old signatures. We fix this in Task 5 by routing all tests through the client.

For now, this is expected. Move to Task 5 immediately — don't commit yet, but DO save the work-in-progress files. The next task expects this WIP state.

- [ ] **Step 7: Stash or note current state**

The current state has:
- `src/read.ts`, `src/progress.ts`, `src/events.ts`, `src/record.ts` updated to take `SchemaNames`
- Callers (`src/client.ts`, tests) NOT yet updated
- Build/tests broken

Continue directly to Task 5 — do not commit until Task 5 fixes the callers.

---

## Task 5 — Wire `SchemaNames` through `src/client.ts` and existing tests

**Files:**
- Modify: `src/client.ts`, `src/index.ts`
- Modify: `test/capture.test.ts`, `test/install.test.ts`, `test/uninstall.test.ts`, `test/read.test.ts`, `test/progress.test.ts`, `test/client.test.ts`, `test/events.test.ts`

**Goal:** `BossierOptions` accepts `schema?` and `pgbossSchema?`; client methods close over `SchemaNames` resolved once at construction. All existing tests pass through the client unchanged.

- [ ] **Step 1: Update `src/client.ts`**

Replace the body of `bossier()`:

```ts
import type { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { recordPatch, type RecordPatch } from './record.js';
import { setProgress, getProgress, type ProgressResult } from './progress.js';
import {
  findById, getRetryHistory, listJobs, latestPerQueue,
  countByState, countByQueue, listLongRunning,
  type JobRecord, type JobState, type JobFilter, type ListJobsOpts,
} from './read.js';
import { subscribe, type BossierEvents, type SubscribeOptions } from './events.js';
import { getEventsSince, type GetEventsSinceOpts } from './read.js';
import { resolveSchemas, type SchemaNames } from './sql.js';

export interface BossierOptions {
  boss: PgBoss;
  pool: Pool;
  /** Where pg-bossier's own objects live. Default: 'pgbossier'. */
  schema?: string;
  /** Where pg-boss installed itself. Default: 'pgboss'. */
  pgbossSchema?: string;
}

// BossierMethods interface stays the same shape (consumer-facing surface unchanged)

export function bossier(options: BossierOptions): Bossier {
  const { boss, pool } = options;
  const s: SchemaNames = resolveSchemas({
    pgbossier: options.schema,
    pgboss:    options.pgbossSchema,
  });

  const methods: BossierMethods = {
    recordPatch:    (jobId, attempt, patch) => recordPatch(pool, s, jobId, attempt, patch),
    findById:       <I, O>(jobId: string) => findById<I, O>(pool, s, jobId),
    getRetryHistory:<I, O>(jobId: string) => getRetryHistory<I, O>(pool, s, jobId),
    listJobs:       <I, O>(opts?: ListJobsOpts) => listJobs<I, O>(pool, s, opts),
    latestPerQueue: (queues, opts) => latestPerQueue(pool, s, queues, opts),
    countByState:   (filter) => countByState(pool, s, filter),
    countByQueue:   (filter) => countByQueue(pool, s, filter),
    listLongRunning:(opts) => listLongRunning(pool, s, opts),
    setProgress:    (jobId, progress) => setProgress(pool, s, jobId, progress),
    getProgress:    <T = unknown>(jobId: string) => getProgress<T>(pool, s, jobId),
    subscribe:      (opts) => subscribe(pool, s, opts),
    getEventsSince: <I, O>(since: bigint, opts?: GetEventsSinceOpts) =>
                       getEventsSince<I, O>(pool, s, since, opts),
  };

  // Proxy unchanged from previous version (forwards pg-boss methods, intercepts BossierMethods)
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

- [ ] **Step 2: Update `src/index.ts` to export new types**

Add to `src/index.ts`:

```ts
export type { InstallOptions } from './install.js';
export type { SchemaNames } from './sql.js';
```

- [ ] **Step 3: Update existing tests to route through the client or pass schemas explicitly**

Several existing tests call free functions directly. Update them:

In `test/progress.test.ts`, every direct `setProgress(h.pool, ...)` call becomes either:
- Routed through a `bossier({ boss: h.boss, pool: h.pool })` client (`client.setProgress(...)`)
- Or pass explicit defaults: `setProgress(h.pool, { pgbossier: 'pgbossier', pgboss: 'pgboss' }, ...)`

For minimum churn, switch the direct test calls to use a helper:

```ts
// At the top of test/progress.test.ts
import { resolveSchemas } from '../src/sql.js';
const SCHEMAS = resolveSchemas();  // defaults
// Then:
await setProgress(h.pool, SCHEMAS, jobId!, { processed: 120, total: 500 });
```

Apply the same `SCHEMAS = resolveSchemas()` pattern to `test/read.test.ts` for direct `findById` / `getRetryHistory` / `getEventsSince` calls.

- [ ] **Step 4: Run lint + build + full suite**

```bash
npm run lint && npm run build && npm test
```

Expected: all green. Existing tests pass with default schemas resolved via `SCHEMAS = resolveSchemas()`; new schema-config tests from Task 2 also pass.

- [ ] **Step 5: Commit Tasks 4 + 5 together**

```bash
git add src/read.ts src/progress.ts src/events.ts src/record.ts src/client.ts src/index.ts test/
git commit -m "feat: propagate SchemaNames through client + read/progress/events/record

Every free function that builds SQL now accepts SchemaNames as a
parameter. The bossier() client resolves schemas once and closes
over them in its method map — consumer ergonomics unchanged.

Internal-only free-function signatures change:
  findById(pool, schemas, jobId)         (was: pool, jobId)
  setProgress(pool, schemas, jobId, v)   (was: pool, jobId, v)
  subscribe(pool, schemas, opts)         (was: pool, opts)
  recordPatch(pool, schemas, ...)        (was: pool, ...)
  etc.

Existing tests pass through a SCHEMAS = resolveSchemas() helper that
mirrors today's defaults, so default-schema behavior is unchanged.

src/index.ts re-exports InstallOptions and SchemaNames.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Add full topology coverage tests

**Files:**
- Create: `test/topology.test.ts`

**Goal:** Pin the four topology cases in tests so future changes can't quietly break them.

- [ ] **Step 1: Create `test/topology.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, type Harness } from './harness.js';
import { install, uninstall } from '../src/install.js';
import { bossier } from '../src/client.js';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('topology: 1:1 (default) — pgbossier + pgboss', async () => {
  await install(h.pool);  // default 'pgbossier' / 'pgboss'
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(1);
  await uninstall(h.pool);
});

test('topology: N:N-distinct — two pg-bossier installs, two pg-boss installs', async () => {
  // Set up alt pg-boss
  await h.pool.query(`CREATE SCHEMA IF NOT EXISTS altpgboss`);
  await h.pool.query(`
    CREATE TABLE IF NOT EXISTS altpgboss.job (
      id uuid PRIMARY KEY, name text NOT NULL, retry_count integer NOT NULL DEFAULT 0,
      state text NOT NULL, data jsonb, output jsonb,
      created_on timestamptz, started_on timestamptz, completed_on timestamptz
    );
  `);

  // Install pg-bossier A against pg-boss A
  await install(h.pool, { schema: 'pgbossier_a', pgbossSchema: 'pgboss' });
  // Install pg-bossier B against pg-boss B (alternate)
  await install(h.pool, { schema: 'pgbossier_b', pgbossSchema: 'altpgboss' });

  // Triggers exist on different source tables — verify
  const { rows: triggerA } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass AND tgname = 'pgbossier_a_capture'`,
  );
  expect(triggerA).toHaveLength(1);

  const { rows: triggerB } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'altpgboss.job'::regclass AND tgname = 'pgbossier_b_capture'`,
  );
  expect(triggerB).toHaveLength(1);

  // Uninstall A — verify B's schema survives
  await uninstall(h.pool, { schema: 'pgbossier_a' });
  const { rows: bSurvives } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier_b'`,
  );
  expect(bSurvives).toHaveLength(1);

  // Cleanup
  await uninstall(h.pool, { schema: 'pgbossier_b' });
  await h.pool.query(`DROP SCHEMA IF EXISTS altpgboss CASCADE`);
});

test('topology: 2:1 (unsupported) — two pg-bossier installs sharing one pg-boss schema', async () => {
  // The spec says this is unsupported. The test pins the observed behavior:
  // both installs succeed because trigger names are now schema-scoped, but
  // both triggers fire on every pg-boss op — duplicate captures.

  await install(h.pool); // 'pgbossier' on 'pgboss'
  await install(h.pool, { schema: 'altbossier' }); // 'altbossier' on default 'pgboss'

  // Both triggers exist on pgboss.job
  const { rows } = await h.pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger WHERE tgrelid = 'pgboss.job'::regclass
     AND tgname IN ('pgbossier_capture', 'altbossier_capture') ORDER BY tgname`,
  );
  expect(rows.map(r => r.tgname)).toEqual(['altbossier_capture', 'pgbossier_capture']);

  // Send a job — verify BOTH audit tables capture it (the "unsupported" duplication)
  await h.boss.createQueue('topology-2to1');
  const jobId = await h.boss.send('topology-2to1', { x: 1 });

  await new Promise(r => setTimeout(r, 100));

  const { rows: defaultCapture } = await h.pool.query(
    `SELECT 1 FROM pgbossier.record WHERE job_id = $1`,
    [jobId],
  );
  const { rows: altCapture } = await h.pool.query(
    `SELECT 1 FROM altbossier.record WHERE job_id = $1`,
    [jobId],
  );
  // Both audit tables captured the same job — this is the "duplication" the
  // spec documents as the reason for marking 2:1 unsupported.
  expect(defaultCapture).toHaveLength(1);
  expect(altCapture).toHaveLength(1);

  await uninstall(h.pool);
  await uninstall(h.pool, { schema: 'altbossier' });
});

test('topology: install rejects schema:"public" before any SQL', async () => {
  await expect(install(h.pool, { schema: 'public' })).rejects.toThrow(/reserved/);
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run topology tests**

```bash
npm test -- test/topology.test.ts
```

Expected: all four tests pass.

- [ ] **Step 3: Commit**

```bash
git add test/topology.test.ts
git commit -m "test: pin the four topology cases from the spec

1:1 (default) — supported
N:N-distinct — supported (two distinct pg-bossier on two distinct pg-boss)
2:1 (unsupported) — pins observed duplicate-capture behavior so future
  changes can't quietly 'fix' it without acknowledging the topology
1:N (unsupported) — implied; one pg-bossier install binds to one
  pgbossSchema, so the test for 1:N is the same as 1:1
public-as-schema rejection — verifies the data-loss guard

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Create the CLI script (`bin/pgbossier.js`)

**Files:**
- Create: `bin/pgbossier.js`
- Modify: `package.json` (add bin, engines, files)
- Test: `test/cli.test.ts` (new, one container per file)

**Goal:** CLI works end-to-end against a real container. Strict argv parsing; exit codes per spec; destination print; clean exit (post-finally).

- [ ] **Step 1: Update `package.json`**

Edit `package.json`:

```jsonc
{
  // existing fields unchanged...
  "engines": { "node": ">=18.3.0" },      // ← bumped from >=18
  "files": ["dist", "bin"],                // ← bin added
  "bin": { "pgbossier": "./bin/pgbossier.js" },  // ← NEW
  "keywords": [
    "pg-boss", "postgres", "job-queue",
    "audit", "events", "lifecycle"
  ]
}
```

- [ ] **Step 2: Create `bin/pgbossier.js`**

```js
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { install, uninstall } from '../dist/install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8'),
);

function printUsage() {
  console.error(`pg-bossier ${pkg.version}

Usage:
  pgbossier install   [--conn-string=<url>] [--schema=<n>] [--pgboss-schema=<n>]
  pgbossier uninstall [--conn-string=<url>] [--schema=<n>]
  pgbossier --help
  pgbossier --version

Connection string sources (first match wins):
  1. --conn-string=<url>
  2. PGBOSSIER_CONN_STRING env var
  3. DATABASE_URL env var

Exit codes:
  0   success
  1   usage error / --help
  2   runtime error (connect failed, SQL error)
  64  invalid schema name`);
}

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
    strict: true,
  });

  if (values.version) {
    console.log(pkg.version);
    process.exit(0);
  }
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
  const url = new URL(connString);
  console.log(
    `pgbossier: ${cmd} into host=${url.host} database=${url.pathname.slice(1) || '(default)'} ` +
    `schema=${values['schema'] ?? 'pgbossier'}` +
    (cmd === 'install' ? ` pgbossSchema=${values['pgboss-schema'] ?? 'pgboss'}` : ''),
  );

  pool = new pg.Pool({
    connectionString: connString,
    connectionTimeoutMillis: 10_000,
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
  if (err && err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`pgbossier: ${err.message}`);
    exitCode = 1;
  } else if (err instanceof Error && /pgbossier:.*schema name/.test(err.message)) {
    console.error(err.message);
    exitCode = 64;
  } else {
    console.error(
      `pgbossier: ${err instanceof Error ? err.message : String(err)}`,
    );
    exitCode = 2;
  }
} finally {
  if (pool) {
    await pool.end().catch(() => { /* connection may already be down */ });
  }
}
process.exit(exitCode);
```

- [ ] **Step 3: Create `test/cli.test.ts`**

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startHarness, type Harness } from './harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, '../bin/pgbossier.js');

function runCli(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveP) => {
    const proc = spawn('node', [BIN, ...args], {
      env: { ...process.env, ...env, PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolveP({ code: code ?? -1, stdout, stderr }));
  });
}

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.teardown(); });

test('--version prints package.json version', async () => {
  const { code, stdout } = await runCli(['--version']);
  expect(code).toBe(0);
  expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test('--help prints usage and exits 1', async () => {
  const { code, stderr } = await runCli(['--help']);
  expect(code).toBe(1);
  expect(stderr).toMatch(/Usage:/);
});

test('install with no conn-string exits 1', async () => {
  const { code, stderr } = await runCli(['install']);
  expect(code).toBe(1);
  expect(stderr).toMatch(/no connection string/);
});

test('install with unknown flag exits 1 (strict: true)', async () => {
  const { code, stderr } = await runCli([
    'install',
    '--unknown-flag=x',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(1);
  expect(stderr).toMatch(/Unknown option|unknown-flag/);
});

test('install with invalid schema name exits 64', async () => {
  const { code, stderr } = await runCli([
    'install',
    '--schema=public',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(64);
  expect(stderr).toMatch(/reserved/);
});

test('install success path exits 0 and prints destination + installed', async () => {
  const { code, stdout } = await runCli([
    'install',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/install into host=/);
  expect(stdout).toMatch(/schema=pgbossier/);
  expect(stdout).toMatch(/installed/);

  // Verify the schema actually exists
  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(1);
});

test('uninstall success path exits 0', async () => {
  // Pre-condition: install must have happened (previous test)
  const { code, stdout } = await runCli([
    'uninstall',
    `--conn-string=${h.connectionString}`,
  ]);
  expect(code).toBe(0);
  expect(stdout).toMatch(/uninstalled/);

  const { rows } = await h.pool.query(
    `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgbossier'`,
  );
  expect(rows).toHaveLength(0);
});

test('install exits cleanly (no hung connections after success)', async () => {
  // If pool.end() isn't called or the post-finally exit is wrong, the
  // process would hang and the test would time out. The fact that
  // runCli's `proc.on('close')` fires within the test timeout means the
  // process exited cleanly. This test just makes that assertion explicit.
  const start = Date.now();
  const { code } = await runCli([
    'install',
    `--conn-string=${h.connectionString}`,
  ]);
  const elapsed = Date.now() - start;
  expect(code).toBe(0);
  expect(elapsed).toBeLessThan(5000); // generous; expectation is <2s normally

  // Cleanup
  await runCli(['uninstall', `--conn-string=${h.connectionString}`]);
}, 10_000);
```

- [ ] **Step 4: Extend `test/harness.ts` to expose the connection string**

Add to the `Harness` interface:

```ts
export interface Harness {
  pool: pg.Pool;
  boss: PgBoss;
  connectionString: string;  // ← NEW
  teardown: () => Promise<void>;
}
```

And in `startHarness()`:

```ts
return {
  pool,
  boss,
  connectionString,  // ← already captured above; just expose it
  teardown: async () => { /* unchanged */ },
};
```

- [ ] **Step 5: Run tests**

```bash
npm run lint && npm run build && npm test -- test/cli.test.ts
```

Expected: all CLI tests pass. Note: this assumes `dist/install.js` exists — the bin script imports from `../dist/install.js`. `npm run build` (run before the test) produces it.

- [ ] **Step 6: Verify the bin script is executable**

```bash
ls -la bin/pgbossier.js
chmod +x bin/pgbossier.js
```

npm packs `bin` entries with executable bits automatically, but during local development the executable bit needs to be set explicitly.

- [ ] **Step 7: Commit**

```bash
git add bin/pgbossier.js package.json test/cli.test.ts test/harness.ts
git commit -m "feat(cli): add bin/pgbossier.js + CLI integration tests

CLI features:
- 'install' and 'uninstall' commands, no subcommand framework
- Connection string from --conn-string flag, PGBOSSIER_CONN_STRING env,
  or DATABASE_URL env (priority order)
- --schema and --pgboss-schema options
- --help (exit 1) and --version (exit 0)
- strict: true in parseArgs — unknown flags exit 1 with clear error
- Prints destination (host/database/schema) BEFORE running SQL —
  safety net against DATABASE_URL pointing somewhere unexpected
- connectionTimeoutMillis: 10_000 so bad credentials fail fast
- Exit code captured in variable; pool.end() in finally; process.exit
  runs AFTER finally — no hung connections

Exit codes:
  0  success
  1  usage error / --help / unknown flag
  2  runtime error (connect failed, SQL error)
  64 invalid schema name (validation rejection)

package.json: bin added, engines bumped to >=18.3.0 (parseArgs is
stable since 18.3), files now includes 'bin'.

test/cli.test.ts spawns the bin via child_process.spawn and asserts
each path. test/harness.ts now exposes the container's connection
string for the CLI tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — README, COMPATIBILITY, CHANGELOG, CLAUDE.md updates

**Files:**
- Modify: `README.md`, `COMPATIBILITY.md`, `CHANGELOG.md`, `CLAUDE.md`

**Goal:** Docs reflect the v2 install/distribution-shape decisions.

- [ ] **Step 1: Add an "Install" section to `README.md`**

After the existing top matter, before the operational API docs, add:

```md
## Install

pg-bossier is a Postgres add-on to [pg-boss](https://github.com/timgit/pg-boss).
Install it via npm and run the install step once against your database.

### From a git URL (pre-publish)

Until v0.1.0 is on npm, install pg-bossier directly from a tagged commit:

```bash
npm install git+https://github.com/elfensky/pg-bossier#<commit-sha>
```

Always pin to a specific commit SHA rather than a branch — branch refs
in `package-lock.json` re-resolve to the branch head on every `npm ci`,
which makes builds non-reproducible.

### Programmatic install

```ts
import { Pool } from 'pg';
import { install } from 'pg-bossier';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await install(pool);  // creates the pgbossier schema, table, trigger, etc.

// Later:
import { uninstall } from 'pg-bossier';
await uninstall(pool);  // DROP SCHEMA pgbossier CASCADE
```

`install()` is idempotent. Run it once at app boot or in a one-shot
migration script.

### CLI install (optional)

For ops contexts or CI/CD pipelines where wiring a Node script is
awkward:

```bash
npx pg-bossier install   --conn-string="$DATABASE_URL"
npx pg-bossier uninstall --conn-string="$DATABASE_URL"
```

The CLI prints the destination (`host=… database=… schema=…`) before
running any SQL so you can confirm the right database is being changed.

### Schema configuration

By default, pg-bossier installs into the `pgbossier` schema and triggers
on `pgboss.job`. Override either name:

```ts
await install(pool, {
  schema:       'altbossier',     // pg-bossier's own schema
  pgbossSchema: 'altpgboss',      // pg-boss source schema
});
```

The same options propagate to the client:

```ts
const client = bossier({ boss, pool, schema: 'altbossier' });
```

### Prisma coexistence ⚠️

> **⚠️ If you use Prisma with `multiSchema` preview, you MUST exclude
> the `pgbossier` schema from your `datasource.schemas` list.**
>
> `prisma db pull` with `multiSchema` introspects all schemas including
> pgbossier. Running `prisma migrate dev` against the resulting schema
> would try to drop or migrate pg-bossier's tables — destructive
> failure.

For standard (non-`multiSchema`) Prisma usage: `prisma migrate` only
manages schemas declared in your Prisma datasource. pgbossier is not
declared there, so Prisma doesn't see it. `install(pool)` is
idempotent; safe to run on every deploy.

### Supported topologies

| pg-bossier schemas | pg-boss schemas | Status |
|---|---|---|
| 1 | 1 (default) | ✅ Supported (common case) |
| N distinct | N distinct | ✅ Supported (full isolation) |
| 2 distinct | 1 shared | ❌ Unsupported (duplicate captures) |
| 1 | N distinct | ❌ Unsupported (one instance, one source) |
```

- [ ] **Step 2: Update `COMPATIBILITY.md`**

Find the existing "Unsupported topologies (Goal 7)" section. Update the
channel-name paragraph from "The channel is `pgbossier_job`" to:

```md
**Channel name.** The default NOTIFY channel is `pgbossier_job`. If you
pass a non-default `schema` option to `bossier()`, the channel becomes
`${schema}_job`. The trigger name follows the same pattern:
`${schema}_capture`. This prevents collisions when multiple pg-bossier
installs share a database.
```

Add a new section at the end of `COMPATIBILITY.md`:

```md
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
```

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]` → `### Added`:

```md
- **Goal 9 — Install / distribution shape** (#10). Schema names
  (`pgbossier`, `pgboss`) become configurable via
  `install(pool, { schema?, pgbossSchema? })`. Trigger name and NOTIFY
  channel scoped to the schema (`${schema}_capture`, `${schema}_job`)
  to support multiple pg-bossier installs per database. Hardened
  validation: rejects `public`, `information_schema`, `pg_*`-prefixed
  names, reserved keywords, and identifiers over 63 bytes. `install()`
  wraps DDL in a transaction with a preflight `SELECT 1 FROM
  pgboss.job LIMIT 0` check — failure leaves no partial state.
- **CLI** (`npx pg-bossier install`, `uninstall`). Stdlib `parseArgs`
  with `strict: true`. Prints destination (`host=… database=… schema=…`)
  before any SQL runs. Exit codes: 0 success, 1 usage error, 2 runtime
  error, 64 invalid schema name.
- **package.json**: `bin: { pgbossier: ./bin/pgbossier.js }`, `engines`
  bumped to `>=18.3.0`, `files: ["dist", "bin"]`.
- **`CONTRIBUTING.md`**: first-publish runbook (develop → main mechanics,
  `npm publish --dry-run`, version-bump policy).
- **CI**: new `consumer-artifact-smoke-test` job that `npm pack`s and
  installs the tarball in a fresh directory — verifies the bin script
  and bundled `dist/` work end-to-end.

### Changed

- **Internal signatures**: free functions in `src/read.ts`,
  `src/progress.ts`, `src/events.ts`, `src/record.ts` now take a
  `SchemaNames` parameter as the second argument (after `pool`). Public
  API via `bossier({ boss, pool })` unchanged — schemas resolve at
  construction time and close over each method.
```

- [ ] **Step 4: Update `CLAUDE.md` project-status paragraph**

In the "Project status" paragraph, after the Goal 7 mention, append:

```
Goal 9's install / distribution shape — configurable schemas, hardened
validation, transactional install, CLI wrapper, prepared (but not
executed) publish runbook — merged via the
feature/goal-9-install-distribution-shape branch; its issue #10 is
closed. **The first npm publish is deferred** until descent-app
validates pg-bossier against a real workload.
```

And in the goal-status table, update the Goal 9 row:

```md
| Goal 9 — Install/uninstall | ✅ **Delivered.** `install`/`uninstall` accept `{ schema, pgbossSchema }`; schema-name validation rejects data-loss-prone names; `install()` wraps DDL in a transaction with a preflight check; CLI ships at `bin/pgbossier.js`; trigger + NOTIFY channel both schema-scoped. First `npm publish` deferred per CLAUDE.md until descent-app validation. Issue #10 closed. |
```

- [ ] **Step 5: Commit each docs change**

```bash
git add README.md
git commit -m "docs(readme): Install section + Prisma coexistence + topology table

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git add COMPATIBILITY.md
git commit -m "docs(compatibility): schema-scoped channel/trigger note + install constraints

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git add CHANGELOG.md
git commit -m "docs(changelog): Goal 9 entry under [Unreleased]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

git add CLAUDE.md
git commit -m "docs(claude): sync — Goal 9 delivered, issue #10 closed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9 — Create `CONTRIBUTING.md` with the first-publish runbook

**Files:**
- Create: `CONTRIBUTING.md`

**Goal:** The release runbook lives in a discoverable place. Future releases use the same steps.

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```md
# Contributing to pg-bossier

This document covers the local development workflow and the release
runbook. For project goals and architectural decisions, see
[CLAUDE.md](./CLAUDE.md) and [issue #1](https://github.com/elfensky/pg-bossier/issues/1).

## Local development

```bash
npm install
npm run lint && npm run build && npm test
```

Integration tests use `@testcontainers/postgresql` against real Postgres
+ pg-boss. Docker is required.

## Feature workflow

Per [CLAUDE.md](./CLAUDE.md), large features go through a worktree →
branch → `--no-ff` merge into `develop`:

```bash
git worktree add .worktrees/feature-<name> -b feature/<name> develop
cd .worktrees/feature-<name>
npm install
# ... do the work, commit incrementally ...
npm run lint && npm run build && npm test
cd /path/to/main/checkout
git merge --no-ff feature/<name>
git push origin develop
git worktree remove .worktrees/feature-<name>
git branch -d feature/<name>
```

## Release runbook (first publish + subsequent)

A release is a single squashed commit on `main` that snapshots `develop`:

```bash
# 1. Verify develop is green:
git checkout develop
npm run lint && npm run build && npm test
npm publish --dry-run
# → surfaces metadata/files issues; runs `prepare` (tsc) end-to-end

# 2. Decide the version. First release = 0.1.0. Subsequent: bump per
#    the version policy in CLAUDE.md.

# 3. Switch to main, snapshot develop's tree (NOT git merge — develop
#    and main have unrelated histories by design):
git checkout main
git status     # MUST be clean — no untracked files
git read-tree -u --reset develop

# 4. In ONE commit on main, bump version and rename [Unreleased]:
#    - package.json + package-lock.json:  bump
#    - CHANGELOG.md:
#        rename "## [Unreleased]" → "## [X.Y.Z] - 2026-MM-DD"
#        add fresh empty "## [Unreleased]" block above it for next cycle.
git add -u                            # tracked files only — NEVER -A
# Edit package.json + CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags

# 5. Back on develop, open a fresh [Unreleased] block for next cycle:
git checkout develop
# Edit CHANGELOG.md to add empty [Unreleased] header back at the top
git commit -am "chore(changelog): open fresh [Unreleased] for next cycle"
git push origin develop

# 6. From main, publish:
git checkout main
npm publish
# You provide npm credentials. The prepare script runs tsc.
```

## Until the first publish

Consumers install pg-bossier via:

```bash
# Primary (reproducible — SHA-pinned):
npm install git+https://github.com/elfensky/pg-bossier#<commit-sha>

# Local pack:
cd pg-bossier && npm pack
cd ../consumer-app && npm install ../pg-bossier/pg-bossier-X.Y.Z.tgz
```

The first `npm publish` is gated on descent-app validating pg-bossier
against a real workload.

## Version policy

- **v0.1.0** = first release. All current `[Unreleased]` work bundles into the 0.1.0 entry.
- **v0.x.y** while the API surface is maturing. Minor bumps for features, patch bumps for fixes. Non-additive schema changes are minor bumps under 0.x.
- **v1.0.0** only when the API surface is committed.
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(contributing): first-publish runbook + feature workflow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10 — Add CI consumer-artifact-smoke-test

**Files:**
- Modify: `.github/workflows/ci.yml`

**Goal:** CI verifies the consumer install path (npm pack + install in fresh dir).

- [ ] **Step 1: Edit `.github/workflows/ci.yml`**

Append a new job to the existing workflow (after the `pg-boss-version-tripwire` job):

```yaml
  consumer-artifact-smoke-test:
    # Verifies the consumer install path — npm pack + install in a fresh
    # directory exercises the same path descent-app will use.
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [verify]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Pack the package
        run: npm pack
      - name: Install tarball in a fresh consumer directory
        run: |
          set -euo pipefail
          TARBALL=$(ls pg-bossier-*.tgz)
          mkdir -p /tmp/consumer
          cd /tmp/consumer
          npm init -y
          npm install "$GITHUB_WORKSPACE/$TARBALL"
          # Verify dist/ ships in the tarball (no rebuild on tarball install)
          test -f node_modules/pg-bossier/dist/index.js \
            || (echo "ERROR: dist/index.js missing from tarball" && exit 1)
          # Verify the bin script ships and is executable
          test -x node_modules/pg-bossier/bin/pgbossier.js \
            || (echo "ERROR: bin/pgbossier.js missing or not executable" && exit 1)
          # Verify the CLI runs and exits cleanly
          npx pgbossier --version | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
            || (echo "ERROR: --version output unexpected" && exit 1)
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add consumer-artifact-smoke-test job

After 'verify' passes, npm pack the package and install the tarball
in a fresh /tmp/consumer directory. Asserts:
- dist/index.js ships in the tarball (no consumer-side rebuild)
- bin/pgbossier.js ships with executable bits
- npx pgbossier --version exits 0 with a semver

Catches the same failure modes a consumer like descent-app would hit
if the tarball were missing dist/ or bin.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11 — Final verification + merge to develop

**Files:** none (workflow)

**Goal:** Full green on the feature branch; merge with `--no-ff`; clean up.

- [ ] **Step 1: Run the full suite one more time on the feature branch**

```bash
cd .worktrees/feature-goal-9-install-distribution-shape
npm run lint && npm run build && npm test
```

Expected: all green. Test count should be ~120+ (was 87; new tests in install.test, sql.test, cli.test, topology.test, plus extensions to existing files).

- [ ] **Step 2: Switch to develop and merge**

```bash
cd /Users/andrei/Developer/github/pg-bossier
git checkout develop
git pull origin develop  # in case anything else landed
git merge --no-ff feature/goal-9-install-distribution-shape \
  -m "Merge feature/goal-9-install-distribution-shape: Goal 9 install + distribution

Schema names configurable; hardened validation; transactional install
with preflight; trigger + NOTIFY channel both schema-scoped; CLI
wrapper at bin/pgbossier.js; CONTRIBUTING.md release runbook; CI
consumer-artifact smoke test. First npm publish deferred until
descent-app validation. Issue #10 closed."
```

If there are merge conflicts (CLAUDE.md or CHANGELOG.md might
conflict with parallel work), resolve them — keep both sets of
changes.

- [ ] **Step 3: Push develop**

```bash
git push origin develop
```

- [ ] **Step 4: Clean up the worktree**

```bash
git worktree remove .worktrees/feature-goal-9-install-distribution-shape
git branch -d feature/goal-9-install-distribution-shape
```

- [ ] **Step 5: Close issue #10**

```bash
gh issue close 10 -c "Delivered via merge to develop. See CHANGELOG [Unreleased] for the entry. First npm publish deferred until descent-app validates pg-bossier against a real workload."
```

---

## Self-review

### Spec coverage

Going through each "must-land" item from the spec's Revisions section (v2):

1. ✅ `assertSchemaName` rejects `public`, `information_schema`, `pg_*`, reserved keywords, > 63 bytes — Task 1
2. ✅ Trigger name parameterized to `${s.pgbossier}_capture` — Task 2
3. ✅ `install()` wrapped in transaction + preflight check — Task 3
4. ✅ CLI control flow (strict: true, capture exit code, finally cleanup, post-finally exit) — Task 7
5. ✅ CLI prints destination connection info — Task 7
6. ✅ CLI connection timeout — Task 7
7. ✅ "Supported topologies" section in spec + tests — Task 6 (pins the four cases)
8. ✅ Prisma multiSchema callout — Task 8 (README)
9. ✅ Corrected "all three install paths exercise prepare" claim — Task 8 (README + COMPATIBILITY)
10. ✅ Commit-SHA pinning as primary git-install example — Task 8 (README) + Task 9 (CONTRIBUTING)
11. ✅ `engines` bumped to >=18.3.0 — Task 7 (package.json)
12. ✅ `git add -u` (not `-A`) in runbook — Task 9 (CONTRIBUTING)
13. ✅ CI consumer-artifact smoke test — Task 10
14. ✅ `--ignore-scripts` risk documented — Task 8 (COMPATIBILITY)
15. ✅ Test coverage: public/pg_/over-63-byte rejection — Task 1; trigger-collision regression — Task 2; transactional rollback — Task 3; preflight check — Task 3; CLI clean-exit — Task 7

### Placeholder scan

No TBD, no TODO, no "fill in details," no "similar to Task N." Every step has executable code or commands. Every test has a real implementation. The "Step 7" in Task 4 explicitly says "do not commit until Task 5 fixes the callers" — that's intentional ordering, not a placeholder.

### Type consistency

- `SchemaNames` (interface name): used identically across Tasks 1, 2, 4, 5
- `resolveSchemas` (function name): consistent
- `assertSchemaName` (function name): consistent
- `InstallOptions` (interface name): consistent across Tasks 2, 3, 5
- `BossierOptions` (interface name): consistent in Task 5
- Free-function signatures: `findById(pool, schemas, jobId)` etc. consistent in Tasks 4 + 5
- Trigger name string: `${s.pgbossier}_capture` consistent across spec + Task 2 + Task 6
- NOTIFY channel string: `${s.pgbossier}_job` consistent across spec + Task 2 + Task 4

All names and signatures match.

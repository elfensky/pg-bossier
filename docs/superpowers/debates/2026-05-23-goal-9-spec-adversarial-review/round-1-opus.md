# Opus critique — Round 1

I co-authored this spec. I'm holding myself to the same bar I held Goal 7
to: every load-bearing claim gets challenged, every concrete failure mode
gets surfaced, and "I helped write this" is not a reason to be gentle.

## 1. SQL parameterization + schema-name validation

The regex `^[a-z_][a-z0-9_]*$` is presented as "Postgres
unquoted-identifier-rules-equivalent." It's not — and worse, the gap is in
the direction of *under-validation*, not over-validation. Three concrete
problems:

- **`pg_` prefix is not blocked.** Postgres reserves identifiers starting with `pg_` for the system catalog (see Postgres docs: "The system catalog schemas, pg_catalog, pg_temp, and pg_toast, are always implicitly searched ... pg_ is reserved for system use"). A consumer passing `schema: 'pg_audit'` slips through our regex but Postgres rejects `CREATE SCHEMA pg_audit` with a permission error or worse, succeeds and silently shadows a system object. **Add `&& !name.startsWith('pg_')` to `assertSchemaName`.**
- **No length check.** Postgres `NAMEDATALEN` is 63 chars by default. A 64+ char schema name passes the regex but Postgres silently truncates it to 63 chars — and now the consumer's "install at schema X" doesn't match what's actually in the database. **Add `name.length <= 63`** (or technically `<= NAMEDATALEN - 1`; 63 is the universal default).
- **Reserved SQL keywords slip through.** The regex accepts `user`, `select`, `from`, `table`, `index`, etc. These are valid as schema names only when **quoted** in SQL (`CREATE SCHEMA "user"`). Our SQL uses bare interpolation: `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier};` becomes `CREATE SCHEMA IF NOT EXISTS user;` — **syntax error**. Two fixes possible:
  - **Quote all identifiers** in generated SQL: `CREATE SCHEMA IF NOT EXISTS "${s.pgbossier}";`. Safest, but the spec's example SQL throughout would all need quoting. Schema names with `"` in them aren't allowed by our regex anyway, so no escaping needed.
  - **Block reserved-keyword names** in `assertSchemaName` via a small list. Brittle (the keyword list evolves), but keeps the SQL clean.
  - **Recommendation:** quote identifiers in SQL. It's defensive without adding maintenance burden.

The spec's current claim — "Anything else [is] rejected with a clear Error before any SQL string gets built — so no SQL injection vector ever reaches a query" — is true for the *injection* threat. But correctness against valid-but-broken names is a separate concern the spec hasn't addressed.

## 2. NOTIFY channel correctness fix — and the bigger bug it hides

The `${schema}_job` change is right. But **the trigger name `pgbossier_capture` is still hardcoded** in `captureTriggerSql`:

```sql
DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job;
CREATE TRIGGER pgbossier_capture
  AFTER INSERT OR UPDATE OF state ON pgboss.job
  FOR EACH ROW EXECUTE FUNCTION pgbossier.capture();
```

Two pg-bossier installs in **different** `schema` values but the **same** `pgbossSchema` (the common case — both watch the same pg-boss queue) collide on the trigger name. Install B's `CREATE TRIGGER` succeeds after the `DROP TRIGGER IF EXISTS` clobbers install A's trigger. **Install A silently stops capturing.**

The function it references (`${s.pgbossier}.capture()`) is already schema-scoped, so the *capture logic* would point to the wrong audit table — but it doesn't even get there because the trigger gets clobbered first.

**Fix:** the trigger name must be schema-scoped too. Something like `${s.pgbossier}_capture` (matches the existing `${s.pgbossier}_job` channel naming convention). Both installs then have distinct triggers on the shared `pgboss.job` table; both fire on every transition; each writes to its own audit table.

This is the single most important bug in the spec.

## 3. Cross-version upgrade policy — destructive-change cliff

The policy is honest about its limits. One refinement: the spec says "manual upgrade SQL in CHANGELOG" but doesn't say *how* the consumer runs it. Three plausible answers:

- Copy-paste from CHANGELOG into `psql`. Brittle; fingerprint mismatches if CHANGELOG is edited.
- Ship a `migrate(pool, fromVersion)` helper alongside `install` when a destructive change lands. Adds a new public surface; speculative until needed.
- Add a documented `bin/pgbossier migrate --from=0.1.0 --to=0.2.0` subcommand. Same idea, CLI version.

For v1, the documentation is sufficient — we don't have a destructive change pending. But the spec should add one sentence: "When a future Goal needs a destructive schema change, that Goal's spec will introduce its own one-off migration helper alongside the version bump." That sets the precedent without committing to specific machinery.

## 4. CLI design — three real corner cases

- **Windows.** `bin/pgbossier.js` with a `#!/usr/bin/env node` shebang doesn't work on Windows directly. npm handles this by writing a `pgbossier.cmd` shim during install (the `bin` field tells npm to do this automatically). So `npx pg-bossier install` *works* on Windows — but our CI doesn't exercise it. **Add a sentence to COMPATIBILITY.md** acknowledging Windows works via npm's automatic .cmd shim, and that CI runs ubuntu-only.
- **`DATABASE_URL` as fallback is risky.** Heroku, Railway, Vercel, and many other platforms set `DATABASE_URL` to the consumer's *application's primary* database. A consumer running `pgbossier install` in their app's deploy script could accidentally install pg-bossier into the wrong DB if their environment has `DATABASE_URL` set differently from what they expect. **Mitigation:** keep `DATABASE_URL` as the last fallback (after `PGBOSSIER_CONN_STRING`) but **print the resolved destination** before any SQL runs:
  ```
  pgbossier: installing into host=db.prod.example.com:5432 database=app
              schema=pgbossier pgbossSchema=pgboss
  ```
  The consumer sees the destination; if it's wrong, Ctrl-C before damage. This is one line in the bin script and a real safety net.
- **`util.parseArgs` is stable since 18.3, not 18.0.** The spec says "we already require Node 18+." Verify the floor — if package.json has `"engines": { "node": ">=18" }` that's nominally below 18.3. Either bump engines floor to `>=18.3.0` (low cost, descent-app probably on Node 20+ anyway) or vendor a tiny argv parser (more code, less footgun). **Recommendation:** bump engines to `>=18.3.0` since `util.parseArgs` is the only Node-version-sensitive piece.

## 5. Pre-publish consumption — verify two npm specifics

The spec claims `npm install git+https://github.com/...#develop` works because of `prepare: "npm run build"`. Two things to verify (citing the actual npm docs in the spec):

- **`prepare` lifecycle on git installs:** npm 7+ runs `prepare` on git installs by default. Confirmed in npm docs (`scripts.prepare` runs ON LOCAL `npm install` without arguments AND on git installs). Cite it in the spec so a future reader doesn't doubt.
- **`npm pack` semantics:** `prepare` runs at pack time (so the tarball includes built `dist/`); `prepack` and `postpack` run around it; **`prepare` does NOT run again on tarball install**. This is the *correct* behavior (consumers don't re-run `tsc`) but worth stating. Without this, a reader might worry about repeated builds.

Also: **lockfile semantics for git URLs**. A consumer doing `npm install git+...#develop` gets a lockfile entry pinned to the resolved commit SHA at install time. Subsequent `npm install` reinstalls the same SHA. To pick up develop's updates the consumer either bumps the URL or runs `npm update pg-bossier`. **The spec should mention this** so descent-app knows how to refresh.

## 6. Publish runbook — `git read-tree -u --reset develop` is right but understate

The command is correct. It updates index + working tree to match develop's tree, including deletions. Two clarifications:

- **The result has `develop`'s tree but `main`'s parent in `git log`.** That's intentional ("main and develop have unrelated histories by design") but worth restating *next to* the command so the next reader doesn't think it's a bug.
- **Tag push triggering CI**: the runbook pushes `v0.1.0` to origin. CI in `.github/workflows/ci.yml` runs on push to `main` AND on push of tags. Confirm what runs and what doesn't — if CI's `npm test` runs on tag push, it takes ~3 min (testcontainers); that's fine. If there's an auto-publish workflow on tag push (there isn't yet, but Goal 9 might add one in a future iteration), that's a footgun.

## 7. Schema mismatch failure mode — and the missing transaction

Consumer passes `pgbossSchema: 'wrong'`. Walk through what happens in order:

1. `CREATE SCHEMA IF NOT EXISTS pgbossier` ✓
2. `CREATE SEQUENCE pgbossier.record_seq` ✓
3. `CREATE TABLE pgbossier.record (...)` ✓
4. ... (all the indexes, columns, function) ✓
5. `CREATE TRIGGER pgbossier_capture ... ON wrong.job` ✗ — "relation `wrong.job` does not exist"

Postgres rolls back **just statement 5**. Statements 1-4's effects (schema, sequence, table, indexes, function) **persist**. The consumer is left with a half-installed pg-bossier: schema and audit table exist but no trigger means no events get captured.

**`uninstall()` would clean this up** (`DROP SCHEMA pgbossier CASCADE` removes everything). But the consumer probably won't know to run uninstall — they'll see the error, fix the typo, and re-run install. Re-running works because every statement is idempotent. So functionally, the failure mode is recoverable.

**Bigger improvement:** wrap `install()` in a transaction. Postgres supports DDL in transactions (unlike MySQL). One `BEGIN; ... ROLLBACK` around the whole install means **failure leaves nothing behind**. The change is two lines:

```ts
export async function install(pool: Pool, options?: InstallOptions): Promise<void> {
  const s = resolveSchemas({ ... });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(schemaSql(s));
    // ... all the other SQL ...
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

This is a real improvement, not a stylistic preference. The spec should adopt it.

## 8. `uninstall()` cascade — symmetric removal holds (with trigger-name fix)

With Vector 2's fix (trigger name = `${s.pgbossier}_capture`), `DROP SCHEMA pgbossier CASCADE` removes:

- the schema ✓
- the table (cascades from schema) ✓
- the sequence (cascades from schema) ✓
- the indexes (cascade from table) ✓
- the trigger function (cascades from schema) ✓
- the trigger ON `pgboss.job` (cascades from the function it references) ✓

The NOTIFY channel `${s.pgbossier}_job` is not a schema-owned object — it's a transient name used by `LISTEN`/`NOTIFY`. Nothing to clean up channel-side. If another pg-bossier instance was LISTENing on the (now-stale) channel name, it just stops getting events; no error, no leak.

Without Vector 2's fix, uninstall is correct **for itself** but the trigger-name collision means install B's `uninstall()` would drop install A's trigger too. Yet another reason to fix the trigger name.

## 9. Prisma coexistence — the destructive failure mode the spec underplays

The spec says "Prisma's `prisma migrate` only manages schemas declared in your `schema.prisma`." Correct as stated, but it understates one real scenario:

A consumer runs `prisma db pull` (introspect) for any reason — pulling existing schema in, debugging, refactoring. Prisma db pull introspects **every schema** in the database. pg-bossier's tables get added to the consumer's `schema.prisma`. The consumer might not notice. **Then they run `prisma migrate dev` — and if the generated schema.prisma was edited (intentionally or not), Prisma may try to drop or alter pg-bossier's tables.**

The README's coexistence note needs to be more emphatic:

> ⚠️ If you run `prisma db pull`, the resulting `schema.prisma` includes
> pg-bossier's tables. Remove them from `schema.prisma` before running
> `prisma migrate dev` — otherwise Prisma will try to drop or migrate
> pg-bossier's tables and break the audit log.

This is a "documentation contract" that needs warning-level emphasis, not just a paragraph in a config note.

## 10. Tests — three gaps in the test plan

- **Existing 87 tests under schema config.** Every existing test calls `install(h.pool)` and `bossier({ boss, pool })`. After the API change, all of these become `install(h.pool)` (uses defaults) — no break expected, but worth one explicit "smoke test all the existing tests against default schemas" CI gate. The current `npm test` already does this; just make it part of the Goal 9 acceptance.
- **`pool.end()` cleanup in bin script.** The CLI script uses `try { ... } finally { await pool.end(); }`. Test that the script exits cleanly (no hung connections, process exits within ~500ms after the last operation) under both success and failure. Easy to forget; the consequence is the CLI hanging in CI/CD pipelines.
- **Reserved-keyword and `pg_`-prefix names.** Once Vector 1's fixes land, add unit tests for: `assertSchemaName('user', 'pgbossier')` throws, `assertSchemaName('pg_audit', 'pgbossier')` throws, `assertSchemaName('a'.repeat(64), 'pgbossier')` throws.

## 11. Issue #1 charter — no violations found

Walked through:
- Non-goals: CLI is established library territory (pg-boss itself ships `boss install`); not UI, not REST, not a fork. ✓
- Constraints: install/uninstall are not audit-write path; fail-open doesn't apply. Per-event budget unaffected. API-shape principle preserved (new pg-bossier methods, not pg-boss overloads). ✓
- Forbidden tier: no `pg-boss/src/*` imports added. ✓
- KISS: schema configurability is bounded scope (~7 files); CLI is ~70 lines stdlib-only. Both pay for themselves. ✓
- Symmetric uninstall: holds **once Vector 2 is fixed**. Without that fix, the trigger-name collision is a symmetric-uninstall violation — uninstall of B removes A's trigger.

No quiet violations. The trigger-name collision is the only thing that touches a load-bearing constraint, and Vector 2's fix addresses it.

## 12. Missing from v1 — five concrete additions

1. **Trigger name parameterized to `${s.pgbossier}_capture`** (Vector 2). Critical.
2. **Schema-name validation hardened**: `pg_` prefix rejected, length ≤ 63, identifiers quoted in SQL (or reserved-keyword list) (Vector 1).
3. **`install()` wrapped in a transaction** (Vector 7).
4. **CLI prints destination before installing** (`host:port/db schema=...`) (Vector 4).
5. **README Prisma warning escalated** to a callout box (Vector 9).

## Verdict

**SHIP WITH NAMED CHANGES.**

### Must land before merge

- **CHANGE: Parameterize trigger name to `${s.pgbossier}_capture`** in `captureTriggerSql`. Without this, two installs with different `schema` values collide on the trigger and install A is silently destroyed by install B.
- **CHANGE: Quote schema identifiers in generated SQL** (`"${s.pgbossier}"` not `${s.pgbossier}`). Or add a reserved-keyword block list. Quoting is simpler.
- **CHANGE: Reject `pg_` prefix and identifiers > 63 chars in `assertSchemaName`.** Postgres reserves `pg_` for system use; NAMEDATALEN is 63.
- **CHANGE: Wrap `install()` in a transaction.** Postgres supports DDL transactions; a mid-install failure should leave zero traces.
- **CHANGE: CLI prints destination connection info** (`host:port/database schema=... pgbossSchema=...`) before any SQL runs. Safety net against `DATABASE_URL` pointing somewhere unexpected.

### Should land in v1 (doesn't block)

- **CHANGE: Bump `engines` to `>=18.3.0`** so `util.parseArgs` is unambiguously available.
- **CHANGE: README "Prisma coexistence" gets a warning callout** about `prisma db pull` introspecting all schemas. Not a paragraph — a ⚠️-prefixed warning.
- **CHANGE: Spec adds a sentence on lockfile semantics** for git-URL installs (commit SHA pinning, `npm update` to refresh).
- **CHANGE: Spec adds a sentence on `prepare` behavior** across `npm install` from git vs. from tarball.
- **CHANGE: Test coverage adds `pool.end()` cleanup verification** and the new reserved/length/pg_ unit tests.

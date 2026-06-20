# Sonnet critique — Round 1

---

## Vector 1 — SQL parameterization + schema-name validation

The spec claims the regex `^[a-z_][a-z0-9_]*$` "matches Postgres unquoted-identifier rules" (Risks table, spec line 570). This is incorrect on three counts.

**`pg_` prefix is reserved.** Postgres rejects `CREATE SCHEMA pg_foo` with "unacceptable schema name: The prefix 'pg_' is reserved for system schemas." The regex allows `pg_catalog`, `pg_temp`, `pg_bossier_alt`, etc. These all pass `assertSchemaName` and then fail at the SQL layer — but not before `CREATE SCHEMA IF NOT EXISTS` may have partially executed.

**`public` and `information_schema` are allowed.** `assertSchemaName('public')` passes. If a consumer calls `uninstall(pool, { schema: 'public' })`, the spec produces `DROP SCHEMA IF EXISTS public CASCADE` — which destroys every user table in the public schema. This is a data-loss risk sitting behind "clear `Error` before any SQL builds" that the spec never builds.

**No length check.** NAMEDATALEN in standard Postgres is 63 bytes. The regex imposes no upper bound. A 70-character schema name passes validation, gets embedded into the SQL template literal at full length, then Postgres silently truncates it to 63 characters. The truncation is consistent (references are also truncated), so it does not corrupt data, but the `assertSchemaName` guarantee — "invalid names rejected with a clear Error before any SQL builds" — is false: a name that does not exist as intended goes through silently.

The `pg_` prefix and `public` risks are concrete, not hypothetical. Both require one additional line in `assertSchemaName`. The length check requires one more. None of these are architecture changes.

---

## Vector 2 — NOTIFY channel correctness fix (`${schema}_job`)

The spec correctly identifies the NOTIFY channel rename as a correctness fix for cross-pollination. But it misses the harder cross-pollination: the **trigger name**.

The current `CAPTURE_TRIGGER_SQL` contains `DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job`. The spec describes `captureTriggerSql` as a factory function (the "same factory shape" note under the SQL example) but never shows its body and never states that the trigger name must be scoped to the pgbossier schema.

If the implementation writes the trigger as `pgbossier_capture` regardless of the schema option:

- Install A: `pgbossier_capture` on `pgboss.job` (calls `pgbossier.capture()`)
- Install B on `altbossier`: `DROP TRIGGER IF EXISTS pgbossier_capture ON pgboss.job` silently drops Install A's trigger, then creates its own `pgbossier_capture` (calling `altbossier.capture()`)

After Install B, Install A's audit writes stop. The NOTIFY channel fix is irrelevant — the trigger for Install A is gone. The spec is silent on this. The trigger name must become `${s.pgbossier}_capture` in the factory, and the spec should state this explicitly.

**Regarding the shared `pgboss` schema scenario:** two installs on different `pgbossier` schemas but the same `pgboss` schema will BOTH fire on every `pgboss.job` change. That is duplication, not isolation. The spec's claim of "isolated" behavior between two instances sharing a `pgboss` schema is only true for NOTIFY channels — audit-row writes are not isolated. The spec does not acknowledge this.

---

## Vector 3 — Cross-version upgrade policy — destructive-change cliff

The policy is sound for Goals 3 and 4 (adding columns). Goal 2 is the danger.

Goal 2 mandates `class: 'transient' | 'non_retryable'` on `failed` records and specifies a discriminated-union shape for `terminal_detail`. If the implementation of Goal 2 needs to enforce a NOT NULL constraint on `terminal_detail->>'class'` for `failed` rows (a check constraint), that is a non-additive change to the table. `ALTER TABLE … ADD CONSTRAINT` on a table with existing rows either requires a table scan (acceptable) or a deferred/invalid constraint — neither is idempotent in the `ADD COLUMN IF NOT EXISTS` sense.

More concretely: `CREATE OR REPLACE FUNCTION` handles trigger logic changes cleanly. But if Goal 2 changes `terminal_detail`'s expected shape, existing `pgbossier.record` rows captured before the upgrade carry the old shape. The upgrade policy says nothing about what happens to pre-upgrade rows when Goal 2 reads them. The typed read that "answers why did this fail" would see mixed-shape JSONB.

The spec's manual-upgrade-SQL-in-CHANGELOG approach has no harness: it says "manual SQL in CHANGELOG" but the spec for how consumers run that SQL is not documented. There is no migration runner, no version table, no "schema is older than client" detection (explicitly excluded). A consumer who skips a CHANGELOG entry silently runs mismatched code against an old schema.

This is a known accepted risk, not a blocker. But the spec does not acknowledge the Goal 2 incompatibility specifically.

---

## Vector 4 — CLI design — `util.parseArgs` adequacy

**`strict: false` silently swallows flag typos.** The spec's CLI sketch uses `strict: false`. Tested: `parseArgs({ strict: false, args: ['install', '--connn-string=postgres://...'] })` produces `values['connn-string'] = 'postgres://...'` and `values['conn-string'] = undefined`. The code then falls through to `PGBOSSIER_CONN_STRING → DATABASE_URL`. If neither env var is set, the user gets "no connection string" — but the cause (typo) is not surfaced. `strict: true` with `allowPositionals: true` (also tested) works correctly and throws a clear error for unknown flags. The spec uses `strict: false` without stated rationale; `strict: true` is the right default.

**Connection string with embedded `=` signs parses correctly.** Tested: `--conn-string=postgres://user:pass@host:5432/db?ssl=true&sslmode=require` parses correctly under `parseArgs`. This concern from the attack vector is not a real problem.

**`DATABASE_URL` fallback.** For descent-app (the v1 consumer), `DATABASE_URL` IS the right database, so the fallback is correct. The risk of a consumer having `DATABASE_URL` pointing to a different database than their pg-boss install is real in multi-database setups, but the spec's primary consumer does not have this topology. Risk is low; warning in docs is sufficient.

**Windows and `npm run` forwarding.** npm creates `.cmd` shims for bin entries on Windows automatically. `npx pg-bossier install` works on Windows. `npm run -- --conn-string=...` argument forwarding is a shell behavior the CLI doesn't control; documenting `npx pg-bossier` as the canonical invocation sidesteps this.

---

## Vector 5 — Pre-publish consumption (git URL / `npm pack`)

**`prepare` runs on git installs since npm 7.** The spec correctly relies on this. npm 9 (which ships with Node 22, the CI target) does run `prepare` on git installs by default. The only exception is `--ignore-scripts`, which some CI environments set. The spec does not mention this. It is an uncommon edge case, but a consumer who runs `npm ci --ignore-scripts` would get an un-built package.

**Lockfile semantics for git URL installs.** `npm install git+https://...#develop` captures the branch name, not the resolved commit SHA, in `package-lock.json` when using a branch ref. Subsequent `npm ci` on the same lockfile will re-resolve the branch head, which may have advanced. The spec shows `#68fd7bb` (a specific commit SHA) as an alternative and notes "for a specific commit" — this is the reproducible form. The branch URL form in the primary example is non-reproducible. The spec should make the SHA form primary for descent-app's validation phase.

**`prepare` vs `prepack`/`postinstall`.** The spec's claim that all three install paths (git URL, `npm pack`, registry) exercise `prepare` is mostly correct. `prepare` runs for git installs and local development. For registry tarball installs, `prepare` does NOT run — the pre-built `dist/` from the tarball is used. This is the intended behavior and the spec has it right.

**`npm pack` executable bits.** npm preserves executable bits for `bin` entries; the spec's note on this is accurate.

---

## Vector 6 — Publish runbook — `git read-tree -u --reset develop`

**The command is correct for this repository.** Verified: `main` and `develop` share no common ancestor (`git merge-base` returns nothing). `git read-tree -u --reset develop` reads develop's tree into the index and updates the working tree, including handling deletions of files that exist on `main` but not on `develop`. This is the right command for snapshotting an unrelated-history branch.

**`git add -A` in step 4.** After `read-tree`, the spec says `git add -A && git commit`. `git add -A` stages all changes AND all untracked files. If the developer has any untracked files in the main checkout at release time (e.g., a scratch file, a local `.env`), they get committed to `main`. This is a minor hygiene risk; `git add -u` (updates tracked files only) is safer after `read-tree`.

**CI trigger on tag push.** The CI workflow triggers on `push` to `develop` or `main` branches and on `pull_request` — not on tags. `git push origin main --follow-tags` pushes the commit (triggers CI on main) and the tag (triggers nothing extra). Safe.

---

## Vector 7 — Schema mismatch failure mode

**Install order and partial state.** The `install()` function runs sequential `await pool.query()` calls with no transaction wrapper. With `pgbossSchema: 'wrong'`, execution succeeds through `captureFunctionSql(s)` (which creates the schema, sequence, table, indexes, and function in the `pgbossier` schema) and then fails at `captureTriggerSql(s)` with "relation `wrong.job` does not exist". Result: `pgbossier` schema exists with its table, indexes, and function — but no trigger and no backfill.

This is partially installed state. The spec says "fail-loud, not silent," which is accurate. The recovery path is: re-run `install()` with correct `pgbossSchema`, or call `uninstall()` then re-install. Both work because `install()` is idempotent and `uninstall(pool)` drops the entire `pgbossier` schema. The spec acknowledges this implicitly through idempotency but doesn't explicitly document the recovery path.

A transaction wrapper would atomize the install — either everything succeeds or nothing is created. This would simplify the failure story. The spec does not discuss this tradeoff. Given KISS, the current "re-run is safe" answer is acceptable, but the spec should explicitly document it.

---

## Vector 8 — `uninstall()` cascade — true symmetric removal

**NOTIFY channels are not schema-owned objects.** `pg_notify` channels are ephemeral — they do not appear in `pg_class`, `pg_namespace`, or any persistent catalog. `DROP SCHEMA pgbossier CASCADE` does not need to "reach" them because there is nothing to drop. An active `LISTEN pgbossier_job` connection after uninstall simply receives no further notifications. The attack vector's concern about NOTIFY channel cascade is based on a misconception about Postgres internals.

**Trigger cascade via function dependency.** The trigger on `pgboss.job` depends on `pgbossier.capture()`. Postgres tracks this via `pg_depend`. `DROP SCHEMA pgbossier CASCADE` drops the function, which cascades to the trigger. This is confirmed by the existing `uninstall.test.ts`. The cascade works even when `pgbossSchema` is non-default (the trigger lives on `altpgboss.job` but depends on the function in `pgbossier`).

**Enumeration of pg-bossier-owned objects.** Schema, sequence, table, all indexes (cascaded from table), trigger function, trigger on `pgboss.job` (cascaded from function). The spec's list is complete. There are no pg-bossier objects outside the `pgbossier` schema.

---

## Vector 9 — Prisma coexistence — the documentation contract

**The spec's core claim is wrong.** The spec states: "Prisma's `prisma migrate` and `prisma db pull` only manage schemas declared in the consumer's `schema.prisma`." This was true before `multiSchema` preview. With `multiSchema` enabled (available since Prisma 4.3, increasingly used), `prisma db pull` introspects all schemas in the database by default — including `pgbossier`. Running `prisma db pull` with `multiSchema` active on a database with pg-bossier installed will add `pgbossier` tables to the consumer's `schema.prisma` unless explicitly excluded.

The spec acknowledges `multiSchema` in the risks table ("Consumer with `multiSchema` enabled in Prisma adds `pgbossier` to their schema") but its mitigation is "README warns explicitly." The documentation section itself does not include the warning — it says only "should not add `pgbossier` to their declared schemas." The warning about `prisma db pull` pulling the schema in automatically (without the consumer "adding" it) is absent.

`prisma migrate diff` drift: if `pgbossier` is introspected and the consumer runs `prisma migrate dev`, Prisma will attempt to manage the `pgbossier` schema through migrations. This would conflict catastrophically with `install()`'s idempotent migration story. The spec's documentation contract must explicitly state: if `multiSchema` is enabled, add `pgbossier` to the excluded schemas in your Prisma config.

---

## Vector 10 — Tests — sufficient coverage?

**Existing 87 tests under schema config change.** Every test file that references the `pgbossier` schema by literal string (e.g., `install.test.ts` line 12: `WHERE table_schema = 'pgbossier'`) will still pass because the default schema name is unchanged. The tests won't break — but they also won't exercise the schema-configurable path. The spec's test plan adds `test/install.test.ts` extensions for non-default schemas; this is the right approach.

**`prepare` script on git install CI check.** The spec says "we just verify it explicitly in CI" but the test plan doesn't describe how. The existing CI workflow runs `npm ci` (which does NOT run `prepare` — it uses the lockfile and skips lifecycle scripts for efficiency in CI). A separate CI step that does `npm install git+https://...#develop` in a fresh directory would verify the git-install path. The spec doesn't add this step.

**`pool.end()` hang in CLI.** If the database connection is refused (connection refused, wrong port), `new Pool(...)` succeeds but `await pool.query(...)` throws. The `finally` block then calls `await pool.end()`. With `node-postgres`, `pool.end()` resolves immediately if no clients are checked out. This should not hang. Risk is low.

**`--version` output after release bump.** The `--version` flag reads `package.json` at runtime using `readFileSync`. After a release bump on `main`, the version would be correct. This is fine. However: during descent-app validation from a git URL (where version is `0.0.0`), `--version` prints `0.0.0`. The spec doesn't mention this is expected behavior.

---

## Vector 11 — Issue #1 charter — does this design quietly violate anything?

**CLI is within charter.** The "no UI / no HTTP/REST layer" non-goals target a dashboard and an HTTP API, not a CLI migration tool. The `~1-hour adoption` promise (Goal 9's own mandate) implies tooling to run the install without writing a Node script. The CLI does not violate any non-goal.

**Schema configurability and KISS.** The spec notes "~7 source files touched" and acknowledges the cost is "bounded and one-time." The configurability is justified by two concrete needs: multi-instance support and issue #16's schema-per-test isolation. It's not hypothetical. KISS is not violated.

**`strict: false` in `parseArgs`.** This is the clearest KISS violation in the spec — it silently swallows typos and requires no justification for the more permissive mode. `strict: true` is simpler and more correct.

**Trigger name not schema-scoped in the spec.** This is a silent design gap, not a charter violation.

---

## Vector 12 — Missing from v1 entirely

**Trigger name must be schema-scoped — and the spec doesn't say so.** The multi-instance support claim (two installs in different schemas on the same database) will break at the trigger layer if the implementation uses a fixed trigger name. The spec shows `captureTriggerSql` as a factory but does not specify that `DROP TRIGGER IF EXISTS pgbossier_capture` becomes `DROP TRIGGER IF EXISTS ${s.pgbossier}_capture`. An implementation that follows the spec literally (factory function, schema names interpolated) could produce the right trigger name or the wrong one — the spec is ambiguous.

**No documented exclusion for Prisma `db pull`.** The Prisma coexistence section tells consumers not to add `pgbossier` to their schema; it doesn't tell them that `prisma db pull` with `multiSchema` will add it for them. The mitigation belongs in the spec's documentation section, not just the risks table.

**No connection timeout in the CLI.** `new Pool({ connectionString })` with a wrong host will wait indefinitely for TCP until the OS timeout fires (up to several minutes). The CLI has no `connect_timeout` in the connection string or `connectionTimeoutMillis` in the Pool config. A one-line addition (`new Pool({ connectionString, connectionTimeoutMillis: 10_000 })`) would prevent the CLI from hanging on bad credentials.

**`--ignore-scripts` risk for git installs.** CI environments that set `--ignore-scripts` (some security-conscious environments, some Docker-based builds) will get an un-built package from git URL installs. The spec's verification step in CI doesn't exercise this path.

---

## Verdict

**SHIP WITH NAMED CHANGES**

CHANGE: Block `pg_*` prefix and `public` (and optionally `information_schema`) in `assertSchemaName` — the regex as specified allows schema names that either Postgres will reject (pg_*) or that make `uninstall()` catastrophic (public). One additional conditional in `assertSchemaName` fixes both.

CHANGE: Add `{max: 63}` length check to `assertSchemaName` — Postgres silently truncates identifiers longer than 63 bytes; validation should surface this explicitly rather than letting it silently pass.

CHANGE: Change `strict: false` to `strict: true` in the `parseArgs` call — typos in flag names silently fall through to env var fallbacks; `strict: true` is correct behavior and `allowPositionals: true` is compatible with it (verified).

CHANGE: Explicitly specify that `captureTriggerSql` produces a schema-scoped trigger name (`${s.pgbossier}_capture`) — the multi-instance support claim depends on this, but the spec leaves it implicit. An implementation could name the trigger `pgbossier_capture` regardless of schema option and silently break the first install on every subsequent install.

CHANGE: Update the Prisma coexistence documentation section to explicitly state that `prisma db pull` with `multiSchema` enabled will introspect and import `pgbossier` tables — the current text only warns against manually adding the schema, not against automatic introspection.

CHANGE: Make the git-URL form in the first-publish runbook use a specific commit SHA as the primary example, not a branch ref — branch refs in `package-lock.json` are non-reproducible.

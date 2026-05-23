# Opus critique — Round 2

After reading the other three Round 1s alongside my own, the convergence is
sharp: **all four of us independently caught the trigger-name collision and
the schema-validation gaps**, and Codex + Sonnet each surfaced material
bugs I missed. I'm conceding heavily.

## Concessions

**To Sonnet — `schema: 'public'` makes `uninstall()` a catastrophic
data-loss command.** Sonnet (vector 1): "If a consumer calls
`uninstall(pool, { schema: 'public' })`, the spec produces
`DROP SCHEMA IF EXISTS public CASCADE` — which destroys every user table in
the public schema." This is the single most important catch in the entire
review. I flagged `pg_` prefix as the system-reserved gap but missed that
`public` is the *user-data* gap — and the consequences are far worse than
a Postgres rejection. The regex needs an explicit block list. The fix is
one line, the risk is irrecoverable data loss.

**To Codex — the multi-instance topology is broken in a more fundamental
way than the trigger name.** Codex (vector 2): "even if trigger names
become unique, both triggers would then fire on the same source table and
duplicate capture into multiple audit schemas; backfill has the same
duplication issue. The spec needs an explicit topology contract: either
`1 pgbossier schema : 1 pgboss schema`, or a real multi-writer design."
I had the trigger-name fix but missed that the framing of
"schema configurability unblocks multi-instance" is overreach. Two pg-bossier
installs sharing one `pgboss` schema means *both* fire on every pg-boss
op — that's duplication, not isolation. The honest scope for v1 is:
"configurable schemas enable multiple pg-bossier installs per database,
**provided each install has its own `pgboss` schema**." The spec needs to
state this explicitly, not implicitly.

**To Codex — the CLI sketch's `process.exit()` runs before `pool.end()`.**
Codex (vector 4): "lines 355-365 call `process.exit(...)` before
`finally { await pool.end() }`, which means cleanup never runs." I noted
"cleanup test" as a gap but missed the actual bug in the sketch itself.
`process.exit()` is synchronous and immediate; the `finally` block in the
spec's sketch never executes. The fix is to capture an exit code in a
variable, await `pool.end()` in `finally`, then `process.exit(code)` *after*
the `finally` returns. Spec's control flow is wrong.

**To Sonnet — `strict: false` in `parseArgs` silently swallows flag
typos.** Sonnet (vector 4): "`parseArgs({ strict: false, args: ['install',
'--connn-string=postgres://...'] })` produces
`values['connn-string'] = 'postgres://...'` and
`values['conn-string'] = undefined`. The code then falls through to
`PGBOSSIER_CONN_STRING → DATABASE_URL`." This is a real bug in the spec's
CLI sketch. `strict: true` (with `allowPositionals: true`) is the correct
default and gives a clear error on unknown flags. Concede.

**To Codex + Sonnet — the spec's "all three install paths exercise
`prepare`" claim is wrong.** Codex (vector 5): "installing the tarball
just unpacks the built artifacts." Sonnet (vector 5): "For registry
tarball installs, `prepare` does NOT run." I had this *almost* right in
Round 1 but didn't go back and check the spec text — line 525 of the spec
says "All three install paths exercise the existing `prepare:
\"npm run build\"` hook." That's wrong; tarball install does not re-run
`prepare`. The spec needs correction.

**To Codex — missing preflight check for `${pgbossSchema}.job`
existence.** Codex (vector 12): "a preflight check that the target
`${pgbossSchema}.job` exists and is the table you expect before mutating
anything." Yes — currently `install()` creates the `pgbossier` schema and
~9 SQL objects before failing on the trigger creation. A preflight `SELECT
1 FROM ${pgbossSchema}.job LIMIT 0` (which fails fast if the table doesn't
exist) would surface the error *before* any mutation. Concede; this pairs
naturally with the transaction wrapper.

**To Sonnet — branch refs in `npm install` are non-reproducible.** Sonnet
(vector 5): "`npm install git+https://...#develop` captures the branch
name, not the resolved commit SHA, in `package-lock.json` when using a
branch ref. Subsequent `npm ci` on the same lockfile will re-resolve the
branch head, which may have advanced." Correct. The spec's primary
git-install example uses `#develop` and shows the `#68fd7bb` form as
"alternative for a specific commit." That's backwards for descent-app's
validation phase — SHA pinning should be the primary, branch should be
secondary or explicitly tagged "for development tracking only."

**To Sonnet — `--ignore-scripts` blind spot.** Sonnet (vector 5): "a
consumer who runs `npm ci --ignore-scripts` would get an un-built
package." Real edge case; documented mitigation (note in COMPATIBILITY).

## Rebuttals

**To Gemini — `git read-tree -u --reset develop` is "violently
destructive" to `main` history.** Gemini (vector 6): "If a user makes a
hotfix on main or updates a README there, it is wiped without a trace on
the next release. This approach also makes `git bisect` across releases
painful." This overstates the concern given the project's stated design.
CLAUDE.md is explicit: "`main` only ever receives release commits and
hotfixes" and "main and develop have unrelated histories by design — a
real merge would conflict; the release takes develop's tree wholesale."
The destructive snapshot IS the intended behavior. Hotfixes flow as a
separate process (per CLAUDE.md: "Hotfixes: branch from `main`, fix, land
on `main` as a patch release commit, then port the fix to develop"). The
critique is true if you import a different release model; it isn't true
against the model this project chose. Not a blocker.

**To Codex — "the spec quietly turns 'custom schema names' into
'multi-instance support' without a sound ownership model" → frame as
**design ambiguity**, not a fundamental flaw.** Codex's verdict treats
this as "overreach" requiring either a new multi-writer design or an
explicit 1:1 declaration. I agree with the diagnosis but rebut the
framing: a multi-writer design IS overkill for v1, and explicit "1 pgbossier
: 1 pgboss" is a one-paragraph documentation fix, not a design redo. The
v1 ship criterion remains intact. Codex's "BLOCK"-adjacent framing is
correct severity but the remediation is documentation, not redesign.

**To Codex — `DATABASE_URL` fallback should be removed entirely.** Codex
implies the `DATABASE_URL` fallback is unsafe enough to remove. I rebut
this: the fallback works correctly for descent-app (the v1 primary
consumer; their `DATABASE_URL` *is* the database pg-bossier installs into).
The risk Codex flags is real for *multi-database* deployments — but those
are not v1's primary topology. The right answer is what Codex *also*
proposed: print the resolved destination before any SQL runs. Belt and
braces. Keep the fallback, print the destination. Don't remove the
convenience.

## Escalations

**The "what topology does pg-bossier support" question is now load-bearing
and undocumented.** Reading Codex's vector 2 against the spec, I see we
need an explicit **supported-topology section** in the spec, not just an
implicit "schema configurable" feature. The section needs to enumerate:

- 1 pgbossier schema : 1 pgboss schema (default; primary supported)
- N pgbossier schemas : N distinct pgboss schemas (supported with caveats)
- 2 pgbossier schemas : 1 pgboss schema (**unsupported** — duplicate captures)
- 1 pgbossier schema : N pgboss schemas (**unsupported** — only one source can be triggered)

This needs to be its own section before the API surface. Each supported
configuration says what works, and the unsupported ones say what breaks.

**`assertSchemaName` needs a block list, not just a regex.** Three of us
landed on this independently. The block list:

```ts
const RESERVED = new Set([
  'public',             // user data lives here; uninstall would be catastrophic
  'information_schema', // SQL standard system catalog
  // any pg_-prefixed name is rejected via prefix check, not list
]);

function assertSchemaName(name: string, key: keyof SchemaNames): void {
  if (!IDENT_RE.test(name)) throw new Error(...);
  if (name.startsWith('pg_')) throw new Error(`'pg_' prefix is reserved by Postgres`);
  if (RESERVED.has(name)) throw new Error(`'${name}' is reserved; choose a different schema name`);
  if (Buffer.byteLength(name, 'utf8') > 63) throw new Error(`schema name exceeds NAMEDATALEN (63 bytes)`);
}
```

Three additional checks beyond the regex; ~6 lines of code; prevents one
catastrophic and two annoying failure modes.

**Preflight check + transaction wrapper together = clean install
contract.** Combining Codex's preflight catch with the transaction
wrapper: `install()` becomes "either it succeeds completely or nothing
changed." This is a real correctness improvement worth the ~10 extra
lines:

```ts
export async function install(pool: Pool, options?: InstallOptions): Promise<void> {
  const s = resolveSchemas({ ... });
  const client = await pool.connect();
  try {
    // Preflight: confirm the source table exists.
    await client.query(`SELECT 1 FROM ${s.pgboss}.job LIMIT 0`);
    await client.query('BEGIN');
    // ... all install SQL ...
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

## Final position

**SHIP WITH NAMED CHANGES.**

Severity ranking has changed since Round 1: Sonnet's `public`-as-uninstall-target catch elevates the schema-validation work from "polish" to "data-loss blocker."

### Must land before merge (revised, in severity order)

1. **CHANGE: Block `public`, `information_schema`, `pg_*`-prefixed, and over-63-byte names** in `assertSchemaName`. Sonnet's `schema: 'public'` → `DROP SCHEMA public CASCADE` is data-loss-level; this is the single highest-priority fix in the entire review.
2. **CHANGE: Parameterize trigger name to `${s.pgbossier}_capture`** in `captureTriggerSql`. Without this, two installs collide silently.
3. **CHANGE: Add an explicit "Supported topologies" section** to the spec that names the four configurations (1:1, N:N-distinct, 2:1 unsupported, 1:N unsupported). Documents Codex's correctness concern as an honest scope statement instead of an implicit overreach.
4. **CHANGE: Wrap `install()` in a transaction + preflight check for `${pgbossSchema}.job` existence.** Combined: failure-free install or no-state-change-on-failure.
5. **CHANGE: Fix the CLI control flow.** `strict: true` in `parseArgs`; capture exit code in a variable; `pool.end()` in `finally`; `process.exit(code)` after `finally` returns. Three discrete bugs in the spec sketch.
6. **CHANGE: CLI prints destination connection info** (`host:port/database, schema=…, pgbossSchema=…`) before any SQL runs. Mitigates `DATABASE_URL` footgun without removing the convenience.
7. **CHANGE: Quote schema identifiers in generated SQL** (`"${s.pgbossier}"` not `${s.pgbossier}`). Defense in depth against any future regex-bypass and handles consumer-chosen lowercase-keyword names correctly.
8. **CHANGE: Correct the "all three install paths exercise `prepare`" claim.** Only git installs run `prepare` on consumer install; tarball consumers get the built `dist/` directly. Spec line 525 is wrong.
9. **CHANGE: Update README's Prisma coexistence section** to explicitly document `multiSchema`-related risks and the `db pull` introspection behavior. Not a paragraph — a ⚠️ callout box that names the destructive failure mode.
10. **CHANGE: Make commit-SHA the primary git-install example, not branch.** Branch refs in `package-lock.json` are non-reproducible across `npm ci`.

### Nice to land in v1 (doesn't block)

- **CHANGE: Add `connectionTimeoutMillis: 10_000` to the CLI's `new Pool(...)`** call so bad credentials fail in seconds, not minutes.
- **CHANGE: Bump `engines` to `>=18.3.0`** so `util.parseArgs` is unambiguously available.
- **CHANGE: Add CI step that exercises git+tarball install paths** via `npm install` in a fresh tempdir.
- **CHANGE: Document `--ignore-scripts` risk** for git-URL installs (consumers running with `--ignore-scripts` get an un-built package).
- **CHANGE: Test coverage adds `assertSchemaName('public')` rejection** and trigger-name collision regression tests.

### What I'm not asking for

- **Multi-writer design.** Codex implied this could be the path. It's overkill for v1; declaring 1:1 topology is the right scope. Defer multi-writer to a separate goal if a real consumer needs it.
- **Removing `DATABASE_URL` fallback.** Print destination instead; keep the convenience.
- **Numbered migration files.** Same as Round 1; the policy stands.

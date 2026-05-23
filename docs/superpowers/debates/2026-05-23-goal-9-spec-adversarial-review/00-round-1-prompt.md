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

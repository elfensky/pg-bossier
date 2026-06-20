# Adversarial review — synthesis

**Spec under review:** [`docs/superpowers/specs/2026-05-23-goal-9-install-distribution-shape-design.md`](../specs/2026-05-23-goal-9-install-distribution-shape-design.md)
**Participants:** Codex CLI (GPT-5), Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet 4.6 via Agent), Opus (Claude Opus 4.7, this session)
**Rounds:** 2 (attack + rebuttal)

## Headline

Sharp convergence. Two camps emerged on framing (Codex + Gemini at
**BLOCK UNTIL**; Sonnet + Opus at **SHIP WITH NAMED CHANGES**) but
**materially they agree on the same change list**. The semantic split is
whether to call the required fixes "blocks" or "named changes" — the
underlying delta is identical.

**Three findings came out of TDD-style adversarial pressure that the spec
did not see**:

1. **`schema: 'public'` is a one-command catastrophic data-loss bug.** Sonnet caught (R1 vector 1, tested directly): the regex `^[a-z_][a-z0-9_]*$` accepts `public`, then `uninstall(pool, { schema: 'public' })` produces `DROP SCHEMA IF EXISTS public CASCADE` — destroying every user table in the public schema. All four participants concede this is the highest-severity gap in the entire spec.
2. **Trigger name collision silently breaks the first install.** Codex/Gemini/Opus/Sonnet all caught this independently. The spec describes `captureTriggerSql` as a "factory" but leaves the trigger NAME implicit. Without parameterizing the name to `${s.pgbossier}_capture`, two pg-bossier installs collide and install B's `DROP TRIGGER IF EXISTS pgbossier_capture` clobbers install A's trigger. Audit-row capture for install A silently stops.
3. **The spec's multi-instance claim is overreach.** Codex (R1 vector 2): two installs sharing one `pgboss` schema would BOTH fire on every pg-boss op — duplication, not isolation. The honest scope is "1 pgbossier schema : 1 pgboss schema" or "N pgbossier schemas : N *distinct* pgboss schemas," not unrestricted multi-instance.

## Must-land changes (universal or near-universal)

In rough severity order. Every one of these is on at least 3/4 must-land lists; the first three are on all four.

1. **Block destructive/reserved schema names in `assertSchemaName`.** Reject `public`, `information_schema`, any `pg_`-prefixed name, and identifiers > 63 bytes. Sonnet's `public` catch makes this a data-loss blocker, not polish. (4/4)
2. **Parameterize the trigger name to `${s.pgbossier}_capture`** in `captureTriggerSql`. Without this, multi-install silently breaks. (4/4)
3. **Change CLI `parseArgs` to `strict: true`** so flag typos throw clearly instead of falling through to env-var resolution. `allowPositionals: true` is compatible. (4/4)
4. **Correct the "all three install paths exercise `prepare`" claim** in the spec (line 525). Git installs run `prepare`; tarball consumers receive the pre-built `dist/` without re-running anything. (3/4: Codex/Sonnet/Opus)
5. **Strengthen Prisma multiSchema documentation** to a ⚠️ callout. `prisma db pull` with multiSchema introspects all schemas including pgbossier; consumers MUST exclude pgbossier from `datasource.schemas` to avoid destructive drift. The spec's current "Prisma only manages declared schemas" is too absolute. (4/4)
6. **Wrap `install()` in a transaction.** Failure leaves nothing behind instead of partial state. Codex backed down in R2 ("nice-to-have"), Opus/Gemini/Sonnet pushed harder. Net: must-land per 3/4. (3/4)
7. **Fix the CLI control-flow bug.** `process.exit()` is synchronous and immediate; the `finally { await pool.end() }` block in the spec's sketch never runs. Replace with: capture exit code in a variable, `pool.end()` in `finally`, `process.exit(code)` after. (3/4: Codex/Opus, Sonnet noted)
8. **CLI prints destination connection info** (`host:port database schema=... pgbossSchema=...`) before any SQL runs. Belt-and-braces against `DATABASE_URL` pointing somewhere unexpected. (3/4: Codex/Opus/Sonnet R2 concession)
9. **Add explicit "Supported topologies" section to the spec.** Names the 1:1, N:N-distinct, 2:1-unsupported, 1:N-unsupported cases. Codex's R1 critique made this the headline framing issue. (2/4 strong: Codex/Opus; 4/4 imply it)
10. **Branch ref → commit SHA as primary git-install example.** Sonnet tested: branch refs in `package-lock.json` re-resolve to the current branch head on every `npm ci`, not the SHA at first install. Non-reproducible. (2/4: Sonnet/Opus R2 concession)
11. **Preflight check for `${pgbossSchema}.job` existence** before any mutation. Combined with the transaction wrapper, gives a clean "either everything or nothing" contract. (2/4: Codex/Opus R2 concession)

## Should land in v1 (broad agreement)

- **CHANGE: Bump `engines` to `>=18.3.0`** so `util.parseArgs` is unambiguously available. (3/4)
- **CHANGE: Connection timeout in CLI** (`connectionTimeoutMillis: 10_000`) so bad credentials fail in seconds. (2/4: Sonnet/Opus)
- **CHANGE: `git add -A` in publish runbook → `git add -u`** or "require clean checkout." `-A` stages untracked files. (2/4: Sonnet/Codex)
- **CHANGE: CI exercises git+tarball install paths** via `npm install` in a fresh tempdir. (3/4: Codex/Gemini/Sonnet)
- **CHANGE: `--ignore-scripts` risk documented** in COMPATIBILITY. (1/4 plus consensus framing: Sonnet)
- **CHANGE: Test coverage adds `assertSchemaName('public')` rejection** + trigger-name collision regression. (3/4: Sonnet/Codex/Opus)

## Disagreement worth surfacing — quoting vs narrow validation

Opus (R1+R2) argued for **quoting schema identifiers in generated SQL** (`"${s.pgbossier}"`) as defense-in-depth. Codex (R2) rebutted: "Broad quoting would make names like `"user"` installable, which does not solve the real safety issue and can make dangerous names look supported. The correct move is narrower validation."

Codex's argument is the cleaner default for v1 — narrower validation + reject reserved names is simpler than quote-everything. Sonnet conceded the missed reserved-keyword case in R2 but agreed with quoting only as an alternative to a keyword list. **Recommendation: take Codex's path** — block `public`, `pg_*`, `information_schema`, length > 63, AND any reserved-keyword name (use Postgres' own keyword list from `pg_get_keywords()` or a static list). Skip the broad-quoting change unless a real consumer surfaces a name we'd want to allow.

## Verdict split — Codex/Gemini BLOCK vs Opus/Sonnet SHIP-WITH-CHANGES

- **Codex, Gemini: BLOCK UNTIL.** Both treat the schema validation gap (especially `public`) and the trigger collision as design-level fixes that must land before any implementation.
- **Sonnet, Opus: SHIP WITH NAMED CHANGES.** Both agree the same fixes must land but characterize the design *itself* as sound — the gaps are focused additions, not a redesign.

The disagreement is semantic. The actionable consensus is identical: **none of the four are willing to implement the spec as written**, and all four agree on roughly the same 8-11 changes that must land first.

## Rejected (with reasoning)

- **Codex's "redesign multi-writer model."** Codex implied a real multi-writer design could be the fix. Opus rebutted: a 1:1 topology declaration is a one-paragraph documentation fix, not a redesign. Multi-writer is overkill for v1 — defer until a real consumer surfaces the need.
- **Codex's "remove `DATABASE_URL` fallback entirely."** Opus rebutted: print destination instead. Gemini concurred: removing the fallback breaks the "1-hour adoption" promise for descent-app. Keep the fallback + print.
- **Opus's "quote all identifiers in SQL."** Codex rebutted: narrow validation is the cleaner answer; broad quoting makes dangerous names look supported. Synthesis: skip the broad-quote change.
- **Gemini's "git read-tree is violently destructive."** Both Sonnet and Opus rebutted: `main` is designed to have no history to lose per CLAUDE.md's "unrelated histories" model. The destructive snapshot IS the intended behavior.
- **Codex/Gemini's "NOTIFY ghost listeners after uninstall."** Sonnet rebutted: NOTIFY channels are not persistent objects. `LISTEN` is connection-scoped; `pool.end()` closes the connection and all its listeners. No leak.

## Recommended path forward

1. **Revise the spec** to incorporate the 11 must-land items above. Most are documentation; the design-level changes are (a) the trigger-name parameterization, (b) the assertSchemaName block list, (c) the install() transaction wrapper, (d) the CLI control-flow fix, (e) the "Supported topologies" section, (f) the Prisma callout. Total impact: ~30 lines of spec + ~50 lines of implementation beyond the original v1 plan.
2. **Re-run a light verification check** on the revised spec (single round, ~5 min) to confirm no residual gaps.
3. **Move to writing-plans** to draft the implementation plan against the revised spec.

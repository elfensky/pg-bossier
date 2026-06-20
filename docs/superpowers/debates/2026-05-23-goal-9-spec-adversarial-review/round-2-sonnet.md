# Sonnet critique — Round 2

---

## Concessions

**Opus on transaction wrapping (Vector 7).** I under-weighted this in Round 1. I called a transaction wrapper something that "would simplify the failure story" and said the idempotency-based recovery was "acceptable" under KISS. Opus's framing is sharper: "failure leaves nothing behind" is categorically better than "failure is recoverable with a second command the consumer may not know to run." The two-line change (`pool.connect()` + `BEGIN/COMMIT/ROLLBACK`) eliminates an entire failure mode. I concede this belongs in the must-land list, not the nice-to-have list.

**Opus on quoted identifiers (Vector 1).** I flagged `pg_` and `public` as the main risks in `assertSchemaName` but did not flag the reserved-keyword bare-interpolation problem. Opus's example is clean: `CREATE SCHEMA IF NOT EXISTS user;` is a syntax error on any Postgres version. The fix — quoting all identifiers in the generated SQL (`"${s.pgbossier}"`) — is simpler than a keyword blocklist and covers every case uniformly. I missed this gap. Conceded.

**Opus on `engines` floor (Vector 4).** I noted `strict: true` in `parseArgs` as the right fix. Opus added the correct companion: `util.parseArgs` shipped as stable in Node 18.3.0, not 18.0.0. `"engines": { "node": ">=18" }` is technically off-spec for the tool we're using. Bumping to `>=18.3.0` is a one-character change and eliminates the ambiguity. Conceded.

**Codex/Gemini on the destination-print safety net (Vector 4).** I correctly characterized the `DATABASE_URL` risk as low for descent-app specifically, and I stand by that assessment for the v1 consumer. But Codex and Opus both independently arrived at the same mitigation: print `host:port/database schema=...` before any SQL runs. This costs one line and turns a potential footgun into a visible, Ctrl-C-able moment. I should have proposed it rather than merely noting the risk as acceptable. Conceded.

---

## Rebuttals

**Gemini (Round 2) on BLOCK UNTIL X — the transaction is not a blocker.** Gemini escalated to `BLOCK UNTIL X` based on the transaction argument, citing it as a "Total Failure" bug. This is overstated. The partial-install state left by a mid-install failure (schema, table, function exist; trigger does not) is correctly diagnosed and recoverable: `install()` is fully idempotent, so re-running with the correct parameters succeeds. No data is lost. No user-facing corruption occurs. The trigger-name collision and reserved-keyword syntax error are genuine correctness bugs that can silently destroy audit integrity — those deserve blocker status. A missing transaction wrapper leaves a minor nuisance state with a documented recovery path. Classifying it identically conflates severity levels. The transaction is a real improvement and should land, but it is not a blocker.

**Codex on "violently destructive" `git read-tree` (Vector 6).** Codex called the publish runbook "violently destructive to any history on main." This is wrong in context. The CLAUDE.md explicitly documents `main` as a "release ledger" with one commit per release and unrelated histories by design. `git read-tree -u --reset develop` is the correct mechanical realization of this design. There is no history on `main` to lose — that is the invariant. The concern about `git bisect` across releases is real, but it is a known tradeoff in the chosen release strategy, not a bug in the runbook. Codex also flagged `git add -A` as a risk (untracked files being committed), which I raised in my own Round 1 and is a genuine minor hygiene point — but it does not change the fundamental soundness of `read-tree` for this use case.

**Codex/Gemini on "ghost listeners" from NOTIFY (Vector 8).** Both critiques flagged NOTIFY channels as a potential leak after `uninstall()`. As I showed in Round 1, this rests on a misconception: NOTIFY channels are not persistent database objects, they are transient names. There is nothing to drop. An active `LISTEN` connection after uninstall simply receives no further notifications — no error, no resource leak, no "ghost." The CLI's `finally { await pool.end(); }` handles the CLI's own connections. This is a non-issue.

**Codex on "reserved keywords" blocking lower-case names.** Codex raised that the regex rejects `Schema: 'MyAudit'` (mixed case). This is correct behavior, not a gap. The spec explicitly says the regex is lowercase-only to match Postgres unquoted-identifier case-folding behavior. A consumer who wants `myaudit` passes `myaudit`; Postgres creates `myaudit`. Forcing lowercase in validation is a feature: it prevents the consumer from passing `MyAudit` expecting a schema named `MyAudit` but getting `myaudit`. This is not a usability regression — it is a correctness invariant.

---

## Escalations

**The trigger-name ambiguity is not just a spec bug — it is an implementation trap.** Every other Round 1 critique (Opus, Codex, Gemini) independently identified the trigger-name collision. But what strikes me on re-reading all four critiques is that the spec's factory-function description specifically says "same factory shape" for `captureTriggerSql` without ever showing the function body. An implementer reading only the spec would write `DROP TRIGGER IF EXISTS pgbossier_capture` because that is what is in the current `src/sql.ts` — the hardcoded constant they are converting. The spec's "same factory shape" comment does not override the muscle memory of the existing constant. The fix is not just to add a note somewhere — the spec must show the trigger name as `${s.pgbossier}_capture` explicitly in the SQL example. Otherwise the risk of a "correct spec, wrong implementation" is high.

**The `public` schema risk from `assertSchemaName` is the highest concrete data-loss vector in the spec and no other critique named it as sharply.** Codex flagged `pg_catalog` and `information_schema`. Opus flagged `pg_` prefix and reserved keywords. None of them named `public` explicitly as the worst case. `public` passes the regex. `public` is the default schema in most Postgres installs. If a consumer accidentally passes `schema: 'public'` to `uninstall()`, the spec produces `DROP SCHEMA IF EXISTS public CASCADE` — which drops every user table in the public schema. Postgres will execute this without further confirmation. This is a single-command path to database destruction. It is qualitatively worse than any other validation gap in the spec. I named it in Round 1; I escalate it here as the single highest-priority addition to `assertSchemaName`.

**The "two installs, same pgboss schema" behavior is undocumented — and the trigger-name fix makes it a supported topology.** My Round 1 noted that two installs sharing a `pgboss` schema will both fire triggers on every `pgboss.job` change, writing to separate audit tables. Opus correctly calls this a correctness concern. But consider the implication of fixing the trigger name: once `${s.pgbossier}_capture` is the trigger name, both triggers DO exist simultaneously and DO fire independently, each writing to its own schema's `record` table. This is actually a valid and useful topology — one pg-bossier install per team or environment, all watching the same pg-boss queue. The spec's "what this design ships" section does not name this topology at all. If the trigger fix lands without documentation, consumers will have the capability without knowing it. If it does not land, the spec's multi-instance claim is false. The spec needs one sentence explicitly stating: "Two pg-bossier installs in different schemas watching the same pg-boss schema are supported; each fires independently and writes to its own `record` table."

---

## Final position

**SHIP WITH NAMED CHANGES**

### Must land before merge (blockers)

1. **Block `pg_` prefix and `public` (and `information_schema`) in `assertSchemaName`.** `public` is a one-command data-loss path via `uninstall()`. `pg_` prefix names Postgres rejects at the DDL layer. Both require one conditional in `assertSchemaName`. This is the highest-severity gap in the spec.

2. **Scope the trigger name to `${s.pgbossier}_capture` in `captureTriggerSql`.** The spec must show this explicitly in the SQL example, not just note "same factory shape." Without this, multi-instance support silently fails: install B clobbers install A's trigger, install A stops auditing, no error is raised.

3. **Quote schema identifiers in generated SQL.** `CREATE SCHEMA IF NOT EXISTS "${s.pgbossier}"` not `CREATE SCHEMA IF NOT EXISTS ${s.pgbossier}`. Reserved keyword names (`user`, `table`, `index`) cause syntax errors without quoting. The regex does not and cannot block all reserved keywords; quoting is the complete fix.

4. **Change `strict: false` to `strict: true` in `parseArgs`.** Typos in flag names silently fall through to env var fallbacks; the user sees an unhelpful "no connection string" error rather than "unknown flag." This is a one-word change with no downside.

5. **Add `name.length <= 63` check to `assertSchemaName`.** Names longer than 63 characters are silently truncated by Postgres, violating the "invalid names rejected with a clear Error" guarantee. One more conditional in the same function.

### Nice-to-have (non-blockers, should land in v1)

- **Wrap `install()` in a transaction** — improves failure semantics from "recoverable partial state" to "fail-clean." Real improvement; not a correctness bug because idempotency covers the recovery path.

- **CLI prints destination info before running SQL** — `host:port/database schema=... pgbossSchema=...` on one line before install/uninstall executes. Safety net for `DATABASE_URL` misconfiguration. One line in the bin script.

- **Document the two-installs-one-pgboss topology** — a single sentence in the spec and README confirming this is supported after the trigger-name fix lands.

- **Bump `engines` to `>=18.3.0`** — `util.parseArgs` is stable since 18.3; the current `>=18` floor is technically below the tool's stable availability.

- **Make the SHA form primary in the git-URL example** — `#68fd7bb` before the branch-ref form `#develop` in the first-publish runbook; reproducibility matters for validation.

- **Prisma `multiSchema` warning in the documentation section** — the risks table mentions it; the actual README section must also, with explicit "add `pgbossier` to excluded schemas" wording.

# Adversarial review — Round 1

You are participating in a 4-way adversarial review of a software design spec
for pg-bossier — a JS/TS library that layers on top of pg-boss (a Postgres job
queue) to provide an operational data plane.

**Your role: ADVERSARIAL CHALLENGER.** Find real problems. Be technically
concrete. Cite specific sections or quotes from the spec. Surface real risks,
not hypothetical ones.

## Read the spec first

The spec under review is at:

`/Users/andrei/Developer/github/pg-bossier/docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md`

Read the whole file before you write a single critique line.

## Project charter constraints (issue #1, load-bearing — NON-NEGOTIABLE)

- **Audit writes are fail-open** — pg-bossier failures NEVER block pg-boss operations.
- **Per-event overhead has a published budget** (still being decided in #12) — exceeding the budget blocks release.
- **API-shape principle: composition, not replacement.** Read methods are new pg-bossier methods, not overloads of pg-boss methods. Write extensions are explicit per-feature decisions.
- **pg-boss compatibility tiers** — *Stable* (public JS API), *Transitional* (`pgboss.job` table reads), *Forbidden* (pg-boss internals — NEVER depend on).
- **Symmetric uninstall** — `DROP SCHEMA pgbossier CASCADE` must leave zero remnants.
- **Non-goals**: no UI, no REST, no fork of pg-boss, no scheduling, no workflow engine, no queue runtime mutation, no observability platform, no automatic handler introspection, no ORM, no bounded retention tooling.
- **Primary consumer**: descent-app (Prisma-using app with ~45 raw `pgboss.*` queries today).

## Attack vectors — address each in order

1. **LISTEN/NOTIFY transport choice.** Hidden costs at scale (long-poll connection per subscriber, NOTIFY delivery semantics under high write throughput, async commit interactions, replication corner cases like logical replication / hot standby / failover)?

2. **At-most-once contract + gap signal.** Does the proposed reconnect-and-emit-`'error'` path actually let consumers do a CORRECT catch-up read against `pgbossier.record`? Specifically: between the catch-up `SELECT` and the resumed live stream, is there a window where events can be missed OR double-counted? How would a consumer write the catch-up correctly given only `captured_at` (a timestamp with no uniqueness)?

3. **Thin payload + follow-up read pattern.** 1 event = 1 NOTIFY + 1 SELECT. Is that read amplification acceptable at high event rates (say 1000 events/sec across all consumers)? Could a slightly fatter payload (e.g. inline `data` when small, or `terminal_detail` when small) be a better default?

4. **`pg_notify`-inside-trigger placement.** Does it really commit-or-rollback atomically with the audit row INSERT in every PL/pgSQL edge case? Prepared transactions (2PC) — does NOTIFY survive `PREPARE TRANSACTION`? Advisory locks held across the notify? Streaming replication: NOTIFY is not replicated to standbys — what happens after a primary failover? Subtransactions inside the trigger?

5. **Auto-reconnect with fixed 1s delay forever.** Hidden DoS vector against the consumer's own DB during sustained outage? If DB is hard-down for 30 minutes, that's 1800 connection attempts per subscriber. Hard limit needed, jitter, exponential backoff, circuit breaker?

6. **`BossierEvents extends EventEmitter` API shape.** Does the typed-overload pattern survive pino/debug/general listener-counting tooling? Does it work with `getMaxListeners` / `setMaxListeners`? Is `close(): Promise<void>` aligned with idiomatic Node async cleanup (vs `AbortSignal`, vs `Symbol.asyncDispose`)?

7. **State→event mapping in JS, not SQL.** Does carrying both `event` and `state` in the payload create a source-of-truth problem if a future pg-boss version adds a new state value the JS mapping doesn't know? Cite the failure mode the consumer would see.

8. **Issue #1 violations.** Anything in this design that quietly violates a non-goal or a load-bearing constraint? Be specific — name the constraint and the line in the spec.

9. **Test plan false confidence.** Does "kill the backend with `pg_terminate_backend`" actually reproduce the production failure modes a real consumer will hit? What about: TLS handshake failure mid-stream, IDLE-IN-TRANSACTION timeouts, PgBouncer in transaction-mode (which silently breaks LISTEN), replication failover changing the primary, slow consumer with backpressure (notifications queueing in Postgres' async queue, eventual `NOTIFY queue is full`)?

10. **Anything missing from v1 entirely** that the spec doesn't even mention but probably needs.

## Deliverable

A critique addressing each numbered vector. Be concise but technically rigorous. Cite the spec.

End with exactly one of:
- **SHIP AS-IS** — if you find nothing material
- **SHIP WITH NAMED CHANGES** — list each change as `CHANGE: <description>` with a one-line rationale
- **BLOCK UNTIL <X>** — only if you believe a hard blocker exists

Identify yourself by name in your response header (e.g. `# Codex critique — Round 1`).

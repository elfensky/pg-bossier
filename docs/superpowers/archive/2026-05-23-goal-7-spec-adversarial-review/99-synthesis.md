# Adversarial review — synthesis

**Spec under review:** [`docs/superpowers/specs/2026-05-22-goal-7-lifecycle-events-design.md`](../../specs/2026-05-22-goal-7-lifecycle-events-design.md)
**Participants:** Codex CLI (GPT-5), Gemini CLI (Gemini 2.5), Sonnet (Claude Sonnet 4.6 via Agent), Opus (Claude Opus 4.7, this session)
**Rounds:** 2 (attack + rebuttal)

## Headline

The four participants converge on **the same core gaps** in the spec, with
two participants (Codex, Gemini) escalating their verdict to BLOCK and two
(Sonnet, Opus) holding at SHIP-WITH-NAMED-CHANGES. The disagreement is
semantic — every participant names a substantially overlapping list of
changes that must land before merge. The design itself is sound; the gaps
are focused additions, not architectural rework.

Three findings emerged that the original spec did not see at all:

1. **The "durable replay" promise is structurally weaker than the spec claims.** The audit table uses `ON CONFLICT (job_id, attempt) DO UPDATE` — so intermediate state transitions within a single attempt are overwritten. Even with a `seq` cursor column, the audit table can only recover the *final* state per attempt, not the full transition sequence. (Codex round 1 + Sonnet round 2 escalation.)
2. **PgBouncer transaction-mode silently breaks LISTEN.** The spec doesn't mention it. For Prisma-using primary consumer (descent-app), this is the most likely real-world failure mode. (All four participants.)
3. **The audit table has no monotonic cursor.** `captured_at` is non-unique, so any consumer-written catch-up read is either lossy (`>`) or double-counting (`>=`). The spec's catch-up promise is unactionable as written. (All four participants.)

## Must-land changes (unanimous or near-unanimous)

In rough order of severity:

1. **Add a monotonic `seq` column to `pgbossier.record`.** `BIGSERIAL` (or `BIGINT GENERATED ALWAYS AS IDENTITY`). Include in the NOTIFY payload. Without this, the "durable replay" promise is unimplementable correctly. (4/4)
2. **Ship `getEventsSince(seq)` as the canonical catch-up read method.** Pairs with the `seq` column; gives consumers a correct cursor pattern instead of leaving them to write incorrect SQL. (4/4)
3. **Honestly scope "durable replay" to final state per attempt.** Either change the audit table to append-only (one row per transition — schema change to a shipped table) or document explicitly that catch-up recovers final-state-per-attempt, not full transition sequence. Path B (documentation) is the v1 answer; Path A is the architecturally correct long-term answer. (4/4 raised; 2/4 explicitly named the choice)
4. **Document PgBouncer transaction-mode incompatibility prominently.** README + `COMPATIBILITY.md`. The most common silent-failure mode for the primary consumer. (4/4)
5. **Replace fixed 1s reconnect with exponential backoff + jitter.** 1s → 2s → 4s → 8s → 16s → 30s cap, with ±20 % jitter. Trivial implementation, real production hardening across multi-replica deployments. (4/4)
6. **Define explicit unknown-state fallback.** When a future pg-boss minor adds a state, the JS mapping must pass through with `event = state` and emit a one-time signal (proposed: a separate `'warning'` event, distinct from `'error'`). Currently undefined. (4/4)
7. **Change the performance probe from "informational" to a conditional release gate.** The current wording directly contradicts issue #1 ("exceeding the budget blocks release"). One-sentence spec fix. (3/4: Codex, Sonnet, Opus; Gemini implicitly endorsed.)
8. **Document the SQL-side silent-gap class.** If `pg_notify` ever fails inside the trigger's `EXCEPTION WHEN OTHERS`, the savepoint rolls back both the audit row write and the queued NOTIFY — and the JS subscriber receives no `'error'`. Vanishingly rare with a bounded payload, but must be named in the Risks table. (3/4: Codex, Sonnet, Opus)
9. **Add an `'error'` discriminant.** Payload becomes `{ reason: 'gap' | 'parse' | 'handler', error: unknown, at: Date }`. The current single `'error'` event conflates three semantically different situations consumers need to react to differently. (3/4: Codex, Sonnet, Opus)
10. **Type the `'error'` listener as `[unknown]`, not `[Error]`.** Thrown handler values aren't guaranteed to be `Error` instances. Strict type fix. (2/4: Sonnet, Opus)
11. **Document `attempt` semantics per event type with worked examples.** Spec is silent on what `attempt` carries for `created` (answer: 0) vs `retried` (answer: the new retry's `retry_count`). (2/4: Sonnet, Opus)
12. **Specify per-type vs `'job'` event firing order.** One-sentence fix (per-type fires first, then `'job'`); current spec leaves implementation underdetermined. (2/4: Sonnet, Opus)
13. **Lock down the `closed` race in the reconnect loop.** The wait must be cancellable (Promise.race with a close signal); the `closed` check must happen after the wait resolves, before `pool.connect()`. (2/4: Sonnet, Opus)

## Should land in v1 (broad agreement; doesn't strictly block)

- **`'connected'` event** on every successful LISTEN as the silent-failure canary (PgBouncer + failover detection). Two extra lines; makes the most-invisible failure mode detectable. (2/4: Sonnet, Opus)
- **Streaming-replication / failover behavior in COMPATIBILITY.md** — recommend `target_session_attrs=read-write` in the connection string as the primary-discovery mechanism. (3/4: Codex, Sonnet, Opus)
- **`AbortSignal` support** on `subscribe({ signal })` and `Symbol.asyncDispose` on `BossierEvents`. (3/4: Codex, Sonnet, Opus)
- **One sentence on backfill behavior** in `install()` — backfilled rows produce no events because they bypass the `pgboss.job` trigger. (2/4: Sonnet, Opus)
- **Test additions** — `idle_session_timeout`, notification-flood under throughput, TLS-failure variant. (4/4)
- **`MaxListenersExceededWarning` note** for consumers adding many `'job'` listeners; recommend `setMaxListeners(0)` for metrics use cases. (1/4: Sonnet)

## Rejected (with reasoning)

- **Channel-name parameterization for multi-tenancy.** Codex proposed; rebutted by 3/4. pg-boss itself doesn't support multi-instance-per-database; channel collision isn't the real multi-tenancy boundary. YAGNI.
- **Inline `terminal_detail` in the v1 payload.** Codex + Gemini proposed; rebutted by Sonnet + Opus. `terminal_detail`'s shape is the subject of Goal 2 (#3); inlining before that shape is settled couples Goal 7 to a not-yet-existing contract. Defer cleanly to Goal 2's design.
- **Serverless-aware connection management as a design change.** Codex raised; rebutted by Opus. Long-lived LISTEN subscriptions don't fit FaaS deployments by their nature; a README note is sufficient.
- **Sonnet's specific claim that `NOTIFY` is "disallowed" inside `PREPARE TRANSACTION`.** Round-2 rebutted by Opus, conceded by Sonnet. The actual Postgres docs say 2PC + NOTIFY is supported: notifications fire at the COMMIT PREPARED phase. The broader documentation-of-2PC-semantics point stands; the specific failure-mode claim does not.

## Verdict split

- **Codex, Gemini: BLOCK UNTIL.** Both treat the durable-replay promise as a contract-level claim that the current schema cannot fulfill, and treat that as a hard block.
- **Sonnet, Opus: SHIP WITH NAMED CHANGES.** Both agree on the same change list, but characterize the design itself as sound — the gaps are documentation + focused additions, not a fundamental redesign.

The disagreement is semantic. The actionable consensus is identical: **none of the four are willing to merge the spec as written**, and all four agree on roughly the same 8-13 changes that must land first.

## Recommended path forward

1. **Revise the spec** to incorporate items 1-13 from the must-land list. Most are documentation; the schema change (`seq` column) and one new read method (`getEventsSince`) are the only real implementation additions.
2. **Add the should-land items** that are cheap (`'connected'` event, `AbortSignal`, `Symbol.asyncDispose`, backfill sentence, ordering sentence). Total impact: ~20 lines of spec, ~30 lines of implementation beyond the original plan.
3. **Make the durable-replay scope decision explicit** in the spec: v1 ships honest "final-state-per-attempt recovery" semantics. An append-only schema migration (Path A) is a deferred sub-issue, not v1 scope.
4. **Update the test plan** with the failure modes identified in vector 9 across all four critiques.
5. **Re-run a one-round adversarial check** on the revised spec before implementation begins. (Optional but the convergence pattern suggests a short Round 3 would catch any residual gaps.)

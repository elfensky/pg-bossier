# Codex critique — Round 2

## Concessions

I concede Opus's core catch-up critique as stronger than my Round 1 framing:

> "The spec claims 'durable replay is available — by reading the audit table' but does not describe a correct cursor pattern, and no cursor pattern using only the shipped schema is actually correct."

That is the design's hardest blocker. The spec itself admits "`captured_at` is a timestamp with no uniqueness guarantee" while still claiming "durable replay is available by reading the audit table" ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 21-22, 87-93). Those two statements do not coexist cleanly. This is not just an "automatic replay" problem. It breaks the manual replay story too.

I also concede Sonnet's point that the spec understates the compatibility blast radius around proxies:

> "PgBouncer in `transaction` mode ... silently breaks `LISTEN`."

The spec documents reconnects for network loss and restarts, but says nothing about the much nastier case where the connection remains up and `LISTEN` is operationally useless ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 313-329). For a Prisma-using primary consumer, that omission is material.

I concede Sonnet's budget-gating argument:

> "Change the performance probe from 'informational, not a release gate' to a conditional gate tied to issue #12's budget decision."

The spec says the per-event probe is "informational, not a release gate" ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 361-363), but the charter says exceeding the budget blocks release. That is a direct mismatch.

I concede Opus on unknown-state handling:

> "The JS mapping doesn't know it. The spec doesn't say what happens."

The state-to-event mapping is intentionally in JS ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 147-156), but the forward-compat fallback is undefined. That is an avoidable spec gap.

## Rebuttals

I push back on Gemini's claim that the thin payload is a blocker and should be widened now:

> "Including `terminal_detail` when small ... would eliminate 90% of follow-up reads."

That overstates both the certainty and the necessity. The spec explicitly chooses a stable thin envelope because the NOTIFY cap is hard and because Goal 7 is defining transport semantics, not a rich read model ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 49-50, 137-145, 400-404). Opus is right that the read amplification is workload-dependent, not automatic. For many consumers, only `'failed'` paths need follow-up reads. I would keep payload widening out of the must-land list.

I push back on Sonnet's proposed health-check/event-surface expansion as a merge blocker:

> "Add a detectable health-check path (e.g., a `'connected'` event on successful LISTEN)."

Useful, but not required to make v1 sound. The hard requirement is to document unsupported and fragile topologies clearly, especially PgBouncer transaction pooling and standby readers. A `'connected'` event does not solve the deeper guarantee problem; it just offers a nicer signal. That is a follow-up, not a blocker.

I also push back on Sonnet's subtransaction claim:

> "if the outer subtransaction rolls back ... the `NOTIFY` is still delivered on main transaction commit even though the job state change was rolled back."

That is overstated. The spec's atomicity claim is about the transaction boundary that ultimately commits or aborts the state change ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 180, 233-235). A queued NOTIFY is tied to transaction commit visibility; a rolled-back savepoint should not leak a durable transition as a committed event. The real issue here is not subtransactions. It is that the spec hand-waves edge-case transactional semantics while publishing a very strong "they commit or roll back together" claim.

I push back on Gemini's channel-parameterization ask:

> "Parameterize the channel name."

The spec's single fixed `pgbossier_job` channel is a deliberate namespaced ownership choice, and channel collisions are not the real multi-tenant boundary in Postgres deployments ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 100-109, 380, 392). If multiple environments are sharing one database without isolation, channel naming is not the first problem to solve. This is optional, not must-land.

## Escalations

Opus's catch-up argument opens a broader attack line: the spec is currently misrepresenting the read API surface. Goal 5 exposes `findById`, `getRetryHistory`, `listJobs`, `latestPerQueue`, `countByState`, `countByQueue`, and `listLongRunning` ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 32-33). None of those is a tail/read-from-cursor primitive. So even if a consumer were willing to hand-roll replay SQL, the published pg-bossier API still does not compose into the recovery flow the spec advertises. This is not just a schema problem. It is also an API-shape problem.

Sonnet's compatibility critique opens a second, sharper attack line: the reconnect design is specified only for explicit connection failure, but the transport's most dangerous production failures are non-failing states. PgBouncer transaction pooling, standby connections, and endpoint failover to a readable-but-wrong target all produce "connected but no usable stream" conditions. The current failure matrix only covers cases where the client emits `'error'` or `'end'` ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 315-324). That means the advertised one-`'error'`-per-gap contract is narrower than the prose suggests.

There is a third blocker that becomes clearer after reading Sonnet and Opus together: the spec's `'error'` channel is underspecified relative to its own semantics. The type says `error: [Error]`, but the behavior table says handler throws are rerouted there, which may be non-`Error` values ([spec](../../specs/2026-05-22-goal-7-lifecycle-events-design.md), lines 270-279, 322-323, 337-339). More importantly, the same event name is carrying transport-gap, parse-failure, and consumer-handler faults. That makes operational handling ambiguous exactly where the spec most wants consumers to recover correctly.

## Final position

**BLOCK UNTIL monotonic replay and topology constraints are made explicit.**

Must-land-before-merge:

- Add a monotonic sequence to `pgbossier.record`, include it in the NOTIFY payload, and define a canonical replay API/cursor pattern. Without this, "durable replay is available" is false in practice.
- Replace the current replay claim with an actually supported API surface. If replay is part of the contract, ship `getEventsSince(seq)` or equivalent; do not push raw SQL cursor design onto consumers while advertising composition.
- Document unsupported and fragile transport topologies prominently: PgBouncer transaction mode, standby/read-replica listeners, and failover requirements for reconnecting to a writable primary.
- Define unknown-state behavior explicitly. Do not leave `event` undefined for future pg-boss states.
- Make the performance budget a release gate in the spec, not an informational probe, to match the charter.

Nice-to-have:

- Exponential backoff with jitter for reconnects.
- Better error taxonomy than a single overloaded `'error'` event.
- `AbortSignal` and `Symbol.asyncDispose`.
- Clarify `attempt` semantics with examples.
- Document event ordering between per-type listeners and `'job'`.
